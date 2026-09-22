// Deterministic 60-second simulation using the production perception/request schedulers.
const { VisualPerceptionController, MultimodalWorldModel } = require('../../src/vision')
const { OllamaRequestScheduler } = require('../../src/ollama')

async function simulate() {
  let now = 0
  let latest = null
  const timers = []
  const scheduler = new OllamaRequestScheduler()
  const priorityLatencies = []
  const client = {
    observe: (frame, { kind }) => scheduler.schedule(kind, ({ signal }) => new Promise((resolve, reject) => {
      const timer = { at: now + 5000, run: () => resolve({ sceneType: 'OPEN_TERRAIN', summary: 'simulated' }), cancelled: false }
      timers.push(timer)
      signal.addEventListener('abort', () => { timer.cancelled = true; reject(signal.reason) }, { once: true })
    }))
  }
  const controller = new VisualPerceptionController({
    frameStore: { getLatest: () => latest }, client,
    worldModel: new MultimodalWorldModel({ now: () => now }),
    logger: { info() {}, error() {}, throttled() {} }, now: () => now,
    config: { enabled: true, backgroundIntervalMs: 45000, backgroundCooldownMs: 30000,
      eventMinGapMs: 15000, changeThreshold: 0.2, frameMaxAgeMs: 15000 }
  })
  const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }
  let maxPending = 0
  let maxBackgroundQueued = 0
  let oldStarted = 0
  let oldDiscarded = 0
  let oldFinishesAt = null
  for (now = 0; now <= 60000; now += 100) {
    latest = { id: String(now), capturedAt: now, perspective: 'HUMAN_CLIENT_CAMERA', uiState: 'GAMEPLAY', dimension: 'world', signature: (Math.floor(now / 10000) % 2 ? 'ff' : '00').repeat(144) }
    // Original rule discarded every completed frame once a newer ID arrived.
    if (oldFinishesAt !== null && now >= oldFinishesAt) { oldDiscarded++; oldFinishesAt = null }
    if (oldFinishesAt === null) { oldStarted++; oldFinishesAt = now + 5000 }
    controller.onFrame(latest)
    if (now % 1000 === 0) void controller.request({ priority: 'BACKGROUND', trigger: 'INTERVAL' })
    const kind = ({ 2000: 'PLAYER_CONVERSATION', 20000: 'PLAYER_TASK_DECISION', 40000: 'LEARNING_REFLECTION' })[now]
    if (kind) {
      const queuedAt = now
      void scheduler.schedule(kind, () => {
        priorityLatencies.push({ kind, waitMs: now - queuedAt })
        return new Promise(resolve => timers.push({ at: now + 300, run: resolve }))
      })
    }
    for (const timer of timers) {
      if (!timer.cancelled && timer.at <= now) { timer.cancelled = true; timer.run() }
    }
    await flush()
    maxPending = Math.max(maxPending, controller.snapshot().pendingFrames)
    maxBackgroundQueued = Math.max(maxBackgroundQueued, scheduler.snapshot().queued.filter(job => job.kind === 'BACKGROUND_VISUAL_PERCEPTION').length)
  }
  return { simulatedSeconds: 60, frameIntervalMs: 100, inferenceMs: 5000,
    before: { started: oldStarted, accepted: 0, discarded: oldDiscarded },
    after: controller.snapshot(), maxPending, maxBackgroundQueued, priorityLatencies }
}

if (require.main === module) simulate().then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error); process.exitCode = 1 })
module.exports = { simulate }
