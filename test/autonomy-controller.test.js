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

test('next autonomy decision sees grounded outcome of the previous autonomous goal', async () => {
  const bot = new EventEmitter()
  bot.entity = { id: 1 }
  bot.time = { timeOfDay: 0 }
  const goals = new GoalManager()
  const seen = []
  const controller = new AutonomyController({
    bot,
    worldState: { build: () => ({}), observePlayer() {} },
    client: { async decide(state) { seen.push(state); return { action: 'IDLE' } } },
    actions: { async execute() { return { executed: false, reason: 'IDLE' } } },
    movement: { getAutonomyEpoch: () => 0 },
    goalManager: goals,
    journal: new EventJournal(),
    logger: { info() {}, throttled() {} },
    config: { enabled: true, intervalMs: 600000, eventMinGapMs: 0 }
  })
  controller.start()
  const goal = goals.request({ type: 'EXPLORE_NEARBY', source: GOAL_SOURCES.AUTONOMOUS }).goal
  goals.complete(goal.id, 'FAILED', { reason: 'NO_PATH' })
  await new Promise(resolve => setImmediate(resolve))
  if (!seen.length) await controller.trigger('test')
  controller.stop()
  assert.deepEqual(seen.at(-1).recentAutonomousOutcomes.at(-1), {
    action: 'EXPLORE_NEARBY', outcome: 'FAILED', reason: 'NO_PATH', at: seen.at(-1).recentAutonomousOutcomes.at(-1).at
  })
})

test('autonomy reconsideration resumes once after a learning episode releases suppression', async () => {
  const bot = new EventEmitter()
  bot.entity = { id: 1 }
  bot.time = { timeOfDay: 6000 }
  const reasons = []
  const controller = new AutonomyController({
    bot,
    worldState: { build: () => ({ behavior: { locomotionOwner: 'NONE' }, currentGoal: null }), observePlayer() {} },
    client: { async decide(state) { reasons.push(state.autonomyTrigger); return { action: 'IDLE' } } },
    actions: { async execute() { return { executed: false, reason: 'IDLE' } } },
    movement: { getAutonomyEpoch: () => 0, invalidateAutonomy() {} },
    goalManager: new GoalManager(), journal: new EventJournal(),
    logger: { info() {}, throttled() {} },
    config: { enabled: true, intervalMs: 600000, eventMinGapMs: 0 }
  })
  controller.start()
  controller.setSuppressed(true, 'learning_episode')
  controller.setSuppressed(false, 'learning_episode')
  await new Promise(resolve => setImmediate(resolve))
  controller.stop()
  assert.deepEqual(reasons, ['resumed'])
})

test('releasing suppression after disconnect never starts a new autonomy inference', async () => {
  const bot = new EventEmitter()
  bot.entity = { id: 1 }
  bot.time = { timeOfDay: 6000 }
  let decisions = 0
  const controller = new AutonomyController({
    bot,
    worldState: { build: () => ({ behavior: { locomotionOwner: 'NONE' }, currentGoal: null }), observePlayer() {} },
    client: { async decide() { decisions += 1; return { action: 'IDLE' } } },
    actions: { async execute() { return { executed: false, reason: 'IDLE' } } },
    movement: { getAutonomyEpoch: () => 0, invalidateAutonomy() {} },
    goalManager: new GoalManager(), journal: new EventJournal(),
    logger: { info() {}, throttled() {} },
    config: { enabled: true, intervalMs: 600000, eventMinGapMs: 0 }
  })
  controller.start()
  controller.setSuppressed(true, 'learning_episode')
  controller.stop()
  controller.setSuppressed(false, 'learning_episode')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(decisions, 0)
})

test('free idle streak invites initiative but resets on player chat', async () => {
  const bot = new EventEmitter()
  bot.entity = { id: 1 }
  bot.time = { timeOfDay: 0 }
  const streaks = []
  const controller = new AutonomyController({
    bot,
    worldState: {
      build: () => ({ behavior: { locomotionOwner: 'NONE' }, currentGoal: null }),
      observePlayer() {}
    },
    client: { async decide(state) { streaks.push(state.freeIdleStreak); return { action: 'IDLE' } } },
    actions: { async execute() { return { executed: false, reason: 'IDLE' } } },
    movement: { getAutonomyEpoch: () => 0 },
    goalManager: new GoalManager(),
    journal: new EventJournal(),
    logger: { info() {}, throttled() {} },
    config: { enabled: true, intervalMs: 600000, eventMinGapMs: 0 }
  })
  controller.start()
  await controller.trigger('interval')
  await controller.trigger('interval')
  await controller.trigger('interval')
  controller.observePlayer('Steve', '跟着我')
  await controller.trigger('interval')
  controller.setSuppressed(true, 'learning_episode')
  controller.setSuppressed(false, 'learning_episode')
  await controller.trigger('interval')
  controller.stop()
  assert.deepEqual(streaks, [0, 1, 2, 0, 0])
})

test('rejected repetitive speech defers routine player-owned inference but fresh events may still speak', async () => {
  const bot = new EventEmitter()
  bot.entity = { id: 1 }
  bot.time = { timeOfDay: 6000 }
  const decisions = []
  const controller = new AutonomyController({
    bot,
    worldState: {
      build: () => ({ behavior: { locomotionOwner: 'PLAYER' }, companionSession: { speech: { eligible: true } } }),
      observePlayer() {}
    },
    client: { async decide(state) { decisions.push(state); return { action: 'SAY', message: '老话重提' } } },
    actions: { async execute() { return { executed: false, reason: 'RECENT_TEXT' } } },
    movement: { getAutonomyEpoch: () => 0 },
    goalManager: new GoalManager(), journal: new EventJournal(),
    logger: { info() {}, throttled() {} },
    config: { enabled: true, intervalMs: 600000, eventMinGapMs: 0 }
  })
  controller.start()
  await controller.trigger('interval')
  await controller.trigger('interval')
  assert.equal(decisions.length, 1)
  await controller.trigger('weather')
  controller.stop()
  assert.equal(decisions.length, 2)
  assert.equal(decisions[1].autonomousSpeechAllowed, true)
})
