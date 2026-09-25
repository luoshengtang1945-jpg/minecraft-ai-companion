const fs = require('node:fs/promises')
const path = require('node:path')
const { isOllamaPreempted } = require('../ollama')
const { signatureDistance } = require('./frame-store')
const { guardVisualObservation } = require('./observation-guard')

const REQUEST_KINDS = Object.freeze({
  PLAYER: 'PLAYER_VISUAL_PERCEPTION',
  TASK: 'TASK_VISUAL_PERCEPTION',
  BACKGROUND: 'BACKGROUND_VISUAL_PERCEPTION'
})

class VisualPerceptionController {
  constructor({ frameStore, client, worldModel, logger, config, now = Date.now, setIntervalFn = setInterval, clearIntervalFn = clearInterval }) {
    this.frameStore = frameStore
    this.client = client
    this.worldModel = worldModel
    this.logger = logger
    this.config = config
    this.now = now
    this.setIntervalFn = setIntervalFn
    this.clearIntervalFn = clearIntervalFn
    this.timer = null
    this.lastInferenceAt = -Infinity
    this.backgroundNotBefore = -Infinity
    this.dirty = false
    this.metrics = { framesReceived: 0, framesReplaced: 0, inferencesStarted: 0, observationsAccepted: 0, observationsDiscardedStale: 0, preempted: 0 }
    this.lastSignature = null
    this.inFlight = new Map()
    this.savedFrames = []
  }

  start() {
    if (!this.config.enabled || this.timer) return
    this.timer = this.setIntervalFn(() => {
      void this.request({ priority: 'BACKGROUND', trigger: 'INTERVAL' })
      this.logger?.throttled?.('vision-metrics', 60000, 'info', `[VISION] metrics ${JSON.stringify(this.snapshot())}`)
    }, Math.min(1000, this.config.backgroundIntervalMs))
  }

  stop() {
    if (this.timer) this.clearIntervalFn(this.timer)
    this.timer = null
  }

  onFrame(frame) {
    this.metrics.framesReceived += 1
    if (this.dirty) this.metrics.framesReplaced += 1
    this.dirty = true
    if (!this.config.enabled) return
    if (this.inFlight.size) return
    if (!this.lastSignature && !this.worldModel.getVisual({ allowStale: true })) {
      void this.request({ priority: 'BACKGROUND', trigger: 'INITIAL_FRAME' })
      return
    }
    if (!frame.signature || !this.lastSignature) return
    const changed = signatureDistance(frame.signature, this.lastSignature)
    if (changed >= this.config.changeThreshold && this.now() - this.lastInferenceAt >= this.config.eventMinGapMs) {
      void this.request({ priority: 'BACKGROUND', trigger: 'SCENE_CHANGE' })
    }
  }

  snapshot() {
    return { ...this.metrics,
      framesReceived: this.frameStore.received ?? this.metrics.framesReceived,
      framesDroppedOrReplaced: this.frameStore.dropped ?? this.metrics.framesReplaced,
      pendingFrames: this.dirty ? 1 : 0, visualRequests: this.inFlight.size }
  }

  async request({ priority = 'TASK', trigger = 'EXPLICIT', requireFresh = false } = {}) {
    if (!this.config.enabled) return { status: 'UNAVAILABLE', reason: 'VISION_DISABLED' }
    const kind = REQUEST_KINDS[priority]
    if (!kind) throw new Error(`Unknown visual priority: ${priority}`)
    let frame = this.frameStore.getLatest({ maxAgeMs: requireFresh ? this.config.freshFrameMs : this.config.frameMaxAgeMs })
    if (requireFresh && (!frame || frame.uiState !== 'GAMEPLAY') && this.config.freshFrameWaitMs > 0) {
      this.logger?.info('[VISION] waiting for a fresh gameplay frame')
      frame = await this.frameStore.waitForLatest({
        maxAgeMs: this.config.freshFrameMs,
        timeoutMs: this.config.freshFrameWaitMs,
        gameplayOnly: true
      })
    }
    if (!frame) return { status: 'UNAVAILABLE', reason: 'NO_FRESH_FRAME' }
    if (frame.uiState && frame.uiState !== 'GAMEPLAY') return { status: 'SKIPPED', reason: 'UI_SCREEN' }
    if (priority === 'BACKGROUND') {
      if (this.inFlight.size) return { status: 'SKIPPED', reason: 'IN_FLIGHT' }
      if (this.client.canStartBackground?.() === false) return { status: 'SKIPPED', reason: 'MODEL_BUSY' }
      if (this.now() < this.backgroundNotBefore) return { status: 'SKIPPED', reason: 'RATE_LIMIT' }
      if (trigger === 'INTERVAL' && this.now() - this.lastInferenceAt < this.config.backgroundIntervalMs) return { status: 'SKIPPED', reason: 'INTERVAL_NOT_DUE' }
      if (['INTERVAL', 'SCENE_CHANGE'].includes(trigger) && frame.signature && this.lastSignature && signatureDistance(frame.signature, this.lastSignature) < this.config.changeThreshold) {
        this.logger?.throttled?.('vision-unchanged', 30000, 'info', '[VISION] skipped: scene unchanged')
        return { status: 'SKIPPED', reason: 'SCENE_UNCHANGED' }
      }
    }
    if (this.inFlight.has(kind)) return this.inFlight.get(kind)
    const promise = this.#infer(frame, { kind, trigger, priority }).finally(() => this.inFlight.delete(kind))
    this.inFlight.set(kind, promise)
    return promise
  }

  async #infer(frame, { kind, trigger, priority }) {
    const startedAt = this.now()
    this.metrics.inferencesStarted += 1
    this.dirty = false
    this.logger?.info('[VISION] inference started')
    try {
      const rawObservation = await this.client.observe(frame, { kind, trigger })
      const { observation, rejected } = guardVisualObservation(rawObservation, frame)
      if (rejected) this.logger?.info(`[VISION] rejected scene classification conflicting with ${frame.dimension}`)
      const latest = this.frameStore.getLatest()
      const newerAccepted = this.worldModel.getVisual({ allowStale: true })?.frame.capturedAt > frame.capturedAt
      if (newerAccepted || this.now() - frame.capturedAt > this.config.frameMaxAgeMs ||
          (latest && (latest.dimension !== frame.dimension || latest.perspective !== frame.perspective || (latest.uiState && latest.uiState !== 'GAMEPLAY')))) {
        this.metrics.observationsDiscardedStale += 1
        this.logger?.info('[VISION] stale inference discarded')
        return { status: 'STALE', reason: 'SUPERSEDED' }
      }
      const inferenceMs = this.now() - startedAt
      this.worldModel.updateVisual(observation, frame, { inferenceMs, trigger })
      this.metrics.observationsAccepted += 1
      this.lastInferenceAt = this.now()
      this.lastSignature = frame.signature
      await this.#saveDebug(frame, observation)
      this.logger?.info(`[VISION] observation updated (${inferenceMs}ms)`)
      return { status: 'UPDATED', observation, frameId: frame.id, inferenceMs }
    } catch (error) {
      if (isOllamaPreempted(error) || error?.status === 'ABORTED') {
        this.metrics.preempted += 1
        this.logger?.info(`[VISION] preempted${error.preemptedBy ? ` by ${error.preemptedBy}` : ''}`)
        return { status: 'PREEMPTED', reason: error.preemptedBy || 'HIGHER_PRIORITY_REQUEST' }
      }
      this.logger?.error('[VISION] inference failed', error)
      return { status: 'FAILURE', reason: error.message }
    } finally {
      // Every completed attempt (including discard/error/preemption) backs off.
      this.backgroundNotBefore = this.now() + (this.config.backgroundCooldownMs ?? this.config.backgroundIntervalMs)
    }
  }

  async #saveDebug(frame, observation) {
    if (!this.config.debugSaveFrames) return
    await fs.mkdir(this.config.debugDirectory, { recursive: true })
    const stem = `${frame.capturedAt}-${frame.id.replace(/[^a-zA-Z0-9_-]/g, '')}`
    const pngPath = path.join(this.config.debugDirectory, `${stem}.png`)
    const jsonPath = path.join(this.config.debugDirectory, `${stem}.json`)
    await Promise.all([
      fs.writeFile(pngPath, frame.buffer),
      fs.writeFile(jsonPath, JSON.stringify({ frame: { ...frame, buffer: undefined }, observation }, null, 2))
    ])
    this.savedFrames.push([pngPath, jsonPath])
    while (this.savedFrames.length > this.config.debugMaxFrames) {
      const files = this.savedFrames.shift()
      await Promise.all(files.map(file => fs.rm(file, { force: true })))
    }
  }
}

module.exports = { VisualPerceptionController, REQUEST_KINDS }
