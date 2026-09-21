const test = require('node:test')
const assert = require('node:assert/strict')
const { GoalManager } = require('../src/goals')
const { MovementController } = require('../src/skills/movement-controller')
const { LOCOMOTION_OWNERS } = require('../src/skills/locomotion-arbiter')
const { AutonomousActionRegistry } = require('../src/autonomy/action-registry')

function movementFixture() {
  const pathGoals = []
  const logs = []
  const player = { position: { x: 10, y: 64, z: 10 } }
  const bot = {
    players: { Steve: { entity: player } },
    pathfinder: {
      setMovements() {},
      setGoal(goal, dynamic) { pathGoals.push({ goal, dynamic }) }
    },
    clearControlStates() {},
    chat() {}
  }
  const goalManager = new GoalManager()
  const movement = new MovementController(bot, {
    goalManager,
    logger: { info: message => logs.push(message) }
  })
  movement.initialize({})
  return { bot, movement, goalManager, pathGoals, logs }
}

test('FOLLOW cannot be overridden by autonomy', () => {
  const { movement, pathGoals } = movementFixture()
  movement.follow('Steve')
  const countAfterFollow = pathGoals.length

  const started = movement.startAutonomousMovement({
    type: 'EXPLORE_NEARBY',
    username: 'Steve',
    point: { x: 3, y: 64, z: 3 },
    expectedAutonomyEpoch: movement.getAutonomyEpoch()
  })

  assert.equal(started, false)
  assert.equal(movement.getLocomotionOwner(), LOCOMOTION_OWNERS.PLAYER)
  assert.equal(pathGoals.length, countAfterFollow)
  assert.equal(pathGoals.at(-1).dynamic, true)
})

test('player FOLLOW takes ownership directly from AUTONOMY', () => {
  const { movement, logs } = movementFixture()
  movement.startAutonomousMovement({
    type: 'WANDER_NEAR_PLAYER',
    username: 'Steve',
    point: { x: 2, y: 64, z: 2 },
    expectedAutonomyEpoch: movement.getAutonomyEpoch()
  })
  movement.follow('Steve')

  assert.equal(movement.getLocomotionOwner(), LOCOMOTION_OWNERS.PLAYER)
  assert.ok(logs.some(line => line.includes('[MOVE] AUTONOMY -> PLAYER (FOLLOW)')))
})

test('survival interrupts FOLLOW and reapplies GoalFollow once on resume', () => {
  const { movement, pathGoals, logs } = movementFixture()
  movement.follow('Steve')
  const followGoal = pathGoals.at(-1).goal
  movement.beginOverride('survival')
  movement.setOverrideGoal('survival', { survival: true })
  movement.endOverride('survival')

  assert.equal(movement.getLocomotionOwner(), LOCOMOTION_OWNERS.PLAYER)
  assert.equal(pathGoals.at(-1).dynamic, true)
  assert.notEqual(pathGoals.at(-1).goal, followGoal)
  assert.ok(logs.some(line => line.includes('[MOVE] PLAYER -> SURVIVAL')))
  assert.ok(logs.some(line => line.includes('[MOVE] SURVIVAL -> PLAYER (resume FOLLOW)')))
})

test('presence cannot acquire locomotion during FOLLOW', () => {
  const { movement } = movementFixture()
  movement.follow('Steve')
  assert.equal(movement.startPresenceWalk({ x: 1, y: 64, z: 1 }), false)
  assert.equal(movement.getLocomotionOwner(), LOCOMOTION_OWNERS.PLAYER)
})

test('presence cannot acquire locomotion during survival', () => {
  const { movement } = movementFixture()
  movement.beginOverride('survival')
  assert.equal(movement.startPresenceWalk({ x: 1, y: 64, z: 1 }), false)
  assert.equal(movement.getLocomotionOwner(), LOCOMOTION_OWNERS.SURVIVAL)
})

test('a new autonomy movement request does not cancel an in-progress autonomous goal', () => {
  const { movement, pathGoals } = movementFixture()
  const epoch = movement.getAutonomyEpoch()
  assert.equal(movement.startAutonomousMovement({
    type: 'WANDER_NEAR_PLAYER',
    username: 'Steve',
    point: { x: 2, y: 64, z: 2 },
    expectedAutonomyEpoch: epoch
  }), true)
  const activePath = pathGoals.at(-1).goal
  const count = pathGoals.length

  assert.equal(movement.startAutonomousMovement({
    type: 'EXPLORE_NEARBY',
    username: 'Steve',
    point: { x: 8, y: 64, z: 8 },
    expectedAutonomyEpoch: epoch
  }), false)
  assert.equal(pathGoals.length, count)
  assert.equal(pathGoals.at(-1).goal, activePath)
  assert.equal(movement.getLocomotionOwner(), LOCOMOTION_OWNERS.AUTONOMY)
})

test('player STOP prevents autonomous wandering', () => {
  const { movement, pathGoals } = movementFixture()
  movement.stop()
  const count = pathGoals.length
  assert.equal(movement.startAutonomousMovement({
    type: 'WANDER_NEAR_PLAYER',
    username: 'Steve',
    point: { x: 2, y: 64, z: 2 },
    expectedAutonomyEpoch: movement.getAutonomyEpoch()
  }), false)
  assert.equal(movement.getLocomotionOwner(), LOCOMOTION_OWNERS.PLAYER)
  assert.equal(pathGoals.length, count)
})

test('stale autonomous movement is discarded after a player command invalidates its epoch', async () => {
  let epoch = 4
  let starts = 0
  const movement = {
    isAutonomousMovementActive: () => false,
    canRunAutonomousNonMovement: expected => expected === epoch,
    startAutonomousMovement: () => { starts += 1; return true }
  }
  const registry = new AutonomousActionRegistry({
    bot: {},
    movement,
    goalManager: new GoalManager(),
    speech: { say: () => false },
    journal: { record() {} },
    logger: { info() {} },
    config: {},
    random: () => 0
  })
  const inferenceEpoch = epoch
  epoch += 1
  const result = await registry.execute(
    { action: 'EXPLORE_NEARBY' },
    { player: { username: 'Steve', distance: 3 } },
    { autonomyEpoch: inferenceEpoch }
  )

  assert.equal(result.executed, false)
  assert.equal(result.reason, 'LOCOMOTION_OWNED')
  assert.equal(starts, 0)
})

test('an autonomy tick cannot replace an in-progress autonomous movement goal', async () => {
  let starts = 0
  const registry = new AutonomousActionRegistry({
    bot: {},
    movement: {
      isAutonomousMovementActive: () => true,
      canRunAutonomousNonMovement: () => true,
      startAutonomousMovement: () => { starts += 1; return true }
    },
    goalManager: new GoalManager(),
    speech: { say: () => false },
    journal: { record() {} },
    logger: { info() {} },
    config: {}
  })
  const result = await registry.execute({ action: 'WANDER_NEAR_PLAYER' }, {}, { autonomyEpoch: 1 })
  assert.equal(result.reason, 'AUTONOMOUS_GOAL_IN_PROGRESS')
  assert.equal(starts, 0)
})
