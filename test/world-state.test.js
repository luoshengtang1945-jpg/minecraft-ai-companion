const test = require('node:test')
const assert = require('node:assert/strict')
const { GoalManager } = require('../src/goals')
const { EventJournal } = require('../src/autonomy/event-journal')
const { WorldStateBuilder } = require('../src/autonomy/world-state')

function position(x, y = 64, z = 0) {
  return {
    x,
    y,
    z,
    distanceTo(other) {
      return Math.hypot(x - other.x, y - other.y, z - other.z)
    }
  }
}

test('world state contains compact autonomy context', () => {
  const bot = {
    username: 'AI_Companion',
    entity: { id: 1, position: position(0) },
    health: 18,
    food: 16,
    isRaining: true,
    time: { timeOfDay: 12500, day: 4, isDay: false },
    players: {
      Steve: {
        entity: {
          id: 2,
          position: position(5),
          velocity: { x: 0.1, y: 0, z: 0 },
          heldItem: { name: 'iron_pickaxe' }
        }
      }
    },
    entities: {
      1: { id: 1, position: position(0), type: 'player' },
      3: { id: 3, position: position(7), type: 'hostile', name: 'zombie' },
      4: { id: 4, position: position(8), type: 'passive', name: 'cow' }
    },
    inventory: { items: () => [{ name: 'bread', count: 3 }] },
    registry: { blocksByName: {} },
    findBlocks: () => []
  }
  const journal = new EventJournal({ now: () => 100 })
  journal.record('test', 'recent')
  const builder = new WorldStateBuilder({
    bot,
    movement: { getBehaviorSummary: () => ({ type: 'STOP', source: null }) },
    survival: { getCombatMode: () => 'DEFENSIVE' },
    goalManager: new GoalManager(),
    journal,
    config: { summaryRange: 12, resourceScanRange: 10 }
  })
  builder.observePlayer('Steve')

  const state = builder.build()
  assert.deepEqual(state.companion, { position: { x: 0, y: 64, z: 0 }, health: 18, food: 16 })
  assert.equal(state.player.distance, 5)
  assert.equal(state.player.moving, true)
  assert.equal(state.player.activity, 'moving_with_iron_pickaxe')
  assert.equal(state.world.raining, true)
  assert.equal(state.combatMode, 'DEFENSIVE')
  assert.deepEqual(state.nearbyEntities, { hostile: ['zombiex1'], passive: ['cowx1'] })
  assert.deepEqual(state.inventory, ['breadx3'])
  assert.equal(state.recentEvents.at(-1).detail, 'recent')
  assert.equal(state.currentGoal, null)
})
