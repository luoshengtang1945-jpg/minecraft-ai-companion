const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { SurvivalController } = require('../src/survival/survival-controller')
const { MovementController } = require('../src/skills')
const { CombatController } = require('../src/combat/combat-controller')
const { GoalManager } = require('../src/goals')

function vector(x, y = 64, z = 0) {
  return { x, y, z, distanceTo(other) { return Math.hypot(x - other.x, y - other.y, z - other.z) }, offset(dx, dy, dz) { return vector(x + dx, y + dy, z + dz) } }
}

function liveFixture(t) {
  let now = 1000
  const bot = new EventEmitter()
  bot.username = 'AI_Companion'
  bot.entity = { id: 10, position: vector(0) }
  bot.health = 20
  bot.players = { Steve: { entity: { id: 20, position: vector(0) } } }
  const enemy = { id: 30, name: 'zombie', type: 'hostile', position: vector(2.5) }
  bot.entities = { 30: enemy }
  const paths = []
  bot.pathfinder = { setMovements() {}, setGoal(goal) { paths.push(goal) } }
  bot.clearControlStates = () => {}
  bot.chat = () => {}
  bot.lookAt = async () => {}
  bot.inventory = { items: () => [] }
  let attacks = 0
  bot.attack = () => { attacks++ }
  const logger = { info() {}, warn() {}, error() {}, throttled() {} }
  const goalManager = new GoalManager({ now: () => now })
  const movement = new MovementController(bot, { logger, goalManager })
  movement.initialize({})
  const combat = new CombatController(bot, { movement, logger, config: { approachRange: 2.4, meleeRange: 3.1 } })
  const survival = new SurvivalController(bot, { combat, movement, logger, goalManager, now: () => now,
    config: { initialCombatMode: 'DEFENSIVE', tickMs: 1000000, detectionRange: 10, defenseRange: 8,
      immediateDangerRange: 3.5, defenseMemoryMs: 5000, attackOrderMs: 15000,
      lowHealth: 8, safeHealth: 12, retreatDistance: 8, creeperDistance: 6 } })
  survival.start()
  survival.observePlayer('Steve')
  movement.follow('Steve')
  t.after(() => survival.stop())
  return { bot, enemy, movement, survival, combat, paths, logger, attacks: () => attacks, advance: ms => { now += ms } }
}

function fixture() {
  const bot = new EventEmitter()
  bot.username = 'AI_Companion'
  bot.entity = { id: 10, position: { distanceTo: () => 0 } }
  bot.players = {}
  bot.entities = {}

  const combat = { disengage() {} }
  const movement = { endOverride() {} }
  const logger = { info() {}, warn() {}, throttled() {} }
  const config = {
    initialCombatMode: 'DEFENSIVE',
    detectionRange: 10,
    attackOrderMs: 15000
  }
  return new SurvivalController(bot, { combat, movement, logger, config })
}

test('DEFENSIVE is the default combat mode', () => {
  assert.equal(fixture().getCombatMode(), 'DEFENSIVE')
})

test('PASSIVE rejects explicit attack orders', () => {
  const survival = fixture()
  survival.setCombatMode('PASSIVE')
  assert.deepEqual(survival.requestAttack('Steve'), { accepted: false, reason: 'PASSIVE' })
})

test('COME cancels chasing immediately and cannot be stolen again by the same nearby enemy', async t => {
  const { enemy, movement, survival, paths } = liveFixture(t)
  await survival.tickOnce()
  assert.equal(movement.getLocomotionOwner(), 'SURVIVAL')
  survival.cancelPursuit()
  movement.come('Steve')
  const recallPath = paths.at(-1)
  enemy.position = vector(3)
  for (let i = 0; i < 4; i++) await survival.tickOnce()
  assert.equal(movement.getLocomotionOwner(), 'PLAYER')
  assert.equal(movement.getBehaviorSummary().type, 'COME')
  assert.equal(paths.at(-1), recallPath)
  assert.equal(survival.orderedTargetId, null)
})

test('defensive pursuit ends at its origin-distance, duration, or player leash bound', async t => {
  for (const reason of ['distance', 'duration', 'playerLeash']) {
    await t.test(reason, async t => {
      const { bot, enemy, movement, survival, advance } = liveFixture(t)
      await survival.tickOnce()
      assert.equal(movement.getLocomotionOwner(), 'SURVIVAL')
      if (reason === 'distance') { bot.entity.position = vector(5); enemy.position = vector(7) }
      if (reason === 'duration') advance(8001)
      if (reason === 'playerLeash') bot.players.Steve.entity.position = vector(15)
      await survival.tickOnce()
      assert.equal(movement.getLocomotionOwner(), 'PLAYER')
      assert.equal(movement.getBehaviorSummary().type, 'FOLLOW')
      await survival.tickOnce()
      assert.equal(movement.getLocomotionOwner(), 'PLAYER')
    })
  }
})

test('recall preserves low-health and creeper escape then applies the latest COME', async t => {
  for (const reason of ['health', 'creeper']) {
    await t.test(reason, async t => {
      const { bot, enemy, movement, survival } = liveFixture(t)
      if (reason === 'health') bot.health = 6
      else enemy.name = 'creeper'
      await survival.tickOnce()
      survival.cancelPursuit()
      movement.come('Steve')
      assert.equal(movement.getLocomotionOwner(), 'SURVIVAL')
      bot.health = 20
      bot.entities = {}
      await survival.tickOnce()
      assert.equal(movement.getLocomotionOwner(), 'PLAYER')
      assert.equal(movement.getBehaviorSummary().type, 'COME')
    })
  }
})

test('recall during weapon equip prevents the pending pursuit attack', async t => {
  const { bot, movement, survival, paths, attacks } = liveFixture(t)
  let finishEquip
  bot.inventory.items = () => [{ name: 'diamond_sword', type: 1 }]
  bot.equip = () => new Promise(resolve => { finishEquip = resolve })
  const tick = survival.tickOnce()
  assert.ok(finishEquip)
  survival.cancelPursuit()
  movement.come('Steve')
  const recallPath = paths.at(-1)
  finishEquip()
  await tick
  assert.equal(attacks(), 0)
  assert.equal(paths.at(-1), recallPath)
})

test('a later explicit attack order can intentionally re-enable bounded pursuit', async t => {
  const { enemy, movement, survival } = liveFixture(t)
  survival.cancelPursuit()
  enemy.position = vector(5)
  assert.equal(survival.requestAttack('Steve').accepted, true)
  await survival.tickOnce()
  assert.equal(movement.getLocomotionOwner(), 'SURVIVAL')
})
