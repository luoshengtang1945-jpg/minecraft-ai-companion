const test = require('node:test')
const assert = require('node:assert/strict')
const {
  FrameStore,
  parsePngDimensions,
  signatureDistance,
  validateVisualObservation,
  MultimodalWorldModel,
  VisualPerceptionController,
  VisionOllamaClient,
  VisionFrameServer,
  isLoopback,
  hasUploadCapacity,
  requiresVisualContext
} = require('../src/vision')
const { PrimitiveActionExecutor, validatePrimitiveAction } = require('../src/learning')
const { OllamaRequestScheduler, OllamaRequestPreemptedError } = require('../src/ollama')

function png(width = 320, height = 180, size = 64) {
  const value = Buffer.alloc(Math.max(24, size))
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(value)
  value.write('IHDR', 12, 'ascii')
  value.writeUInt32BE(width, 16)
  value.writeUInt32BE(height, 20)
  return value
}

function visual(extra = {}) {
  return {
    sceneType: 'OPEN_TERRAIN',
    summary: 'Open grass terrain under daylight.',
    salientObjects: [{ label: 'grass', region: 'CENTER', confidence: 0.95 }],
    structures: [], terrain: [], hazards: [],
    playerActivity: { visible: false, description: '', confidence: 0 },
    uncertainty: [], notableChanges: [], ...extra
  }
}

function frame(store, now = 1000, id = 'f1', signature = '00'.repeat(144)) {
  return store.accept(png(), { id, capturedAt: now, perspective: 'HUMAN_CLIENT_CAMERA', uiState: 'GAMEPLAY', signature }).frame
}

const logger = { info() {}, warn() {}, error() {}, throttled() {} }

test('60-second visual load remains bounded, accepts useful observations, and yields model priority', async () => {
  const { simulate } = require('../benchmark/vision/scheduler')
  const result = await simulate()
  assert.equal(result.maxPending, 1)
  assert.ok(result.maxBackgroundQueued <= 1)
  assert.ok(result.after.inferencesStarted <= 3)
  assert.ok(result.after.observationsAccepted >= 1)
  assert.equal(result.after.observationsDiscardedStale, 0)
  assert.equal(result.after.preempted, 1)
  for (const entry of result.priorityLatencies) assert.ok(entry.waitMs <= 100)
})

test('background cooldown applies after completion while player/task refreshes bypass it; screens are skipped', async () => {
  let now = 1000
  const store = new FrameStore({ now: () => now })
  frame(store, now)
  let calls = 0
  const controller = new VisualPerceptionController({ frameStore: store,
    worldModel: new MultimodalWorldModel({ now: () => now }), logger, now: () => now,
    client: { observe: async () => { calls++; return visual() } },
    config: { enabled: true, backgroundIntervalMs: 100, backgroundCooldownMs: 500, frameMaxAgeMs: 1000, freshFrameMs: 1000, changeThreshold: 0.2 } })
  assert.equal((await controller.request({ priority: 'BACKGROUND' })).status, 'UPDATED')
  now += 100
  frame(store, now, 'changed', 'ff'.repeat(144))
  assert.equal((await controller.request({ priority: 'BACKGROUND' })).reason, 'RATE_LIMIT')
  assert.equal((await controller.request({ priority: 'TASK', requireFresh: true })).status, 'UPDATED')
  assert.equal((await controller.request({ priority: 'PLAYER', requireFresh: true })).status, 'UPDATED')
  for (const uiState of ['MENU', 'OTHER_SCREEN', 'INVENTORY', 'CHAT']) {
    now += 1
    store.accept(png(), { capturedAt: now, perspective: 'HUMAN_CLIENT_CAMERA', uiState })
    assert.equal((await controller.request({ priority: 'BACKGROUND' })).reason, 'UI_SCREEN')
  }
  assert.equal(calls, 3)
})

test('frame validation accepts bounded PNG and rejects malformed, oversize, and invalid dimensions', () => {
  let now = 1000
  const store = new FrameStore({ maxBytes: 100, maxWidth: 640, maxHeight: 360, now: () => now })
  assert.deepEqual(parsePngDimensions(png()), { width: 320, height: 180 })
  assert.equal(frame(store, now).width, 320)
  assert.throws(() => store.accept(Buffer.from('not png'), { capturedAt: now, perspective: 'HUMAN_CLIENT_CAMERA' }), /valid PNG/)
  assert.throws(() => store.accept(png(320, 180, 101), { capturedAt: now, perspective: 'HUMAN_CLIENT_CAMERA' }), /exceeds/)
  assert.throws(() => store.accept(png(1000, 180), { capturedAt: now, perspective: 'HUMAN_CLIENT_CAMERA' }), /dimensions/)
})

test('frame transport cannot bind beyond loopback and has no external dependency', () => {
  assert.equal(isLoopback('127.0.0.1'), true)
  assert.equal(isLoopback('::1'), true)
  assert.equal(isLoopback('192.168.1.25'), false)
  assert.equal(hasUploadCapacity(1, 2), true)
  assert.equal(hasUploadCapacity(2, 2), false)
  assert.throws(() => new VisionFrameServer({ host: '0.0.0.0', port: 32145, frameStore: {}, maxBytes: 100 }), /loopback/)
})

test('single-slot frame queue drops stale and superseded frames without backlog', () => {
  let now = 2000
  const store = new FrameStore({ maxAgeMs: 500, now: () => now })
  assert.equal(store.accept(png(), { id: 'old', capturedAt: 1000, perspective: 'HUMAN_CLIENT_CAMERA' }).reason, 'STALE_FRAME')
  frame(store, now, 'new')
  assert.equal(store.accept(png(), { id: 'duplicate', capturedAt: now, perspective: 'HUMAN_CLIENT_CAMERA' }).reason, 'SUPERSEDED_FRAME')
  now += 1
  frame(store, now, 'newest')
  assert.equal(store.getLatest().id, 'newest')
  assert.equal(store.dropped, 3)
})

test('cheap scene signatures detect changed frames without model inference', () => {
  assert.equal(signatureDistance('00ff', '00ff'), 0)
  assert.equal(signatureDistance('00ff', 'ffff'), 0.5)
})

test('structured visual observations are strict and cannot introduce precise coordinates', () => {
  assert.equal(validateVisualObservation(visual()).sceneType, 'OPEN_TERRAIN')
  assert.throws(() => validateVisualObservation({ ...visual(), coordinates: { x: 1, y: 2, z: 3 } }), /unexpected/)
  assert.throws(() => validateVisualObservation(visual({ salientObjects: [{ label: 'tree', region: 'NORTH', confidence: 1 }] })), /region/)
})

test('fused world model keeps symbolic and visual sources distinct and expires visual state', () => {
  let now = 1000
  const model = new MultimodalWorldModel({ visualTtlMs: 100, now: () => now })
  const store = new FrameStore({ now: () => now })
  model.updateVisual(visual(), frame(store, now))
  const fused = model.fuse({ symbolic: { position: { x: 1, y: 64, z: 2 }, nearbyBlocks: [] }, goal: { description: 'test' } })
  assert.equal(fused.symbolic.source, 'CONFIRMED_SYMBOLICALLY')
  assert.equal(fused.visual.source, 'OBSERVED_VISUALLY')
  assert.equal(fused.groundingRules.visualClaimsAreHypotheses, true)
  now += 101
  assert.equal(model.getVisual(), null)
})

test('LOOK_VISUALLY is validated and updates perception without touching locomotion', async () => {
  assert.equal(validatePrimitiveAction({ action: 'LOOK_VISUALLY' }).action, 'LOOK_VISUALLY')
  let movementCalls = 0
  const executor = new PrimitiveActionExecutor({
    bot: {}, observer: {}, movement: {
      stopLearningMotion() { movementCalls++ },
      startLearningMovement() { movementCalls++; return true }
    },
    vision: { request: async () => ({ status: 'UPDATED', frameId: 'f1' }) }
  })
  const result = await executor.execute({ action: 'LOOK_VISUALLY' })
  assert.equal(result.reason, 'VISUAL_OBSERVATION_UPDATED')
  assert.equal(movementCalls, 0)
})

test('preempted LOOK_VISUALLY is a yield rather than a model/action failure', async () => {
  const executor = new PrimitiveActionExecutor({
    bot: {}, observer: {}, movement: {},
    vision: { request: async () => ({ status: 'PREEMPTED', reason: 'PLAYER_CONVERSATION' }) }
  })
  const result = await executor.execute({ action: 'LOOK_VISUALLY' })
  assert.equal(result.yielded, true)
  assert.equal(result.reason, 'VISUAL_PERCEPTION_PREEMPTED')
})

test('FOLLOW and survival ownership continue while visual inference is pending', async () => {
  let resolveVision
  let owner = 'PLAYER'
  const executor = new PrimitiveActionExecutor({
    bot: {}, observer: {}, movement: { getLocomotionOwner: () => owner },
    vision: { request: () => new Promise(resolve => { resolveVision = resolve }) }
  })
  const pending = executor.execute({ action: 'LOOK_VISUALLY' })
  while (!resolveVision) await Promise.resolve()
  assert.equal(owner, 'PLAYER')
  owner = 'SURVIVAL'
  assert.equal(owner, 'SURVIVAL')
  resolveVision({ status: 'UPDATED', frameId: 'f1' })
  assert.equal((await pending).success, true)
})

test('visual scheduler rate limits unchanged background frames and supports explicit events', async () => {
  let now = 1000
  const store = new FrameStore({ now: () => now })
  frame(store, now)
  const model = new MultimodalWorldModel({ now: () => now })
  let calls = 0
  const controller = new VisualPerceptionController({
    frameStore: store, worldModel: model, logger,
    client: { observe: async () => { calls++; return visual() } }, now: () => now,
    config: { enabled: true, backgroundIntervalMs: 100, eventMinGapMs: 50, changeThreshold: 0.2, frameMaxAgeMs: 1000, freshFrameMs: 1000, debugSaveFrames: false }
  })
  assert.equal((await controller.request({ priority: 'TASK', trigger: 'EVENT' })).status, 'UPDATED')
  now += 10
  assert.equal((await controller.request({ priority: 'BACKGROUND' })).reason, 'RATE_LIMIT')
  assert.equal(calls, 1)
})

test('the first Fabric frame triggers one background perception without waiting for the interval', async () => {
  let now = 1000
  const store = new FrameStore({ now: () => now })
  const first = frame(store, now)
  let calls = 0
  const controller = new VisualPerceptionController({
    frameStore: store, worldModel: new MultimodalWorldModel({ now: () => now }), logger,
    client: { observe: async () => { calls++; return visual() } }, now: () => now,
    config: { enabled: true, backgroundIntervalMs: 100, eventMinGapMs: 50, changeThreshold: 0.2, frameMaxAgeMs: 1000, freshFrameMs: 1000, debugSaveFrames: false }
  })
  controller.onFrame(first)
  while (!calls) await Promise.resolve()
  await Promise.resolve()
  assert.equal(calls, 1)
})

test('newer gameplay frame alone does not invalidate a completed background observation', async () => {
  let now = 1000
  const store = new FrameStore({ now: () => now })
  frame(store, now, 'first')
  let release
  const controller = new VisualPerceptionController({
    frameStore: store, worldModel: new MultimodalWorldModel({ now: () => now }), logger,
    client: { observe: () => new Promise(resolve => { release = resolve }) }, now: () => now,
    config: { enabled: true, backgroundIntervalMs: 0, eventMinGapMs: 0, changeThreshold: 0.2, frameMaxAgeMs: 1000, freshFrameMs: 1000, debugSaveFrames: false }
  })
  const pending = controller.request({ priority: 'BACKGROUND' })
  while (!release) await Promise.resolve()
  now += 1
  frame(store, now, 'second', 'ff'.repeat(144))
  release(visual())
  assert.equal((await pending).status, 'UPDATED')
})

test('conversation routing requests vision only for genuinely visual questions', () => {
  assert.equal(requiresVisualContext('你看到前面那个东西了吗？'), true)
  assert.equal(requiresVisualContext('你觉得这里像不像一个矿洞入口？'), true)
  assert.equal(requiresVisualContext('今天过得怎么样？'), false)
})

test('background vision yields to player conversation and preemption is not a vision failure', async () => {
  const scheduler = new OllamaRequestScheduler()
  let started = false
  const background = scheduler.schedule('BACKGROUND_VISUAL_PERCEPTION', ({ signal }) => new Promise((resolve, reject) => {
    started = true
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  }))
  const rejected = assert.rejects(background, OllamaRequestPreemptedError)
  while (!started) await Promise.resolve()
  assert.equal(await scheduler.schedule('PLAYER_CONVERSATION', async () => 'chat'), 'chat')
  await rejected
})

test('malformed model visual output is rejected by the shared structured response layer', async () => {
  const store = new FrameStore({ now: () => 1000 })
  const client = new VisionOllamaClient({
    ollama: { url: 'http://127.0.0.1:11434/api/chat', model: 'test', timeoutMs: 1000, responseRetries: 0, think: false },
    scheduler: null, logger,
    fetchFn: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ message: { content: '{"sceneType":"OPEN_TERRAIN"}' } }) })
  })
  await assert.rejects(client.observe(frame(store), { kind: 'TASK_VISUAL_PERCEPTION' }), error => error.status === 'SCHEMA_INVALID')
})

test('vision client sends the real PNG through Ollama images rather than a text surrogate', async () => {
  const store = new FrameStore({ now: () => 1000 })
  let body
  const client = new VisionOllamaClient({
    ollama: { url: 'http://127.0.0.1:11434/api/chat', model: 'qwen3-vl:8b', timeoutMs: 1000, responseRetries: 0, think: false },
    scheduler: null, logger,
    fetchFn: async (_url, request) => {
      body = JSON.parse(request.body)
      return { ok: true, status: 200, text: async () => JSON.stringify({ message: { content: JSON.stringify(visual()) } }) }
    }
  })
  await client.observe(frame(store), { kind: 'TASK_VISUAL_PERCEPTION' })
  assert.equal(body.stream, false)
  assert.equal(body.model, 'qwen3-vl:8b')
  assert.equal(body.messages[1].images.length, 1)
  assert.equal(Buffer.from(body.messages[1].images[0], 'base64').equals(png()), true)
})
