const test = require('node:test')
const assert = require('node:assert/strict')
const { MovementController } = require('../src/skills/movement-controller')
const { GoalManager, GOAL_SOURCES } = require('../src/goals')

function createFixture() {
  const goals = []
  const player = { position: { x: 10, y: 64, z: 10 } }
  const bot = {
    players: { Steve: { entity: player } },
    pathfinder: {
      setMovements() {},
      setGoal(goal, dynamic) { goals.push({ goal, dynamic }) }
    },
    clearControlStates() {},
    chat() {}
  }
  const logger = { info() {} }
  const movement = new MovementController(bot, { logger })
  movement.initialize({})
  return { movement, goals }
}

test('FOLLOW resumes after a survival override ends', () => {
  const { movement, goals } = createFixture()
  movement.follow('Steve')
  movement.beginOverride('survival')
  movement.setOverrideGoal('survival', null)
  movement.endOverride('survival')

  assert.equal(movement.behavior.type, 'FOLLOW')
  assert.equal(goals.at(-1).dynamic, true)
})

test('player FOLLOW preempts autonomous learning movement without a late path reset', () => {
  const { movement, goals } = createFixture()
  assert.equal(movement.beginLearningSession(GOAL_SOURCES.AUTONOMOUS), true)
  assert.equal(movement.startLearningMovement({ x: 2, y: 64, z: 2 }, 1), true)
  assert.equal(movement.getLocomotionOwner(), 'AUTONOMY')
  assert.equal(movement.follow('Steve'), true)
  const followGoal = goals.at(-1)
  assert.equal(movement.getLocomotionOwner(), 'PLAYER')
  movement.endLearningSession()
  assert.equal(movement.getLocomotionOwner(), 'PLAYER')
  assert.equal(goals.at(-1), followGoal)
  assert.equal(movement.getBehaviorSummary().type, 'FOLLOW')
})

test('STOP received during combat remains stopped afterwards', () => {
  const { movement, goals } = createFixture()
  movement.follow('Steve')
  movement.beginOverride('survival')
  movement.stop()
  movement.endOverride('survival')

  assert.equal(movement.behavior.type, 'STOP')
  assert.equal(goals.at(-1).goal, null)
})

test('abandoning an autonomous goal clears its movement behavior', () => {
  const goalManager = new GoalManager()
  const goals = []
  const bot = {
    players: { Steve: { entity: { position: { x: 1, y: 64, z: 1 } } } },
    pathfinder: {
      setMovements() {},
      setGoal(goal, dynamic) { goals.push({ goal, dynamic }) }
    },
    clearControlStates() {},
    chat() {}
  }
  const movement = new MovementController(bot, { logger: { info() {} }, goalManager })
  movement.initialize({})
  movement.follow('Steve', { source: GOAL_SOURCES.AUTONOMOUS })
  goalManager.request({ type: 'WAIT', source: GOAL_SOURCES.AUTONOMOUS })

  assert.equal(movement.behavior.type, 'STOP')
  assert.equal(goals.at(-1).goal, null)
})

function createAutonomousFixture() {
  const goalManager = new GoalManager()
  const pathGoals = []
  let tick = null
  let x = 0
  const position = () => ({ x, y: 64, z: 0, clone: position,
    distanceTo(other) { return Math.abs(this.x - other.x) } })
  const bot = {
    entity: { get position() { return position() } },
    players: {},
    pathfinder: { setMovements() {}, setGoal(goal) { pathGoals.push(goal) } },
    clearControlStates() {}
  }
  const movement = new MovementController(bot, {
    logger: { info() {} }, goalManager,
    autonomousMoveTimeoutMs: 20000,
    setIntervalFn(callback) { tick = callback; return 1 },
    clearIntervalFn() { tick = null }
  })
  movement.initialize({})
  const start = () => movement.startAutonomousMovement({
    type: 'EXPLORE_NEARBY', point: { x: 5, y: 64, z: 0 },
    expectedAutonomyEpoch: movement.getAutonomyEpoch()
  })
  return { movement, goalManager, pathGoals, start, tick: () => tick?.(), moveTo: value => { x = value } }
}

test('autonomous move reports reached only after pathfinder reaches its goal', () => {
  const fixture = createAutonomousFixture()
  assert.equal(fixture.start(), true)
  assert.equal(fixture.goalManager.current.status, 'ACTIVE')
  fixture.movement.handleGoalReached()
  assert.equal(fixture.goalManager.history.at(-1).status, 'COMPLETED')
  assert.deepEqual(fixture.goalManager.history.at(-1).result, { reason: 'GOAL_REACHED' })
  assert.equal(fixture.tick(), undefined)
})

test('noPath fails only the active autonomous move and releases locomotion', () => {
  const fixture = createAutonomousFixture()
  fixture.start()
  assert.equal(fixture.movement.handlePathUpdate({ status: 'noPath' }), true)
  assert.equal(fixture.goalManager.history.at(-1).status, 'FAILED')
  assert.deepEqual(fixture.goalManager.history.at(-1).result, { reason: 'NO_PATH' })
  assert.equal(fixture.movement.getLocomotionOwner(), 'NONE')
  assert.equal(fixture.pathGoals.at(-1), null)
  assert.equal(fixture.movement.handlePathUpdate({ status: 'noPath' }), false)
})

test('stalled autonomous movement ends, but survival time does not count as stalled', () => {
  const fixture = createAutonomousFixture()
  fixture.start()
  fixture.movement.beginOverride('survival')
  for (let index = 0; index < 12; index += 1) fixture.tick()
  assert.equal(fixture.goalManager.current.status, 'ACTIVE')
  fixture.movement.endOverride('survival')
  for (let index = 0; index < 8; index += 1) fixture.tick()
  assert.equal(fixture.goalManager.history.at(-1).result.reason, 'STALLED')
})

test('finite autonomous movement times out even when making incremental progress', () => {
  const fixture = createAutonomousFixture()
  fixture.start()
  for (let index = 1; index <= 10; index += 1) {
    fixture.moveTo(index)
    fixture.tick()
  }
  assert.equal(fixture.goalManager.history.at(-1).result.reason, 'MOVE_TIMEOUT')
  assert.equal(fixture.movement.getLocomotionOwner(), 'NONE')
})

test('noPath cannot cancel player FOLLOW after autonomy was preempted', () => {
  const fixture = createAutonomousFixture()
  fixture.start()
  fixture.movement.bot.players.Steve = { entity: { position: { x: 3, y: 64, z: 0 } } }
  fixture.movement.follow('Steve')
  assert.equal(fixture.movement.handlePathUpdate({ status: 'noPath' }), false)
  assert.equal(fixture.movement.getLocomotionOwner(), 'PLAYER')
  assert.equal(fixture.movement.getBehaviorSummary().type, 'FOLLOW')
})

test('model-started FOLLOW is a smooth bounded interval while player FOLLOW is persistent', () => {
  const fixture = createAutonomousFixture()
  fixture.movement.bot.players.Steve = { entity: { position: { x: 3, y: 64, z: 0 } } }
  assert.equal(fixture.movement.follow('Steve', {
    source: GOAL_SOURCES.AUTONOMOUS,
    expectedAutonomyEpoch: fixture.movement.getAutonomyEpoch(),
    maxDurationMs: 6000
  }), true)
  fixture.movement.beginOverride('survival')
  for (let index = 0; index < 5; index += 1) fixture.tick()
  assert.equal(fixture.movement.getBehaviorSummary().type, 'FOLLOW')
  fixture.movement.endOverride('survival')
  fixture.tick()
  fixture.tick()
  assert.equal(fixture.movement.getBehaviorSummary().type, 'FOLLOW')
  fixture.tick()
  assert.equal(fixture.goalManager.history.at(-1).result.reason, 'FOLLOW_INTERVAL_ENDED')
  assert.equal(fixture.movement.getLocomotionOwner(), 'NONE')

  fixture.movement.follow('Steve')
  for (let index = 0; index < 100; index += 1) fixture.tick()
  assert.equal(fixture.movement.getBehaviorSummary().type, 'FOLLOW')
  assert.equal(fixture.movement.getLocomotionOwner(), 'PLAYER')
})

test('player FOLLOW abandons autonomous move and invalidates its watchdog', () => {
  const fixture = createAutonomousFixture()
  fixture.start()
  fixture.movement.bot.players.Steve = { entity: { position: { x: 3, y: 64, z: 0 } } }
  fixture.movement.follow('Steve')
  for (let index = 0; index < 20; index += 1) fixture.tick()
  assert.equal(fixture.movement.getBehaviorSummary().type, 'FOLLOW')
  assert.equal(fixture.movement.getLocomotionOwner(), 'PLAYER')
  assert.equal(fixture.goalManager.history.at(-1).status, 'ABANDONED')
})
