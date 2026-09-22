const USEFUL_BLOCK_NAMES = [
  'coal_ore',
  'deepslate_coal_ore',
  'iron_ore',
  'deepslate_iron_ore',
  'copper_ore',
  'deepslate_copper_ore',
  'gold_ore',
  'deepslate_gold_ore',
  'diamond_ore',
  'deepslate_diamond_ore',
  'oak_log',
  'birch_log',
  'spruce_log',
  'crafting_table',
  'furnace',
  'chest'
]

function roundPosition(position) {
  if (!position) return null
  return {
    x: Math.round(position.x * 10) / 10,
    y: Math.round(position.y * 10) / 10,
    z: Math.round(position.z * 10) / 10
  }
}

function summarizeInventory(bot) {
  const counts = new Map()
  for (const item of bot.inventory?.items?.() || []) {
    counts.set(item.name, (counts.get(item.name) || 0) + item.count)
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([name, count]) => `${name}x${count}`)
}

function summarizeEntities(bot, origin, range) {
  const hostile = new Map()
  const passive = new Map()

  for (const entity of Object.values(bot.entities || {})) {
    if (!entity.position || entity.id === bot.entity?.id) continue
    if (origin.distanceTo(entity.position) > range) continue
    if (entity.type === 'hostile') hostile.set(entity.name, (hostile.get(entity.name) || 0) + 1)
    if (['passive', 'mob', 'animal'].includes(entity.type)) {
      passive.set(entity.name, (passive.get(entity.name) || 0) + 1)
    }
  }

  const compact = map => [...map.entries()].slice(0, 8).map(([name, count]) => `${name}x${count}`)
  return { hostile: compact(hostile), passive: compact(passive) }
}

function summarizeUsefulBlocks(bot, maxDistance) {
  if (!bot.findBlocks || !bot.registry?.blocksByName) return []

  const ids = USEFUL_BLOCK_NAMES
    .map(name => bot.registry.blocksByName[name]?.id)
    .filter(Number.isInteger)
  if (!ids.length) return []

  try {
    const positions = bot.findBlocks({ matching: ids, maxDistance, count: 12 })
    const counts = new Map()
    for (const position of positions) {
      const name = bot.blockAt(position)?.name
      if (name) counts.set(name, (counts.get(name) || 0) + 1)
    }
    return [...counts.entries()].map(([name, count]) => `${name}x${count}`)
  } catch {
    return []
  }
}

class WorldStateBuilder {
  constructor({ bot, movement, survival, goalManager, journal, config, session = null }) {
    this.session = session
    this.bot = bot
    this.movement = movement
    this.survival = survival
    this.goalManager = goalManager
    this.journal = journal
    this.config = config
    this.preferredPlayer = null
  }

  observePlayer(username) {
    this.preferredPlayer = username
  }

  build() {
    const botPosition = this.bot.entity?.position
    if (!botPosition) return null

    const playerEntry = this.#selectPlayer()
    const player = playerEntry?.entity
    const playerDistance = player?.position ? botPosition.distanceTo(player.position) : null
    const velocity = player?.velocity
    const speed = velocity ? Math.hypot(velocity.x || 0, velocity.z || 0) : 0
    const playerMoving = speed > 0.03
    const heldItem = player?.heldItem?.name || null
    const entities = summarizeEntities(this.bot, botPosition, this.config.summaryRange)

    return {
      companion: {
        position: roundPosition(botPosition),
        health: this.bot.health ?? null,
        food: this.bot.food ?? null
      },
      player: playerEntry ? {
        username: playerEntry.username,
        position: roundPosition(player.position),
        distance: playerDistance === null ? null : Math.round(playerDistance * 10) / 10,
        moving: playerMoving,
        activity: this.#inferActivity({ playerMoving, heldItem, player })
      } : null,
      world: {
        timeOfDay: this.bot.time?.timeOfDay ?? null,
        day: this.bot.time?.day ?? null,
        isDay: this.bot.time?.isDay ?? null,
        raining: this.bot.isRaining ?? null
      },
      combatMode: this.survival.getCombatMode(),
      behavior: this.movement.getBehaviorSummary(),
      companionSession: this.session?.snapshot() || null,
      nearbyEntities: entities,
      usefulBlocks: summarizeUsefulBlocks(this.bot, this.config.resourceScanRange),
      inventory: summarizeInventory(this.bot),
      recentEvents: this.journal.recent(),
      currentGoal: this.goalManager.snapshot()
    }
  }

  #selectPlayer() {
    const preferred = this.preferredPlayer && this.bot.players[this.preferredPlayer]?.entity
    if (preferred) return { username: this.preferredPlayer, entity: preferred }

    for (const [username, player] of Object.entries(this.bot.players || {})) {
      if (username !== this.bot.username && player.entity) return { username, entity: player.entity }
    }
    return null
  }

  #inferActivity({ playerMoving, heldItem, player }) {
    if (player?.isInWater) return 'swimming'
    if (playerMoving && heldItem) return `moving_with_${heldItem}`
    if (playerMoving) return 'moving'
    if (heldItem) return `holding_${heldItem}`
    return 'standing'
  }
}

module.exports = {
  WorldStateBuilder,
  roundPosition,
  summarizeInventory,
  summarizeEntities,
  summarizeUsefulBlocks
}
