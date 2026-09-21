const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { GoalManager, GOAL_SOURCES } = require('../src/goals')
const { EventJournal } = require('../src/autonomy/event-journal')
const { AutonomyController } = require('../src/autonomy/autonomy-controller')
const { AutonomousActionRegistry } = require('../src/autonomy/action-registry')

test('survival starting during inference prevents the autonomous action', async () => {
  const bot = new EventEmitter()
  bot.entity = { id: 1 }
  bot.time = { timeOfDay: 0 }
  const goals = new GoalManager()
  const journal = new EventJournal()
  let releaseInference
  let actionCount = 0
  const inference = new Promise(resolve => { releaseInference = resolve })
  const controller = new AutonomyController({
    bot,
    worldState: { build: () => ({ currentGoal: null }), observePlayer() {} },
    client: { decide: async () => inference },
    actions: { execute: async () => { actionCount += 1; return { executed: true } } },
    movement: { getAutonomyEpoch: () => 0, isAutonomousMovementActive: () => false },
    goalManager: goals,
    journal,
    logger: { info() {}, throttled() {} },
    config: { enabled: true, intervalMs: 600000, eventMinGapMs: 0 }
  })

  controller.start()
  const pending = controller.trigger('test')
  await Promise.resolve()
  goals.request({ type: 'DEFEND', source: GOAL_SOURCES.SURVIVAL, resumable: false })
  releaseInference({ action: 'IDLE' })
  await pending
  controller.stop()

  assert.equal(actionCount, 0)
})

test('pending autonomy inference cannot execute movement after FOLLOW takes ownership', async () => {
  const bot = new EventEmitter()
  bot.entity = { id: 1 }
  bot.time = { timeOfDay: 0 }
  bot.players = { Steve: { entity: {} } }
  const goals = new GoalManager()
  const journal = new EventJournal()
  let releaseInference
  let autonomousStarts = 0
  const inference = new Promise(resolve => { releaseInference = resolve })
  const movement = {
    epoch: 0,
    owner: 'NONE',
    getAutonomyEpoch() { return this.epoch },
    isAutonomousMovementActive: () => false,
    canRunAutonomousNonMovement(expected) {
      return this.owner === 'NONE' && expected === this.epoch
    },
    follow(username, { expectedAutonomyEpoch }) {
      if (!this.canRunAutonomousNonMovement(expectedAutonomyEpoch)) return false
      autonomousStarts += 1
      return true
    }
  }
  const actions = new AutonomousActionRegistry({
    bot,
    movement,
    goalManager: goals,
    speech: { say: () => false },
    journal,
    logger: { info() {} },
    config: {}
  })
  const controller = new AutonomyController({
    bot,
    worldState: {
      build: () => ({ player: { username: 'Steve', distance: 2 } }),
      observePlayer() {}
    },
    client: { decide: async () => inference },
    actions,
    movement,
    goalManager: goals,
    journal,
    logger: { info() {}, throttled() {} },
    config: { enabled: true, intervalMs: 600000, eventMinGapMs: 0 }
  })

  controller.start()
  const pending = controller.trigger('test')
  await Promise.resolve()
  movement.epoch += 1
  movement.owner = 'PLAYER'
  releaseInference({ action: 'FOLLOW_PLAYER' })
  await pending
  controller.stop()

  assert.equal(autonomousStarts, 0)
})
