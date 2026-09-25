const VISUAL_PATTERNS = [
  /你(?:看|看到|看见|觉得).*(?:前面|那边|这里|那个|东西|像不像|入口)/,
  /(?:你|我)?(?:面前|眼前|正前方|前面|那边|这里|周围).*(?:是什么|有什么|看到|看见|看起来|什么情况)/,
  /(?:描述|说说|讲讲).*(?:你的视角|你眼前|你面前|你看到|你看见)/,
  /你(?:现在)?(?:看见|看到|看)什么/,
  /你(?:现在|刚才)?(?:能)?(?:看到|看见|看)(?:了)?(?:的)?(?:是)?(?:什么|啥|哪些)/,
  /你.*(?:看到|看见|眼前|视角).*(?:是什么|什么颜色|哪些颜色|哪种颜色|有没有)/,
  /你.*(?:看到|看见|看).*?(?:画面|景象|场景).*(?:什么|怎样|怎么样)/,
  /你(?:觉得|喜欢).*(?:这里|这儿|这个地方|眼前|这片地方).*(?:怎么样|如何|喜欢|好看|像)/,
  /(?:前面|那边|这里|那个).*(?:是什么|有什么|像不像|看起来)/,
  /(?:do you see|can you see|what(?:'s| is) (?:that|there|ahead)|look like|cave entrance)/i
]

function requiresVisualContext(message) {
  return typeof message === 'string' && VISUAL_PATTERNS.some(pattern => pattern.test(message))
}

function isVisualFollowUp(message) {
  return typeof message === 'string' && /^(?:再看(?:一眼|一下|一次)?|重新看(?:一下|一眼|一次)?|现在呢|这次呢|那现在呢|看清了吗|再描述(?:一下)?)(?:[？?。！!\s]*)$/.test(message.trim())
}

const ENTITY_NAMES = new Set([
  'chicken', 'sheep', 'cow', 'pig', 'horse', 'wolf', 'cat', 'dog', 'rabbit',
  'zombie', 'skeleton', 'creeper', 'spider', 'enderman', 'villager', 'bee',
  'goat', 'fox', 'frog', 'squid', 'fish', 'dolphin', 'turtle', 'bat', 'player'
])

function visualEntityName(label) {
  const words = String(label).toLowerCase().replace(/[^a-z]+/g, ' ').trim().split(/\s+/)
  return words.find(word => ENTITY_NAMES.has(word)) || null
}

function uncertainStructure(item) {
  const label = String(item.label || '')
  return item.confidence < 0.9 || /(?:structure|building|建筑|房子|设施)/i.test(label)
}

function conversationVisualContext(worldModel, bot = null) {
  const visual = worldModel?.getVisual?.()
  if (!visual) return null
  const observedEntities = Object.values(bot?.entities || {}).map(entity => String(entity.name || entity.displayName || entity.username || '').toLowerCase())
  const reliable = items => (items || []).filter(item => {
    if (item.confidence < 0.55) return false
    const entityName = visualEntityName(item.label)
    // Model confidence is not corroboration for a named creature. An absent
    // symbolic entity can also mean it is distant, so omit rather than deny it.
    return !entityName || observedEntities.some(name => name === entityName || name.replace(/_/g, ' ').includes(entityName))
  })
  return {
    source: visual.source,
    frameId: visual.frame.id,
    perspective: visual.frame.perspective,
    ageMs: visual.ageMs,
    sceneType: visual.observation.sceneType,
    salientObjects: reliable(visual.observation.salientObjects).filter(item => !uncertainStructure(item)),
    structures: reliable(visual.observation.structures).filter(item => !uncertainStructure(item)),
    terrain: reliable(visual.observation.terrain),
    hazards: reliable(visual.observation.hazards),
    uncertainty: visual.observation.uncertainty
  }
}

module.exports = { requiresVisualContext, isVisualFollowUp, conversationVisualContext }
