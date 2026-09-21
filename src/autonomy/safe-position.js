const HAZARDS = new Set([
  'lava',
  'fire',
  'soul_fire',
  'cactus',
  'magma_block',
  'sweet_berry_bush',
  'powder_snow'
])

function isSafeStandingPosition(bot, position) {
  const feet = bot.blockAt(position)
  const head = bot.blockAt(position.offset(0, 1, 0))
  const ground = bot.blockAt(position.offset(0, -1, 0))
  if (!feet || !head || !ground) return false
  if (feet.boundingBox !== 'empty' || head.boundingBox !== 'empty') return false
  if (ground.boundingBox !== 'block') return false
  return !HAZARDS.has(feet.name) && !HAZARDS.has(ground.name)
}

function findSafePositionNear(bot, center, { minRadius, maxRadius, attempts = 16, random = Math.random }) {
  if (!center?.offset) return null

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const angle = random() * Math.PI * 2
    const radius = minRadius + random() * (maxRadius - minRadius)
    const base = center.offset(Math.cos(angle) * radius, 0, Math.sin(angle) * radius).floored()

    for (const yOffset of [0, 1, -1, 2, -2]) {
      const candidate = base.offset(0, yOffset, 0)
      if (isSafeStandingPosition(bot, candidate)) return candidate
    }
  }

  return null
}

module.exports = { HAZARDS, isSafeStandingPosition, findSafePositionNear }
