const VISUAL_PATTERNS = [
  /你(?:看|看到|看见|觉得).*(?:前面|那边|这里|那个|东西|像不像|入口)/,
  /(?:前面|那边|这里|那个).*(?:是什么|有什么|像不像|看起来)/,
  /(?:do you see|can you see|what(?:'s| is) (?:that|there|ahead)|look like|cave entrance)/i
]

function requiresVisualContext(message) {
  return typeof message === 'string' && VISUAL_PATTERNS.some(pattern => pattern.test(message))
}

function conversationVisualContext(worldModel) {
  const visual = worldModel?.getVisual?.()
  if (!visual) return null
  return {
    source: visual.source,
    perspective: visual.frame.perspective,
    ageMs: visual.ageMs,
    sceneType: visual.observation.sceneType,
    summary: visual.observation.summary,
    salientObjects: visual.observation.salientObjects,
    structures: visual.observation.structures,
    hazards: visual.observation.hazards,
    uncertainty: visual.observation.uncertainty
  }
}

module.exports = { requiresVisualContext, conversationVisualContext }
