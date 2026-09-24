function round(value, digits = 1) {
  if (!Number.isFinite(value)) return null
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function positionOf(position) {
  if (!position) return null
  return { x: round(position.x), y: round(position.y), z: round(position.z) }
}

function distanceBetween(a, b) {
  if (!a || !b) return null
  if (typeof a.distanceTo === 'function') return a.distanceTo(b)
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}

function inventoryCounts(bot) {
  const counts = {}
  for (const item of bot.inventory?.items?.() || []) counts[item.name] = (counts[item.name] || 0) + item.count
  return counts
}

function inventoryDelta(before = {}, after = {}) {
  const delta = {}
  for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const change = (after[name] || 0) - (before[name] || 0)
    if (change) delta[name] = change
  }
  return delta
}

function blockRef(position) {
  return `block:${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`
}

function entityRef(entity) {
  return `entity:${entity.id}`
}

function droppedItemSummary(entity) {
  if (typeof entity?.getDroppedItem !== 'function') return null
  try {
    const item = entity.getDroppedItem()
    if (item && typeof item.name === 'string' && Number.isInteger(item.count) && item.count > 0) {
      return { name: item.name, count: item.count }
    }
  } catch {
    // Item metadata may arrive after the entity spawn packet.
  }
  return null
}

function parseTargetRef(reference) {
  if (typeof reference !== 'string') return null
  if (reference.startsWith('entity:')) return { kind: 'entity', id: Number(reference.slice(7)) }
  if (reference.startsWith('block:')) {
    const values = reference.slice(6).split(',').map(Number)
    if (values.length === 3 && values.every(Number.isInteger)) {
      return { kind: 'block', position: { x: values[0], y: values[1], z: values[2] } }
    }
  }
  return null
}

class LearningObservationBuilder {
  constructor({ bot, range = 8, maxBlocks = 24, maxEntities = 16, worldModel = null, recentEvents = null, now = Date.now }) {
    this.bot = bot
    this.range = range
    this.maxBlocks = maxBlocks
    this.maxEntities = maxEntities
    this.now = now
    this.worldModel = worldModel
    this.recentEvents = recentEvents
    this.observedRefs = new Set()
  }

  capture({
    previousInventory = null,
    target = null,
    startedAt = this.now(),
    actionResult = null,
    previousActionResult = null,
    goal = null,
    recentProgress = []
  } = {}) {
    const inventory = inventoryCounts(this.bot)
    const nearbyBlocks = this.#nearbyBlocks()
    const nearbyEntities = this.#nearbyEntities()
    this.observedRefs = new Set([...nearbyBlocks, ...nearbyEntities].map(item => item.ref))
    const observation = {
      observedAt: new Date(this.now()).toISOString(),
      elapsedMs: Math.max(0, this.now() - startedAt),
      position: positionOf(this.bot.entity?.position),
      health: Number.isFinite(this.bot.health) ? this.bot.health : null,
      food: Number.isFinite(this.bot.food) ? this.bot.food : null,
      heldItem: this.bot.heldItem ? {
        name: this.bot.heldItem.name,
        count: this.bot.heldItem.count,
        selectedHotbarSlot: Number.isInteger(this.bot.quickBarSlot) ? this.bot.quickBarSlot : null
      } : null,
      hotbar: Array.from({ length: 9 }, (_, slot) => {
        const item = this.bot.inventory?.slots?.[36 + slot]
        return item ? { slot, name: item.name, count: item.count } : { slot, name: null, count: 0 }
      }),
      inventory,
      inventoryDelta: inventoryDelta(previousInventory || inventory, inventory),
      nearbyBlocks,
      nearbyEntities,
      targetState: this.#targetState(target),
      currentGoal: goal ? {
        description: goal.description,
        objective: goal.objective,
        source: goal.source
      } : null,
      recentProgress,
      previousActionResult: previousActionResult ? {
        success: Boolean(previousActionResult.success),
        reason: previousActionResult.reason || null
      } : null,
      actionResult: actionResult ? {
        success: Boolean(actionResult.success),
        reason: actionResult.reason || null
      } : null
    }
    if (this.worldModel) {
      const events = typeof this.recentEvents === 'function' ? this.recentEvents() : []
      const fused = this.worldModel.fuse({ recentEvents: events, goal })
      observation.multimodal = {
        symbolicSource: 'CONFIRMED_SYMBOLICALLY',
        visual: fused.visual,
        recentEvents: fused.recentEvents,
        groundingRules: fused.groundingRules
      }
    }
    return observation
  }

  resolve(reference) {
    if (!this.observedRefs.has(reference)) return null
    const parsed = parseTargetRef(reference)
    if (!parsed) return null
    if (parsed.kind === 'entity') return this.bot.entities?.[parsed.id] || null
    const origin = this.bot.entity?.position
    const position = origin?.offset
      ? origin.offset(parsed.position.x - origin.x, parsed.position.y - origin.y, parsed.position.z - origin.z)
      : parsed.position
    return this.bot.blockAt?.(position) || null
  }

  #nearbyBlocks() {
    if (!this.bot.entity?.position || typeof this.bot.findBlocks !== 'function') return []
    let positions = []
    try {
      positions = this.bot.findBlocks({
        matching: block => block && !['air', 'cave_air', 'void_air'].includes(block.name),
        maxDistance: this.range,
        count: this.maxBlocks * 32
      }) || []
    } catch {
      return []
    }
    const candidates = positions.map(position => {
      const block = this.bot.blockAt(position)
      return block && {
        ref: blockRef(position),
        name: block.name,
        position: positionOf(position),
        distance: round(distanceBetween(this.bot.entity.position, position)),
        diggable: typeof this.bot.canDigBlock === 'function' ? Boolean(this.bot.canDigBlock(block)) : null
      }
    }).filter(Boolean).sort((a, b) => a.distance - b.distance)

    const selected = []
    const names = new Set()
    for (const block of candidates) {
      if (names.has(block.name)) continue
      names.add(block.name)
      selected.push(block)
      if (selected.length >= this.maxBlocks) return selected
    }
    for (const block of candidates) {
      if (selected.includes(block)) continue
      selected.push(block)
      if (selected.length >= this.maxBlocks) break
    }
    return selected
  }

  #nearbyEntities() {
    if (!this.bot.entity?.position) return []
    return Object.values(this.bot.entities || {})
      .filter(entity => entity && entity.id !== this.bot.entity.id && entity.position)
      .map(entity => ({ entity, distance: distanceBetween(this.bot.entity.position, entity.position) }))
      .filter(item => item.distance <= this.range)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, this.maxEntities)
      .map(({ entity, distance }) => {
        const droppedItem = droppedItemSummary(entity)
        return {
          ref: entityRef(entity),
          name: entity.name || entity.username || 'unknown',
          type: entity.type || 'unknown',
          position: positionOf(entity.position),
          distance: round(distance),
          ...(droppedItem ? { droppedItem } : {})
        }
      })
  }

  #targetState(reference) {
    if (!reference) return null
    const target = this.resolve(reference)
    if (!target) return { ref: reference, exists: false }
    const droppedItem = droppedItemSummary(target)
    return {
      ref: reference,
      exists: true,
      name: target.name || target.username || 'unknown',
      type: target.type || (reference.startsWith('block:') ? 'block' : 'unknown'),
      position: positionOf(target.position),
      distance: round(distanceBetween(this.bot.entity?.position, target.position)),
      ...(droppedItem ? { droppedItem } : {})
    }
  }
}

module.exports = {
  LearningObservationBuilder,
  inventoryCounts,
  inventoryDelta,
  parseTargetRef,
  blockRef,
  entityRef,
  distanceBetween,
  droppedItemSummary
}
