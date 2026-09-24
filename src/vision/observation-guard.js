// The image model's confidence is self-reported, not evidence. Reject scene
// classifications that contradict a dimension confirmed by the game client.
function guardVisualObservation(observation, frame) {
  const dimension = frame.dimension?.replace(/^minecraft:/, '')
  const impossible = (observation.sceneType === 'NETHER' && dimension && dimension !== 'the_nether') ||
    (observation.sceneType === 'END' && dimension && dimension !== 'the_end')
  if (!impossible) return { observation, rejected: false }
  const safeLandscape = /^(?:grass|grassy terrain|water|river|sky|clouds?|trees?|sand|dirt|stone|草地|草|水|河|天空|云|树|沙|泥土|石头)$/i
  // A wrong dimension guess does not erase directly visible color/shape. Keep
  // only appearance-level block labels, not guessed Minecraft materials.
  const safeShape = /^(?:(?:light|dark)\s+)?(?:red|orange|yellow|green|blue|cyan|turquoise|purple|pink|black|white|gray|grey|brown|golden|silver)(?:-colored)?\s+(?:block|cube|square)$|^(?:红|橙|黄|绿|蓝|青|紫|粉|黑|白|灰|棕|金|银)(?:色)?(?:方块|立方体)$/i
  const landscape = observation.salientObjects.filter(item => item.confidence >= 0.8 &&
    (safeLandscape.test(item.label.trim()) || safeShape.test(item.label.trim())))
  const terrain = observation.terrain.filter(item => item.confidence >= 0.8 && safeLandscape.test(item.label.trim()))
  return {
    rejected: true,
    observation: {
      ...observation,
      sceneType: 'UNKNOWN',
      summary: '场景分类与游戏维度冲突；仅保留可辨认的地形与颜色形状。',
      salientObjects: landscape, structures: [], terrain, hazards: [],
      playerActivity: { visible: false, description: '', confidence: 0 },
      uncertainty: ['视觉识别与游戏维度冲突'],
      notableChanges: []
    }
  }
}

module.exports = { guardVisualObservation }
