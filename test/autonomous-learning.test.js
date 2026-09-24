const test = require('node:test')
const assert = require('node:assert/strict')
const { availableTaskItems } = require('../src/autonomy/task-candidates')
const { createItemGoal } = require('../src/learning/item-goal')
const { validateAutonomousDecision } = require('../src/autonomy/action-schema')
const { AutonomousActionRegistry } = require('../src/autonomy/action-registry')
const { LearningController } = require('../src/learning/learning-controller')
const { AutonomyController } = require('../src/autonomy/autonomy-controller')
const { EventJournal } = require('../src/autonomy/event-journal')
const { GoalManager } = require('../src/goals')
const { EventEmitter } = require('node:events')

function worldState() {
  return {
    companion: { health: 20 }, player: { username: 'Steve', distance: 4 },
    behavior: { locomotionOwner: 'NONE' }, currentGoal: null, freeIdleStreak: 2,
    nearbyEntities: { hostile: [] }, usefulBlocks: ['birch_logx2', 'chestx1', 'oak_logx3']
  }
}

function candidateBot() {
  return {
    registry: { itemsByName: { birch_log: {}, oak_log: {}, chest: {} } },
    inventory: { items: () => [] }
  }
}

test('autonomous task candidates come from observed registered items, not a recipe', () => {
  const state = worldState()
  const bot = candidateBot()
  assert.deepEqual(availableTaskItems(state, bot), ['birch_log', 'oak_log'])
  bot.inventory.items = () => [{ name: 'birch_log', count: 1 }]
  assert.deepEqual(availableTaskItems(state, bot), ['oak_log'])
  assert.deepEqual(availableTaskItems({ usefulBlocks: ['unseen_itemx1', 'bad/pathx1', 'constructorx1'] }, bot), [])
})

test('generic item goal and autonomy action reject code, paths and extra fields', () => {
  assert.deepEqual(createItemGoal('birch_log').objective,
    { type: 'INVENTORY_AT_LEAST', item: 'birch_log', count: 1 })
  assert.equal(validateAutonomousDecision({ action: 'TRY_OBTAIN_ITEM', goalItem: 'birch_log' }).goalItem, 'birch_log')
  assert.throws(() => validateAutonomousDecision({ action: 'TRY_OBTAIN_ITEM', goalItem: '../data' }), /valid goalItem/)
  assert.throws(() => validateAutonomousDecision({ action: 'TRY_OBTAIN_ITEM', goalItem: 'oak_log', code: 'eval(1)' }), /Unexpected/)
  assert.throws(() => validateAutonomousDecision({ action: 'IDLE', goalItem: 'oak_log' }), /only valid/)
})

test('autonomous task is opt-in, health-gated, bounded and still chosen by the model', async () => {
  const bot = candidateBot()
  const movement = {
    isAutonomousMovementActive: () => false,
    canRunAutonomousNonMovement: () => true
  }
  const goals = new GoalManager()
  const actions = new AutonomousActionRegistry({
    bot, movement, goalManager: goals, speech: {}, journal: {}, logger: {},
    config: { taskLearningEnabled: true, taskMaxEpisodes: 1, taskMinHealth: 12, maxPlayerDistance: 16 }
  })
  const queued = []
  actions.setLearningController({ queueAutonomousTask(goal) { queued.push(goal); return true } })
  const state = worldState()
  assert.deepEqual(actions.availableTaskItems(state), ['birch_log', 'oak_log'])
  assert.deepEqual(await actions.execute({ action: 'TRY_OBTAIN_ITEM', goalItem: 'unseen_item' }, state),
    { executed: false, reason: 'TASK_GOAL_NOT_AVAILABLE' })
  assert.equal(queued.length, 0)
  assert.equal((await actions.execute({ action: 'TRY_OBTAIN_ITEM', goalItem: 'birch_log' }, state)).executed, true)
  assert.equal(queued[0].objective.item, 'birch_log')
  assert.deepEqual(actions.availableTaskItems(state), [])

  const disabled = new AutonomousActionRegistry({
    bot, movement, goalManager: goals, speech: {}, journal: {}, logger: {},
    config: { taskLearningEnabled: false, maxPlayerDistance: 16 }
  })
  disabled.setLearningController({ queueAutonomousTask() { throw new Error('must not run') } })
  assert.deepEqual(disabled.availableTaskItems(state), [])
  assert.equal((await disabled.execute({ action: 'TRY_OBTAIN_ITEM', goalItem: 'birch_log' }, state)).executed, false)
})

test('task candidates disappear during danger, player ownership or insufficient idle time', () => {
  const actions = new AutonomousActionRegistry({
    bot: candidateBot(),
    movement: {}, goalManager: new GoalManager(), speech: {}, journal: {}, logger: {},
    config: { taskLearningEnabled: true, taskMaxEpisodes: 1, taskMinHealth: 12, maxPlayerDistance: 16 }
  })
  actions.setLearningController({})
  const state = worldState()
  state.companion.health = 8
  assert.deepEqual(actions.availableTaskItems(state), [])
  state.companion.health = 20
  state.nearbyEntities.hostile = ['zombiex1']
  assert.deepEqual(actions.availableTaskItems(state), [])
  state.nearbyEntities.hostile = []
  state.behavior.locomotionOwner = 'PLAYER'
  assert.deepEqual(actions.availableTaskItems(state), [])
  state.behavior.locomotionOwner = 'NONE'
  state.freeIdleStreak = 1
  assert.deepEqual(actions.availableTaskItems(state), [])
  state.freeIdleStreak = 2
  state.autonomyTrigger = 'hurt'
  assert.deepEqual(actions.availableTaskItems(state), [])
  state.autonomyTrigger = 'interval'
  state.recentEvents = [{ type: 'hurt', at: Date.now() }]
  assert.deepEqual(actions.availableTaskItems(state), [])
})

test('task proposal rechecks live health, player distance and hostile danger after inference', async () => {
  const position = x => ({ x, y: 64, z: 0, distanceTo(other) { return Math.abs(this.x - other.x) } })
  const bot = Object.assign(candidateBot(), {
    health: 20,
    entity: { position: position(0) },
    players: { Steve: { entity: { position: position(4) } } },
    entities: {}
  })
  const queued = []
  const actions = new AutonomousActionRegistry({
    bot,
    movement: { isAutonomousMovementActive: () => false, canRunAutonomousNonMovement: () => true },
    goalManager: new GoalManager(), speech: {}, journal: {}, logger: {},
    config: { taskLearningEnabled: true, taskMaxEpisodes: 1, taskMinHealth: 12,
      maxPlayerDistance: 16, summaryRange: 12 }
  })
  actions.setLearningController({ queueAutonomousTask(goal) { queued.push(goal); return true } })
  const state = worldState()
  const propose = () => actions.execute({ action: 'TRY_OBTAIN_ITEM', goalItem: 'birch_log' }, state)
  bot.health = 8
  assert.equal((await propose()).reason, 'TASK_HEALTH_CHANGED')
  bot.health = 20
  bot.players.Steve.entity.position = position(30)
  assert.equal((await propose()).reason, 'TASK_PLAYER_MOVED_AWAY')
  bot.players.Steve.entity.position = position(4)
  bot.entities[2] = { type: 'hostile', position: position(5) }
  assert.equal((await propose()).reason, 'TASK_DANGER_APPEARED')
  delete bot.entities[2]
  assert.equal((await propose()).executed, true)
  assert.equal(queued.length, 1)
})

test('autonomy can propose one observed generic item goal after two idle decisions', async () => {
  const bot = Object.assign(new EventEmitter(), candidateBot(), { entity: { id: 1 }, time: { timeOfDay: 6000 } })
  const movement = {
    getAutonomyEpoch: () => 0,
    isAutonomousMovementActive: () => false,
    canRunAutonomousNonMovement: () => true
  }
  const goals = new GoalManager()
  const proposals = []
  const actions = new AutonomousActionRegistry({
    bot, movement, goalManager: goals, speech: {}, journal: {}, logger: {},
    config: { taskLearningEnabled: true, taskMaxEpisodes: 1, taskMinHealth: 12, maxPlayerDistance: 16 }
  })
  actions.setLearningController({ queueAutonomousTask(goal) { proposals.push(goal); return true } })
  const controller = new AutonomyController({
    bot, movement, goalManager: goals, actions,
    worldState: { build: worldState, observePlayer() {} },
    client: { async decide(state) {
      return state.availableTaskItems.length
        ? { action: 'TRY_OBTAIN_ITEM', goalItem: state.availableTaskItems[0] }
        : { action: 'IDLE' }
    } },
    journal: new EventJournal(), logger: { info() {}, throttled() {} },
    config: { enabled: true, intervalMs: 600000, eventMinGapMs: 0 }
  })
  controller.start()
  await controller.trigger('interval')
  await controller.trigger('interval')
  assert.equal(proposals.length, 0)
  await controller.trigger('interval')
  controller.stop()
  assert.equal(proposals.length, 1)
  assert.deepEqual(proposals[0].objective, { type: 'INVENTORY_AT_LEAST', item: 'birch_log', count: 1 })
})

test('ordinary speech does not permanently prevent an autonomous task opportunity', async () => {
  const bot = Object.assign(new EventEmitter(), candidateBot(), { entity: { id: 1 }, time: { timeOfDay: 6000 } })
  const movement = {
    getAutonomyEpoch: () => 0,
    isAutonomousMovementActive: () => false,
    canRunAutonomousNonMovement: () => true
  }
  const goals = new GoalManager()
  const proposed = []
  const actions = new AutonomousActionRegistry({
    bot, movement, goalManager: goals, speech: { say: () => true }, journal: {}, logger: {},
    config: { taskLearningEnabled: true, taskMaxEpisodes: 1, taskMinHealth: 12, maxPlayerDistance: 16 }
  })
  actions.setLearningController({ queueAutonomousTask(goal) { proposed.push(goal); return true } })
  const controller = new AutonomyController({
    bot, movement, goalManager: goals, actions,
    worldState: { build: worldState, observePlayer() {} },
    client: { async decide(state) {
      return state.availableTaskItems.length
        ? { action: 'TRY_OBTAIN_ITEM', goalItem: 'birch_log' }
        : { action: 'SAY', message: '今天天气不错', reason: 'small talk' }
    } },
    journal: new EventJournal(), logger: { info() {}, throttled() {} },
    config: { enabled: true, intervalMs: 600000, eventMinGapMs: 0 }
  })
  controller.start()
  await controller.trigger('interval')
  await controller.trigger('interval')
  await controller.trigger('interval')
  controller.stop()
  assert.equal(proposed.length, 1)
})

test('stale model task proposal cannot start after player STOP takes locomotion', async () => {
  const bot = Object.assign(new EventEmitter(), candidateBot(), { entity: { id: 1 }, time: { timeOfDay: 6000 } })
  const movement = {
    owner: 'NONE', epoch: 0,
    getAutonomyEpoch() { return this.epoch },
    isAutonomousMovementActive: () => false,
    canRunAutonomousNonMovement(expected) { return this.owner === 'NONE' && expected === this.epoch }
  }
  const goals = new GoalManager()
  const queued = []
  const actions = new AutonomousActionRegistry({
    bot, movement, goalManager: goals, speech: {}, journal: {}, logger: {},
    config: { taskLearningEnabled: true, taskMaxEpisodes: 1, taskMinHealth: 12, maxPlayerDistance: 16 }
  })
  actions.setLearningController({ queueAutonomousTask(goal) { queued.push(goal); return true } })
  let releaseDecision
  const pendingDecision = new Promise(resolve => { releaseDecision = resolve })
  const controller = new AutonomyController({
    bot, movement, goalManager: goals, actions,
    worldState: { build: worldState, observePlayer() {} },
    client: { decide: async () => pendingDecision },
    journal: new EventJournal(), logger: { info() {}, throttled() {} },
    config: { enabled: true, intervalMs: 600000, eventMinGapMs: 0 }
  })
  controller.start()
  const running = controller.trigger('interval')
  movement.owner = 'PLAYER'
  movement.epoch += 1
  releaseDecision({ action: 'TRY_OBTAIN_ITEM', goalItem: 'birch_log' })
  await running
  controller.stop()
  assert.equal(queued.length, 0)
})

function learningFixture({ load, sleep } = {}) {
  const saved = []
  const suppression = []
  let inventory = {}
  const movement = {
    owner: 'NONE', pending: false,
    getLocomotionOwner() { return this.owner },
    setLearningPending(value) { this.pending = value },
    beginLearningSession() { return this.owner === 'NONE' },
    endLearningSession() {}
  }
  const controller = new LearningController({
    movement, goalManager: new GoalManager(),
    observer: { capture: () => ({ inventory: { ...inventory }, inventoryDelta: {}, nearbyBlocks: [], nearbyEntities: [] }) },
    executor: { async execute() { inventory = { birch_log: 1 }; return { success: true, reason: 'TEST' } } },
    client: { async decide() { return { action: 'OBSERVE' } }, async reflect() { return { reflection: 'x', lesson: 'y', nextApproach: 'z' } } },
    memory: { load: load || (async () => {}), findRelevantSkills: () => [], async recordEpisode(episode) { saved.push(episode) } },
    autonomy: { setSuppressed(value) { suppression.push(value) } },
    logger: { info() {}, error() {} },
    config: { enabled: false, maxActions: 3, maxDurationMs: 10000, repeatedActionLimit: 3, exploreRadius: 16 },
    sleep: sleep || (async () => {})
  })
  return { controller, movement, saved, suppression }
}

test('generic autonomous item episode uses the existing evaluator and finishes on inventory evidence', async () => {
  const fixture = learningFixture()
  assert.equal(fixture.controller.queueAutonomousTask(createItemGoal('birch_log')), true)
  for (let index = 0; index < 10 && !fixture.saved.length; index += 1) await new Promise(resolve => setImmediate(resolve))
  assert.equal(fixture.saved[0]?.outcome, 'SUCCESS')
  assert.equal(fixture.saved[0]?.goal.objective.item, 'birch_log')
  assert.equal(fixture.movement.pending, false)
  assert.equal(fixture.suppression.at(-1), false)
})

test('player cancels a pending autonomous task before memory load resolves', async () => {
  let releaseLoad
  const fixture = learningFixture({ load: () => new Promise(resolve => { releaseLoad = resolve }) })
  assert.equal(fixture.controller.queueAutonomousTask(createItemGoal('birch_log')), true)
  assert.equal(fixture.controller.isAutonomousTaskActive(), true)
  assert.equal(fixture.movement.pending, true)
  assert.equal(fixture.controller.cancel('PLAYER_MOVEMENT_COMMAND'), true)
  fixture.movement.owner = 'PLAYER'
  releaseLoad()
  for (let index = 0; index < 3; index += 1) await new Promise(resolve => setImmediate(resolve))
  assert.equal(fixture.saved.length, 0)
  assert.equal(fixture.controller.isAutonomousTaskActive(), false)
  assert.equal(fixture.movement.pending, false)
  assert.equal(fixture.suppression.at(-1), false)
})

test('bot shutdown prevents a late autonomous proposal from starting an episode', () => {
  const fixture = learningFixture()
  fixture.controller.stop()
  assert.equal(fixture.controller.queueAutonomousTask(createItemGoal('birch_log')), false)
  assert.equal(fixture.controller.isAutonomousTaskActive(), false)
})

test('a player-requested learning goal replaces a pending autonomous proposal', async () => {
  let releaseLoad
  const fixture = learningFixture({ load: () => new Promise(resolve => { releaseLoad = resolve }) })
  assert.equal(fixture.controller.queueAutonomousTask(createItemGoal('birch_log')), true)
  const player = fixture.controller.startPlayerTask({
    username: 'Steve', message: '帮我找木头',
    goal: createItemGoal('birch_log', { source: 'PLAYER_TASK' })
  })
  releaseLoad()
  const episode = await player
  assert.equal(episode.outcome, 'SUCCESS')
  assert.equal(episode.goal.source, 'PLAYER_TASK')
  assert.deepEqual(fixture.saved.map(saved => saved.goal.source), ['PLAYER_TASK'])
  assert.equal(fixture.suppression.at(-1), false)
})

test('survival pauses a pending autonomous task until locomotion is released', async () => {
  let releaseLoad
  let releaseSurvival
  let waiting = false
  const fixture = learningFixture({
    load: () => new Promise(resolve => { releaseLoad = resolve }),
    sleep: async () => { waiting = true; await new Promise(resolve => { releaseSurvival = resolve }) }
  })
  assert.equal(fixture.controller.queueAutonomousTask(createItemGoal('birch_log')), true)
  fixture.movement.owner = 'SURVIVAL'
  releaseLoad()
  for (let index = 0; index < 3 && !waiting; index += 1) await new Promise(resolve => setImmediate(resolve))
  assert.equal(waiting, true)
  assert.equal(fixture.saved.length, 0)
  fixture.movement.owner = 'NONE'
  releaseSurvival()
  for (let index = 0; index < 10 && !fixture.saved.length; index += 1) await new Promise(resolve => setImmediate(resolve))
  assert.equal(fixture.saved[0]?.outcome, 'SUCCESS')
})
