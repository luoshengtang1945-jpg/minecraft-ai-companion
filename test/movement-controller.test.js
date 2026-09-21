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
