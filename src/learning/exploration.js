const { isSafeStandingPosition } = require('../autonomy/safe-position')

const HEADING_OFFSETS = Object.freeze([0, -15, 15, -30, 30])
const Y_OFFSETS = Object.freeze([0, 1, -1, 2, -2])

function destinationForHeading(origin, heading, distance) {
  const radians = heading * Math.PI / 180
  const x = Math.round(origin.x + Math.sin(radians) * distance)
  const z = Math.round(origin.z - Math.cos(radians) * distance)
  if (typeof origin.offset === 'function') return origin.offset(x - origin.x, 0, z - origin.z)
  return { x, y: Math.round(origin.y), z }
}

function selectExplorationDestination(bot, { heading, distance }, explorationState = null) {
  const origin = bot.entity?.position
  if (!origin) return null
  const distances = Array.from({ length: distance - 1 }, (_, index) => distance - index)
  const candidates = []

  for (const headingOffset of HEADING_OFFSETS) {
    for (const candidateDistance of distances) {
      const base = destinationForHeading(origin, (heading + headingOffset + 360) % 360, candidateDistance)
      for (const yOffset of Y_OFFSETS) {
        const candidate = typeof base.offset === 'function'
          ? base.offset(0, yOffset, 0)
          : { x: base.x, y: base.y + yOffset, z: base.z }
        if (explorationState && !explorationState.isWithinBounds(candidate)) continue
        if (!isSafeStandingPosition(bot, candidate)) continue
        const novelty = explorationState?.novelty(candidate) || { visits: 0, lastObservedStep: 0 }
        candidates.push({ candidate, novelty, headingOffset: Math.abs(headingOffset), distanceOffset: distance - candidateDistance })
      }
    }
  }

  candidates.sort((a, b) =>
    a.novelty.visits - b.novelty.visits ||
    a.novelty.lastObservedStep - b.novelty.lastObservedStep ||
    a.headingOffset - b.headingOffset ||
    a.distanceOffset - b.distanceOffset
  )
  return candidates[0]?.candidate || null
}

module.exports = { destinationForHeading, selectExplorationDestination, HEADING_OFFSETS, Y_OFFSETS }
