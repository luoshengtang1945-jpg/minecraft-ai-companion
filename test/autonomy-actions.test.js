const test = require('node:test')
const assert = require('node:assert/strict')
const {
  validateAutonomousDecision,
  parseAutonomousDecision
} = require('../src/autonomy/action-schema')
const { AutonomousActionRegistry } = require('../src/autonomy/action-registry')
const { GoalManager, GOAL_SOURCES } = require('../src/goals')

test('autonomous action validation accepts the initial extensible action set', () => {
  for (const action of [
    'IDLE',
    'FOLLOW_PLAYER',
    'WANDER_NEAR_PLAYER',
    'LOOK_AT_PLAYER',
    'COME_TO_PLAYER',
    'EXPLORE_NEARBY',
    'SAY',
    'WAIT'
  ]) {
    assert.equal(validateAutonomousDecision({ action }).action, action)
  }
})

test('autonomous action validation rejects unknown capabilities', () => {
  assert.throws(() => parseAutonomousDecision('{"action":"MINE"}'), /Invalid autonomous action/)
})

test('autonomous wait duration is bounded', () => {
  assert.equal(validateAutonomousDecision({ action: 'WAIT', durationMs: 999999 }).durationMs, 30000)
  assert.equal(validateAutonomousDecision({ action: 'WAIT', durationMs: 1 }).durationMs, 1000)
})

test('completed casual movement cools down without inventing a replacement action', async () => {
  let now = 100000
  const goalManager = new GoalManager({ now: () => now })
  const goal = goalManager.request({ type: 'WANDER_NEAR_PLAYER', source: GOAL_SOURCES.AUTONOMOUS }).goal
  goalManager.complete(goal.id)
  now += 10000
  const actions = new AutonomousActionRegistry({
    bot: { players: { Steve: { entity: { position: {} } } } },
    movement: { isAutonomousMovementActive: () => false, canRunAutonomousNonMovement: () => true },
    goalManager,
    speech: {}, journal: {}, logger: {},
    config: { maxPlayerDistance: 16, moveCooldownMs: 90000 },
    now: () => now
  })
  assert.equal(actions.movementCooldownRemainingMs(), 80000)
  const result = await actions.execute({ action: 'WANDER_NEAR_PLAYER' },
    { player: { username: 'Steve', distance: 2 } })
  assert.deepEqual(result, { executed: false, reason: 'RECENT_AUTONOMOUS_MOVE' })
  now += 80000
  assert.equal(actions.movementCooldownRemainingMs(), 0)
})

test('a finished autonomous FOLLOW cannot immediately restart itself', async () => {
  let now = 100000
  const goalManager = new GoalManager({ now: () => now })
  const goal = goalManager.request({ type: 'FOLLOW_PLAYER', source: GOAL_SOURCES.AUTONOMOUS }).goal
  goalManager.complete(goal.id, 'COMPLETED', { reason: 'FOLLOW_INTERVAL_ENDED' })
  now += 10000
  let follows = 0
  const actions = new AutonomousActionRegistry({
    bot: {},
    movement: {
      isAutonomousMovementActive: () => false,
      canRunAutonomousNonMovement: () => true,
      follow() { follows += 1; return true }
    },
    goalManager,
    speech: {}, journal: {}, logger: {},
    config: { followCooldownMs: 180000, followDurationMs: 120000 },
    now: () => now
  })
  const state = { player: { username: 'Steve' } }
  assert.equal(actions.followCooldownRemainingMs(), 170000)
  assert.deepEqual(await actions.execute({ action: 'FOLLOW_PLAYER' }, state),
    { executed: false, reason: 'RECENT_AUTONOMOUS_FOLLOW' })
  assert.equal(follows, 0)
  now += 170000
  assert.equal((await actions.execute({ action: 'FOLLOW_PLAYER' }, state)).executed, true)
  assert.equal(follows, 1)
})
