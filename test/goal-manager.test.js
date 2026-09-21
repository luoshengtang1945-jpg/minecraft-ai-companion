const test = require('node:test')
const assert = require('node:assert/strict')
const { GoalManager, GOAL_SOURCES, GOAL_STATES } = require('../src/goals')

test('survival overrides and then resumes an autonomous goal', () => {
  const goals = new GoalManager()
  const autonomous = goals.request({ type: 'EXPLORE_NEARBY', source: GOAL_SOURCES.AUTONOMOUS })
  const survival = goals.request({ type: 'DEFEND', source: GOAL_SOURCES.SURVIVAL, resumable: false })

  assert.equal(autonomous.goal.status, GOAL_STATES.INTERRUPTED)
  assert.equal(goals.current.id, survival.goal.id)
  goals.complete(survival.goal.id)
  assert.equal(goals.current.id, autonomous.goal.id)
  assert.equal(goals.current.status, GOAL_STATES.ACTIVE)
})

test('player commands override and abandon autonomous goals', () => {
  const goals = new GoalManager()
  const autonomous = goals.request({ type: 'WANDER_NEAR_PLAYER', source: GOAL_SOURCES.AUTONOMOUS })
  const player = goals.request({ type: 'FOLLOW_PLAYER', source: GOAL_SOURCES.PLAYER })

  assert.equal(player.accepted, true)
  assert.equal(goals.current.id, player.goal.id)
  assert.equal(autonomous.goal.status, GOAL_STATES.ABANDONED)
})

test('player commands received during survival are deferred and replace suspended autonomy', () => {
  const goals = new GoalManager()
  const autonomous = goals.request({ type: 'EXPLORE_NEARBY', source: GOAL_SOURCES.AUTONOMOUS })
  const survival = goals.request({ type: 'RETREAT', source: GOAL_SOURCES.SURVIVAL, resumable: false })
  const player = goals.request({ type: 'COME_TO_PLAYER', source: GOAL_SOURCES.PLAYER })

  assert.equal(player.accepted, true)
  assert.equal(player.deferred, true)
  assert.equal(goals.current.id, survival.goal.id)
  assert.equal(autonomous.goal.status, GOAL_STATES.ABANDONED)

  goals.complete(survival.goal.id)
  assert.equal(goals.current.id, player.goal.id)
  assert.equal(goals.current.status, GOAL_STATES.ACTIVE)
})

test('autonomous goal lifecycle records completion', () => {
  const goals = new GoalManager()
  const requested = goals.request({ type: 'LOOK_AT_PLAYER', source: GOAL_SOURCES.AUTONOMOUS })
  assert.equal(goals.snapshot().status, GOAL_STATES.ACTIVE)
  assert.equal(goals.complete(requested.goal.id), true)
  assert.equal(goals.snapshot(), null)
  assert.equal(goals.history.at(-1).status, GOAL_STATES.COMPLETED)
})
