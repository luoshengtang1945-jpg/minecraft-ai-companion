const { VISUAL_SOURCES } = require('./visual-observation')

class MultimodalWorldModel {
  constructor({ visualTtlMs = 15000, now = Date.now } = {}) {
    this.visualTtlMs = visualTtlMs
    this.now = now
    this.visual = null
  }

  updateVisual(observation, frame, { inferenceMs = null, trigger = null } = {}) {
    this.visual = Object.freeze({
      source: VISUAL_SOURCES.OBSERVED,
      observation,
      frame: Object.freeze({
        id: frame.id,
        capturedAt: frame.capturedAt,
        perspective: frame.perspective,
        uiState: frame.uiState || 'GAMEPLAY',
        width: frame.width,
        height: frame.height,
        camera: frame.camera,
        dimension: frame.dimension
      }),
      observedAt: this.now(),
      inferenceMs,
      trigger
    })
    return this.visual
  }

  getVisual({ allowStale = false } = {}) {
    if (!this.visual) return null
    const ageMs = Math.max(0, this.now() - this.visual.frame.capturedAt)
    if (!allowStale && ageMs > this.visualTtlMs) return null
    return { ...this.visual, ageMs, stale: ageMs > this.visualTtlMs }
  }

  fuse({ symbolic, recentEvents = [], goal = null } = {}) {
    const visual = this.getVisual()
    return {
      fusedAt: new Date(this.now()).toISOString(),
      symbolic: symbolic ? { source: VISUAL_SOURCES.SYMBOLIC, observation: symbolic } : null,
      visual,
      recentEvents: recentEvents.slice(-10),
      goal,
      groundingRules: {
        exactCoordinatesComeOnlyFrom: VISUAL_SOURCES.SYMBOLIC,
        visualClaimsAreHypotheses: true,
        staleVisualDiscardedAfterMs: this.visualTtlMs
      }
    }
  }
}

module.exports = { MultimodalWorldModel }
