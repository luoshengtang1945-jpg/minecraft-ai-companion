function isHostile(entity) {
  return Boolean(entity?.position && entity.type === 'hostile')
}

function selectThreat({ entities, botPosition, detectionRange, defendedPlayers = [], defenseRange }) {
  let best = null
  let bestScore = Infinity

  for (const entity of entities) {
    if (!isHostile(entity)) continue

    const botDistance = botPosition.distanceTo(entity.position)
    const threatensBot = botDistance <= detectionRange
    const threatensPlayer = defendedPlayers.some(player => (
      player?.position && player.position.distanceTo(entity.position) <= defenseRange
    ))

    // Do not cross the world to defend somebody who is no longer nearby.
    if (!threatensBot && !(threatensPlayer && botDistance <= detectionRange * 1.5)) continue

    const creeperUrgency = entity.name === 'creeper' && botDistance < 5 ? -4 : 0
    const playerDefenseUrgency = threatensPlayer ? -2 : 0
    const score = botDistance + creeperUrgency + playerDefenseUrgency

    if (score < bestScore) {
      best = entity
      bestScore = score
    }
  }

  return best
}

function selectCombatTarget({
  mode,
  entities,
  botPosition,
  detectionRange,
  immediateDangerRange,
  defendedPlayers = [],
  defenseRange,
  selfDefenseActive = false,
  orderedTargetId = null
}) {
  if (mode === 'PASSIVE') return null

  const candidates = entities
    .filter(entity => isHostile(entity) && entity.name !== 'creeper')
    .map(entity => ({
      entity,
      botDistance: botPosition.distanceTo(entity.position)
    }))

  if (orderedTargetId !== null) {
    const ordered = candidates.find(candidate => (
      candidate.entity.id === orderedTargetId && candidate.botDistance <= detectionRange * 1.5
    ))
    if (ordered) return ordered.entity
  }

  const nearby = candidates
    .filter(candidate => candidate.botDistance <= detectionRange)
    .sort((a, b) => a.botDistance - b.botDistance)

  if (mode === 'AGGRESSIVE') return nearby[0]?.entity || null
  if (selfDefenseActive) return nearby[0]?.entity || null

  let likelyPlayerAttacker = null
  let playerDistance = Infinity
  for (const candidate of candidates) {
    if (candidate.botDistance > detectionRange * 1.5) continue
    for (const player of defendedPlayers) {
      if (!player?.position) continue
      const distance = player.position.distanceTo(candidate.entity.position)
      if (distance <= defenseRange && distance < playerDistance) {
        likelyPlayerAttacker = candidate.entity
        playerDistance = distance
      }
    }
  }
  if (likelyPlayerAttacker) return likelyPlayerAttacker

  return nearby.find(candidate => candidate.botDistance <= immediateDangerRange)?.entity || null
}

function selectOrderedTarget({ entities, origin, botPosition, maxRange }) {
  let best = null
  let bestDistance = Infinity

  for (const entity of entities) {
    if (!isHostile(entity) || entity.name === 'creeper') continue
    const botDistance = botPosition.distanceTo(entity.position)
    const originDistance = origin.distanceTo(entity.position)
    if (botDistance > maxRange || originDistance > maxRange) continue
    if (originDistance < bestDistance) {
      best = entity
      bestDistance = originDistance
    }
  }

  return best
}

function retreatPoint(botPosition, threatPosition, distance) {
  let dx = botPosition.x - threatPosition.x
  let dz = botPosition.z - threatPosition.z
  const length = Math.hypot(dx, dz)

  if (length < 0.01) {
    dx = 1
    dz = 0
  } else {
    dx /= length
    dz /= length
  }

  return {
    x: botPosition.x + dx * distance,
    y: botPosition.y,
    z: botPosition.z + dz * distance
  }
}

module.exports = {
  isHostile,
  selectThreat,
  selectCombatTarget,
  selectOrderedTarget,
  retreatPoint
}
