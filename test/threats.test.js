const test = require('node:test')
const assert = require('node:assert/strict')
const {
  selectThreat,
  selectCombatTarget,
  selectOrderedTarget,
  retreatPoint
} = require('../src/survival/threats')

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

test('selectThreat uses Mineflayer hostile type and ignores other entities', () => {
  const zombie = { id: 1, type: 'hostile', name: 'zombie', position: position(6) }
  const cow = { id: 2, type: 'mob', name: 'cow', position: position(2) }

  assert.equal(selectThreat({
    entities: [cow, zombie],
    botPosition: position(0),
    detectionRange: 10,
    defendedPlayers: [],
    defenseRange: 8
  }), zombie)
})

test('selectThreat can defend a recently hurt nearby player', () => {
  const skeleton = { id: 3, type: 'hostile', name: 'skeleton', position: position(11) }

  assert.equal(selectThreat({
    entities: [skeleton],
    botPosition: position(0),
    detectionRange: 10,
    defendedPlayers: [{ position: position(10) }],
    defenseRange: 3
  }), skeleton)
})

test('retreatPoint moves directly away from the threat', () => {
  assert.deepEqual(retreatPoint(position(2), position(0), 8), { x: 10, y: 64, z: 0 })
})

function combatSelection(overrides = {}) {
  const zombie = { id: 1, type: 'hostile', name: 'zombie', position: position(6) }
  return {
    zombie,
    target: selectCombatTarget({
      mode: 'DEFENSIVE',
      entities: [zombie],
      botPosition: position(0),
      detectionRange: 10,
      immediateDangerRange: 3.5,
      defendedPlayers: [],
      defenseRange: 8,
      ...overrides
    })
  }
}

test('DEFENSIVE does not engage a merely nearby hostile', () => {
  assert.equal(combatSelection().target, null)
})

test('DEFENSIVE engages after the companion was recently hurt', () => {
  const { zombie, target } = combatSelection({ selfDefenseActive: true })
  assert.equal(target, zombie)
})

test('DEFENSIVE engages a hostile in immediate danger range', () => {
  const zombie = { id: 2, type: 'hostile', name: 'zombie', position: position(3) }
  const { target } = combatSelection({ entities: [zombie] })
  assert.equal(target, zombie)
})

test('DEFENSIVE selects a likely attacker near a recently hurt player', () => {
  const { zombie, target } = combatSelection({
    defendedPlayers: [{ position: position(7) }]
  })
  assert.equal(target, zombie)
})

test('explicit orders authorize their target in DEFENSIVE', () => {
  const { zombie, target } = combatSelection({ orderedTargetId: 1 })
  assert.equal(target, zombie)
})

test('PASSIVE never returns a combat target and AGGRESSIVE does', () => {
  assert.equal(combatSelection({ mode: 'PASSIVE', selfDefenseActive: true }).target, null)
  const { zombie, target } = combatSelection({ mode: 'AGGRESSIVE' })
  assert.equal(target, zombie)
})

test('creepers are excluded from proactive and ordered melee targets', () => {
  const creeper = { id: 4, type: 'hostile', name: 'creeper', position: position(3) }
  assert.equal(combatSelection({ mode: 'AGGRESSIVE', entities: [creeper] }).target, null)
  assert.equal(selectOrderedTarget({
    entities: [creeper],
    origin: position(0),
    botPosition: position(0),
    maxRange: 15
  }), null)
})
