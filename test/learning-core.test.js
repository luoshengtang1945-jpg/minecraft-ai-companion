const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const {
  validatePrimitiveAction,
  parsePrimitiveAction,
  LearningEpisode,
  EPISODE_OUTCOMES,
  EpisodeBudget,
  evaluateAttempt,
  objectiveSatisfied,
  EVALUATION,
  LearningMemoryStore,
  LearningOllamaClient,
  LearningObservationBuilder,
  OAK_LOG_EXPERIMENT
} = require('../src/learning')
const { inventoryDelta } = require('../src/learning/observation')

function observation(inventory = {}, extra = {}) {
  return {
    position: { x: 0, y: 64, z: 0 },
    health: 20,
    food: 20,
    inventory,
    inventoryDelta: {},
    nearbyBlocks: [],
    nearbyEntities: [],
    targetState: null,
    ...extra
  }
}

function successfulEpisode() {
  const initial = observation()
  const episode = new LearningEpisode({ id: 'episode-test', goal: OAK_LOG_EXPERIMENT, initialObservation: initial, startedAt: 100 })
  episode.addAttempt({
    observationBefore: initial,
    action: { action: 'MOVE_NEAR', target: 'block:1,64,1', distance: 2 },
    observationAfter: initial,
    actionResult: { success: true },
    evaluation: { status: EVALUATION.NO_PROGRESS }
  })
  episode.addAttempt({
    observationBefore: initial,
    action: { action: 'DIG_BLOCK', target: 'block:1,64,1' },
    observationAfter: observation({ oak_log: 1 }, { inventoryDelta: { oak_log: 1 } }),
    actionResult: { success: true },
    evaluation: { status: EVALUATION.SUCCESS }
  })
  episode.finish(EPISODE_OUTCOMES.SUCCESS, 'OBJECTIVE_CONFIRMED', { finishedAt: 200 })
  return episode
}

test('primitive action schema accepts only allowlisted strict actions', () => {
  assert.deepEqual(validatePrimitiveAction({ action: 'MOVE_NEAR', target: 'block:1,64,-2', distance: 2 }), {
    action: 'MOVE_NEAR', target: 'block:1,64,-2', distance: 2
  })
  assert.equal(parsePrimitiveAction('```json\n{"action":"OBSERVE"}\n```').action, 'OBSERVE')
  assert.equal(validatePrimitiveAction({ action: 'USE_ITEM' }).action, 'USE_ITEM')
  assert.throws(() => validatePrimitiveAction({ action: 'START_DIG', target: 'block:1,64,1' }), /not allowlisted/)
})

test('primitive action schema rejects arbitrary tools, code, and extra arguments', () => {
  assert.throws(() => validatePrimitiveAction({ action: 'RUN_SHELL', command: 'whoami' }), /not allowlisted/)
  assert.throws(() => validatePrimitiveAction({ action: 'WAIT', durationMs: 100, path: '.env' }), /Unexpected/)
  assert.throws(() => validatePrimitiveAction({ action: 'DIG_BLOCK', target: 'file:.env' }), /observed/)
  assert.throws(() => parsePrimitiveAction('{"action":"OBSERVE"}\n{"action":"STOP"}'))
})

test('learning client permits only one inference at a time', async t => {
  const originalFetch = global.fetch
  let release
  global.fetch = async () => await new Promise(resolve => { release = resolve })
  t.after(() => { global.fetch = originalFetch })
  const client = new LearningOllamaClient({ ollama: { url: 'http://local.test', model: 'test', timeoutMs: 10000 } })
  const context = { goal: OAK_LOG_EXPERIMENT, observation: observation(), attempts: [], learnedSkills: [] }
  const first = client.decide(context)
  while (!release) await Promise.resolve()
  await assert.rejects(client.decide(context), /already running/)
  release({ ok: true, json: async () => ({ message: { content: '{"action":"OBSERVE"}' } }) })
  assert.equal((await first).action, 'OBSERVE')
})

test('episode lifecycle records attempts and cannot accept attempts after finishing', () => {
  const episode = successfulEpisode()
  assert.equal(episode.attempts.length, 2)
  assert.equal(episode.outcome, EPISODE_OUTCOMES.SUCCESS)
  assert.equal(episode.durationMs, 100)
  assert.throws(() => episode.addAttempt({}), /finished/)
})

test('objective success requires observed inventory evidence', () => {
  const initial = observation()
  const after = observation({ oak_log: 1 }, { inventoryDelta: { oak_log: 1 } })
  assert.equal(objectiveSatisfied(OAK_LOG_EXPERIMENT, after, initial), true)
  assert.equal(evaluateAttempt({
    goal: OAK_LOG_EXPERIMENT,
    initialObservation: initial,
    observationBefore: initial,
    observationAfter: after,
    actionResult: { success: true }
  }).status, EVALUATION.SUCCESS)
})

test('inventory delta reports additions and removals', () => {
  assert.deepEqual(inventoryDelta({ dirt: 2, stick: 1 }, { dirt: 1, oak_log: 1 }), {
    dirt: -1, stick: -1, oak_log: 1
  })
})

test('learning observation exposes grounded block refs, held item, goal, and prior result', () => {
  const positions = [{ x: 0, y: 63, z: 0 }, { x: 3, y: 64, z: 0 }]
  const bot = {
    entity: { id: 1, position: { x: 0, y: 64, z: 0 } },
    health: 20,
    food: 18,
    heldItem: { name: 'wooden_axe', count: 1, slot: 36 },
    quickBarSlot: 0,
    inventory: { items: () => [], slots: [{}, ...Array(35), { name: 'wooden_axe', count: 1 }] },
    entities: {},
    findBlocks: () => positions,
    blockAt: position => ({ name: position.x === 3 ? 'oak_log' : 'grass_block', position }),
    canDigBlock: () => true
  }
  const builder = new LearningObservationBuilder({ bot, range: 8, now: () => 100 })
  const state = builder.capture({
    startedAt: 50,
    goal: OAK_LOG_EXPERIMENT,
    previousActionResult: { success: false, reason: 'NO_PATH' },
    recentProgress: [{ action: 'MOVE_NEAR', evaluation: 'NO_PROGRESS' }]
  })

  assert.equal(state.nearbyBlocks.find(block => block.name === 'oak_log').ref, 'block:3,64,0')
  assert.equal(state.heldItem.name, 'wooden_axe')
  assert.equal(state.heldItem.selectedHotbarSlot, 0)
  assert.equal(state.hotbar[0].name, 'wooden_axe')
  assert.equal(state.currentGoal.objective.item, 'oak_log')
  assert.equal(state.previousActionResult.reason, 'NO_PATH')
  assert.equal(state.recentProgress.length, 1)
})

test('successful action with unchanged observations is NO_PROGRESS', () => {
  const initial = observation()
  const result = evaluateAttempt({
    goal: OAK_LOG_EXPERIMENT,
    initialObservation: initial,
    observationBefore: initial,
    observationAfter: observation(),
    actionResult: { success: true }
  })
  assert.equal(result.status, EVALUATION.NO_PROGRESS)
})

test('evaluator distinguishes primitive failure and partial objective progress', () => {
  const initial = observation()
  assert.equal(evaluateAttempt({
    goal: OAK_LOG_EXPERIMENT,
    initialObservation: initial,
    observationBefore: initial,
    observationAfter: observation(),
    actionResult: { success: false, reason: 'NO_PATH' }
  }).status, EVALUATION.FAILURE)

  const largerGoal = { ...OAK_LOG_EXPERIMENT, objective: { type: 'INVENTORY_AT_LEAST', item: 'oak_log', count: 2 } }
  assert.equal(evaluateAttempt({
    goal: largerGoal,
    initialObservation: initial,
    observationBefore: initial,
    observationAfter: observation({ oak_log: 1 }, { inventoryDelta: { oak_log: 1 } }),
    actionResult: { success: true }
  }).status, EVALUATION.PARTIAL_PROGRESS)
})

test('model or primitive cannot declare false success', () => {
  const initial = observation()
  const result = evaluateAttempt({
    goal: OAK_LOG_EXPERIMENT,
    initialObservation: initial,
    observationBefore: initial,
    observationAfter: observation(),
    actionResult: { success: true, declaredOutcome: 'SUCCESS' }
  })
  assert.equal(result.status, EVALUATION.NO_PROGRESS)
})

test('symbolic intention discovery requires confirming observation and never grants objective success', () => {
  const initial = observation()
  const evidence = { ref: 'block:5,64,0', name: 'synthetic_target' }
  const args = { goal: OAK_LOG_EXPERIMENT, initialObservation: initial, observationBefore: initial,
    actionResult: { success: true, reason: 'SYMBOLIC_DISCOVERY', evidence: [evidence] } }
  assert.equal(evaluateAttempt({ ...args, observationAfter: observation() }).status, EVALUATION.NO_PROGRESS)
  assert.equal(evaluateAttempt({ ...args, observationAfter: observation({}, { nearbyBlocks: [evidence] }) }).status, EVALUATION.PARTIAL_PROGRESS)
})

test('episode budget enforces action count, time, and repeated failures', () => {
  const make = () => new LearningEpisode({ id: 'budget', goal: OAK_LOG_EXPERIMENT, initialObservation: observation(), startedAt: 0 })
  const actionLimited = make()
  actionLimited.attempts = [{ action: { action: 'OBSERVE' }, evaluation: { status: EVALUATION.NO_PROGRESS } }]
  assert.equal(new EpisodeBudget({ maxActions: 1, maxDurationMs: 1000, repeatedActionLimit: 3, now: () => 10 }).check(actionLimited).reason, 'ACTION_BUDGET_EXCEEDED')

  assert.equal(new EpisodeBudget({ maxActions: 5, maxDurationMs: 100, repeatedActionLimit: 3, now: () => 100 }).check(make()).reason, 'TIME_BUDGET_EXCEEDED')

  const repeated = make()
  repeated.attempts = [1, 2, 3].map(() => ({ action: { action: 'OBSERVE' }, evaluation: { status: EVALUATION.NO_PROGRESS } }))
  assert.equal(new EpisodeBudget({ maxActions: 10, maxDurationMs: 1000, repeatedActionLimit: 3, now: () => 10 }).check(repeated).reason, 'REPEATED_ACTION_LIMIT')
})

test('memory persists episodes, derives and retrieves a skill from actual successful steps', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'companion-learning-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const filePath = path.join(directory, 'memory.json')
  const store = new LearningMemoryStore({ filePath, now: () => 1000 })
  await store.load()
  const learned = await store.recordEpisode(successfulEpisode())

  assert.deepEqual(learned.steps, successfulEpisode().attempts.map(attempt => attempt.action))
  assert.equal(learned.evidence.length, learned.steps.length)
  assert.equal(learned.sourceEpisodeId, 'episode-test')
  assert.equal(store.findRelevantSkills({ description: 'obtain an oak_log' })[0].id, learned.id)

  const reloaded = new LearningMemoryStore({ filePath, now: () => 2000 })
  const data = await reloaded.load()
  assert.equal(data.episodes.length, 1)
  assert.equal(data.skills.length, 1)

  const before = data.skills[0].confidence
  await reloaded.updateSkillOutcome(learned.id, false)
  const updated = reloaded.snapshot().skills[0]
  assert.equal(updated.failures, 1)
  assert.ok(updated.confidence < before)

  const relocated = successfulEpisode()
  relocated.id = 'episode-relocated'
  relocated.attempts[0].action.target = 'block:9,70,-4'
  relocated.attempts[1].action.target = 'block:9,70,-4'
  await reloaded.recordEpisode(relocated)
  assert.equal(reloaded.snapshot().skills.length, 1)
  assert.equal(reloaded.snapshot().skills[0].successes, 2)

  const failed = new LearningEpisode({ id: 'failed', goal: OAK_LOG_EXPERIMENT, initialObservation: observation(), startedAt: 0 })
  failed.finish(EPISODE_OUTCOMES.FAILURE, 'ACTION_BUDGET_EXCEEDED', { finishedAt: 10 })
  await reloaded.recordEpisode(failed)
  assert.equal(reloaded.snapshot().episodes.at(-1).terminationReason, 'ACTION_BUDGET_EXCEEDED')
})
