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
  OAK_LOG_EXPERIMENT,
  createItemGoal,
  skillFromSuccessfulEpisode
} = require('../src/learning')
const { inventoryDelta } = require('../src/learning/observation')
const { decisionSchemaForObservation, validateObservedPrimitiveAction } = require('../src/learning/ollama-client')
const { decisionPayload } = require('../src/learning/prompt')

test('learned skill is presented as transferable evidence without stale world references', () => {
  const skill = { id: 'learned-1', goalPattern: 'obtain birch_log', preconditions: {},
    steps: [
      { action: 'MOVE_NEAR', target: 'block:90,64,8', distance: 2 },
      { action: 'DIG_BLOCK', target: 'block:90,64,8' },
      { action: 'MOVE_NEAR', target: 'entity:9876', distance: 1 }
    ],
    evidence: [
      { target: { name: 'birch_log' } },
      { target: { name: 'birch_log' } },
      { target: { droppedItem: 'birch_log' } }
    ], confidence: 0.7, successes: 1, failures: 0 }
  const payload = decisionPayload({ goal: createItemGoal('birch_log'), observation: observation(),
    attempts: [], learnedSkills: [skill] })
  const presented = payload.learnedSkillCandidates[0].steps
  assert.deepEqual(presented[0], { action: 'MOVE_NEAR', target: { kind: 'block', observedName: 'birch_log' }, distance: 2 })
  assert.deepEqual(presented[2], { action: 'MOVE_NEAR', target: { kind: 'entity', observedName: 'birch_log' }, distance: 1 })
  assert.equal(JSON.stringify(payload).includes('90,64,8'), false)
  assert.equal(JSON.stringify(payload).includes('9876'), false)
})

test('inventory-goal decision highlights matching observed drops and rejects speech as progress', () => {
  const goal = createItemGoal('birch_log')
  const current = observation({}, { nearbyBlocks: [{ ref: 'block:1,64,0', name: 'dirt' }],
    nearbyEntities: [
      { ref: 'entity:7', distance: 2.4, droppedItem: { name: 'birch_log', count: 1 } },
      { ref: 'entity:8', distance: 1.1, droppedItem: { name: 'dirt', count: 1 } }
    ] })
  const payload = decisionPayload({ goal, observation: current, attempts: [], learnedSkills: [] })
  assert.deepEqual(payload.objectiveEvidence.observedDroppedStacks,
    [{ ref: 'entity:7', distance: 2.4, count: 1 }])
  assert.equal(payload.allowedActions.includes('SAY'), false)
  const schema = decisionSchemaForObservation(current, [], 2, goal)
  assert.equal(schema.oneOf.some(variant => variant.properties.action.const === 'SAY'), false)
  assert.throws(() => validateObservedPrimitiveAction({ action: 'SAY', message: 'I have it' },
    current, [], 2, goal), /Speech cannot satisfy/)
  const dig = schema.oneOf.find(variant => variant.properties.action.const === 'DIG_BLOCK')
  assert.equal(dig, undefined)
  assert.throws(() => validateObservedPrimitiveAction({ action: 'DIG_BLOCK', target: 'block:1,64,0' },
    current, [], 2, goal), /objective item should be collected/)
  const moveTargets = schema.oneOf.filter(variant => variant.properties.action.const === 'MOVE_NEAR')
  assert.deepEqual(moveTargets.map(variant => variant.properties.target.enum), [['entity:7']])
  assert.throws(() => validateObservedPrimitiveAction({ action: 'MOVE_NEAR', target: 'block:1,64,0', distance: 1 },
    current, [], 2, goal), /objective item before unrelated/)
  const attempts = [{ action: { action: 'OBSERVE' }, evaluation: { status: 'NO_PROGRESS' },
    observationAfter: { nearbyEntities: [{ ref: 'entity:7' }] } }]
  const afterObserve = decisionSchemaForObservation(current, attempts, 2, goal)
  assert.equal(afterObserve.oneOf.some(variant => variant.properties.action.const === 'OBSERVE'), false)
  assert.equal(afterObserve.oneOf.some(variant => variant.properties.action.const === 'EXPLORE'), false)
  assert.throws(() => validateObservedPrimitiveAction({ action: 'OBSERVE' }, current, attempts, 2, goal),
    /Repeated/)
})

test('block MOVE_NEAR excludes already-near blocks while retaining bounded model arguments', () => {
  const far = observation({}, { nearbyBlocks: [{ ref: 'block:6,64,0', name: 'birch_log', distance: 5.7 }] })
  const variant = decisionSchemaForObservation(far).oneOf.find(entry =>
    entry.properties.action.const === 'MOVE_NEAR')
  assert.equal(variant.properties.distance.maximum, 6)
  assert.equal(validateObservedPrimitiveAction({ action: 'MOVE_NEAR',
    target: 'block:6,64,0', distance: 5.7 }, far).distance, 5.7)
  const near = observation({}, { nearbyBlocks: [{ ref: 'block:3,64,0', name: 'birch_log', distance: 2.8 }] })
  assert.equal(decisionSchemaForObservation(near).oneOf.some(entry =>
    entry.properties.action.const === 'MOVE_NEAR'), false)
  assert.throws(() => validateObservedPrimitiveAction({ action: 'MOVE_NEAR',
    target: 'block:3,64,0', distance: 3 }, near), /already-near range/)
})

test('repeated no-progress movement to the same observed target leaves exploration available', () => {
  const goal = createItemGoal('birch_log')
  const current = observation({}, { nearbyEntities: [{ ref: 'entity:7', type: 'player', distance: 2 }] })
  const attempts = [1, 2].map(() => ({ action: { action: 'MOVE_NEAR', target: 'entity:7', distance: 1.9 },
    evaluation: { status: 'NO_PROGRESS' } }))
  const schema = decisionSchemaForObservation(current, attempts, 2, goal)
  assert.equal(schema.oneOf.some(entry => entry.properties.action.const === 'MOVE_NEAR'), false)
  assert.equal(schema.oneOf.some(entry => entry.properties.action.const === 'EXPLORE'), true)
  assert.throws(() => validateObservedPrimitiveAction({ action: 'MOVE_NEAR', target: 'entity:7', distance: 1.9 },
    current, attempts, 2, goal), /Repeated movement/)
  const newEvidence = observation({}, { nearbyEntities: [{ ref: 'entity:9', distance: 5 }] })
  assert.equal(decisionSchemaForObservation(newEvidence, attempts, 2, goal).oneOf.some(entry =>
    entry.properties.action.const === 'MOVE_NEAR'), true)
})

test('observed objective block focuses target choices without prescribing the primitive', () => {
  const goal = createItemGoal('birch_log')
  const far = observation({}, { nearbyBlocks: [
    { ref: 'block:6,64,0', name: 'birch_log', distance: 5.7, diggable: true },
    { ref: 'block:2,63,0', name: 'dirt', distance: 2.2, diggable: true }
  ] })
  const schema = decisionSchemaForObservation(far, [], 2, goal)
  assert.deepEqual(schema.oneOf.filter(entry => entry.properties.action.const === 'MOVE_NEAR')
    .map(entry => entry.properties.target.enum), [['block:6,64,0']])
  assert.deepEqual(schema.oneOf.find(entry => entry.properties.action.const === 'DIG_BLOCK')
    .properties.target.enum, ['block:6,64,0'])
  assert.throws(() => validateObservedPrimitiveAction({ action: 'DIG_BLOCK', target: 'block:2,63,0' },
    far, [], 2, goal), /unrelated digging/)
  const attempts = [{ action: { action: 'OBSERVE' }, evaluation: { status: 'NO_PROGRESS' },
    observationAfter: { nearbyBlocks: [{ ref: 'block:6,64,0' }] } }]
  assert.equal(decisionSchemaForObservation(far, attempts, 2, goal).oneOf.some(entry =>
    entry.properties.action.const === 'OBSERVE'), false)
})

test('two static no-progress observations disable OBSERVE', () => {
  const goal = createItemGoal('birch_log')
  const current = observation({}, { nearbyBlocks: [{ ref: 'block:1,63,0', name: 'grass_block' }] })
  const attempts = [1, 2].map(() => ({ action: { action: 'OBSERVE' },
    evaluation: { status: 'NO_PROGRESS' }, observationAfter: current }))
  const schema = decisionSchemaForObservation(current, attempts, 2, goal)
  assert.equal(schema.oneOf.some(variant => variant.properties.action.const === 'OBSERVE'), false)
  assert.throws(() => validateObservedPrimitiveAction({ action: 'OBSERVE' }, current, attempts, 2, goal),
    /Repeated/)
})

test('schema-invalid model distance gets a bounded corrective retry without executing an action', async () => {
  const requests = []
  const client = new LearningOllamaClient({ ollama: {
    url: 'http://ollama.test/api/chat', model: 'test', timeoutMs: 1000,
    responseRetries: 1, retryBackoffMs: 0
  }, fetchFn: async (_url, options) => {
    requests.push(JSON.parse(options.body))
    const distance = requests.length === 1 ? 7 : 3.5
    return { ok: true, status: 200, text: async () => JSON.stringify({
      message: { content: JSON.stringify({ action: 'MOVE_NEAR', target: 'block:6,64,0', distance }) }, done: true
    }) }
  } })
  const context = { goal: createItemGoal('birch_log'),
    observation: observation({}, { nearbyBlocks: [{ ref: 'block:6,64,0', name: 'birch_log', distance: 5.7 }] }),
    attempts: [], learnedSkills: [] }
  assert.equal((await client.decide(context)).distance, 3.5)
  assert.equal(requests.length, 2)
  assert.match(JSON.stringify(requests[1]), /rejectedDecisionConstraint/)
  assert.match(JSON.stringify(requests[1]), /between 1 and 6/)
  assert.match(JSON.stringify(requests[1]), /rejectedDecisionJson/)
  assert.match(JSON.stringify(requests[1]), /Do not copy target.distance/)
})

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

test('learning decision schema exposes only targets in the current observation', () => {
  const current = {
    nearbyBlocks: [{ ref: 'block:2,64,0', name: 'birch_log' }],
    nearbyEntities: [{ ref: 'entity:7', name: 'item', droppedItem: { name: 'birch_log', count: 1 } }]
  }
  const schema = decisionSchemaForObservation(current)
  const variant = action => schema.oneOf.find(entry => entry.properties.action.const === action)
  assert.deepEqual(variant('DIG_BLOCK').properties.target.enum, ['block:2,64,0'])
  const moveVariants = schema.oneOf.filter(entry => entry.properties.action.const === 'MOVE_NEAR')
  assert.deepEqual(moveVariants.map(entry => entry.properties.target.enum), [['block:2,64,0'], ['entity:7']])
  assert.equal(moveVariants[1].properties.distance.const, 1)
  assert.equal(variant('ATTACK_ENTITY'), undefined)
  assert.throws(() => validateObservedPrimitiveAction({ action: 'DIG_BLOCK', target: 'block:3,64,0' }, current), /not in the current observation/)
  assert.equal(validateObservedPrimitiveAction({ action: 'MOVE_NEAR', target: 'entity:7', distance: 1 }, current).target, 'entity:7')
  assert.throws(() => validateObservedPrimitiveAction({ action: 'MOVE_NEAR', target: 'entity:7', distance: 1.5 }, current),
    /one-block stopping radius/)
  assert.equal(decisionSchemaForObservation({ nearbyBlocks: [], nearbyEntities: [] }).oneOf.some(entry =>
    entry.properties.action.const === 'DIG_BLOCK'), false)
  assert.equal(schema.oneOf.some(entry => entry.properties.action.const === 'USE_ITEM'), false)
  assert.throws(() => validateObservedPrimitiveAction({ action: 'USE_ITEM' }, current), /held item/)
  assert.throws(() => validateObservedPrimitiveAction({ action: 'ATTACK_ENTITY', target: 'entity:7' }, current), /observed hostile/)
  const hostileState = { ...current, nearbyEntities: [
    ...current.nearbyEntities, { ref: 'entity:8', name: 'zombie', type: 'hostile' }
  ] }
  assert.deepEqual(decisionSchemaForObservation(hostileState).oneOf.find(entry =>
    entry.properties.action.const === 'ATTACK_ENTITY').properties.target.enum, ['entity:8'])
})

test('two identical no-progress observations temporarily remove OBSERVE but leave Qwen alternatives', () => {
  const attempts = [1, 2].map(() => ({
    action: { action: 'OBSERVE' }, evaluation: { status: EVALUATION.NO_PROGRESS }
  }))
  const available = decisionSchemaForObservation(observation(), attempts, 2).oneOf
    .map(variant => variant.properties.action.const)
  assert.equal(available.includes('OBSERVE'), false)
  assert.equal(available.includes('EXPLORE'), true)
  assert.equal(available.includes('LOOK_VISUALLY'), true)
  assert.throws(() => validateObservedPrimitiveAction({ action: 'OBSERVE' }, observation(), attempts, 2),
    /temporarily unavailable/)
  assert.equal(validateObservedPrimitiveAction({ action: 'EXPLORE', heading: 90, distance: 8 },
    observation(), attempts, 2).action, 'EXPLORE')
  const changedEvidence = [...attempts, { action: { action: 'EXPLORE', heading: 90, distance: 8 },
    evaluation: { status: EVALUATION.PARTIAL_PROGRESS } }]
  assert.equal(decisionSchemaForObservation(observation(), changedEvidence, 2).oneOf.some(variant =>
    variant.properties.action.const === 'OBSERVE'), true)
})

test('a completed no-progress dig discourages the same material, not all digging', () => {
  const current = observation({}, { nearbyBlocks: [
    { ref: 'block:1,64,0', name: 'grass_block' },
    { ref: 'block:2,64,0', name: 'grass_block' },
    { ref: 'block:3,64,0', name: 'birch_log' }
  ] })
  const attempts = [{
    action: { action: 'DIG_BLOCK', target: 'block:1,64,0' },
    actionResult: { success: true, reason: 'DIG_COMPLETED' },
    observationBefore: observation({}, { targetState: { ref: 'block:1,64,0', name: 'grass_block', exists: true } }),
    evaluation: { status: EVALUATION.NO_PROGRESS }
  }]
  const dig = decisionSchemaForObservation(current, attempts).oneOf.find(variant =>
    variant.properties.action.const === 'DIG_BLOCK')
  assert.deepEqual(dig.properties.target.enum, ['block:3,64,0'])
  assert.throws(() => validateObservedPrimitiveAction({ action: 'DIG_BLOCK', target: 'block:2,64,0' },
    current, attempts), /no objective progress/)
  assert.equal(validateObservedPrimitiveAction({ action: 'DIG_BLOCK', target: 'block:3,64,0' },
    current, attempts).action, 'DIG_BLOCK')
})

test('known undiggable blocks and previously failed dig targets are removed from the model schema', () => {
  const current = observation({}, { nearbyBlocks: [
    { ref: 'block:1,64,0', name: 'bedrock', diggable: false },
    { ref: 'block:2,64,0', name: 'stone', diggable: true },
    { ref: 'block:3,64,0', name: 'oak_log', diggable: true }
  ] })
  const attempts = [{ action: { action: 'DIG_BLOCK', target: 'block:2,64,0' },
    evaluation: { status: EVALUATION.FAILURE }, actionResult: { success: false, reason: 'TARGET_OUT_OF_REACH' } }]
  const dig = decisionSchemaForObservation(current, attempts).oneOf.find(variant =>
    variant.properties.action.const === 'DIG_BLOCK')
  assert.deepEqual(dig.properties.target.enum, ['block:3,64,0'])
  assert.throws(() => validateObservedPrimitiveAction({ action: 'DIG_BLOCK', target: 'block:1,64,0' },
    current, attempts), /known to be unavailable/)
  assert.throws(() => validateObservedPrimitiveAction({ action: 'DIG_BLOCK', target: 'block:2,64,0' },
    current, attempts), /known to be unavailable/)
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

test('breaking unrelated terrain is no progress for a specific inventory goal', () => {
  const initial = observation()
  const before = observation({}, { targetState: { ref: 'block:1,64,0', exists: true, name: 'grass_block' } })
  const after = observation({ dirt: 1 }, {
    inventoryDelta: { dirt: 1 }, targetState: { ref: 'block:1,64,0', exists: false }
  })
  assert.equal(evaluateAttempt({ goal: createItemGoal('birch_log'), initialObservation: initial,
    observationBefore: before, observationAfter: after, actionResult: { success: true, reason: 'DIG_COMPLETED' } }).status,
  EVALUATION.NO_PROGRESS)
})

test('new objective-item evidence is partial progress even before pickup', () => {
  const initial = observation()
  const before = observation()
  const after = observation({}, { nearbyEntities: [{ ref: 'entity:4', droppedItem: { name: 'birch_log', count: 1 } }] })
  assert.equal(evaluateAttempt({ goal: createItemGoal('birch_log'), initialObservation: initial,
    observationBefore: before, observationAfter: after, actionResult: { success: true } }).status,
  EVALUATION.PARTIAL_PROGRESS)
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

test('learning observation reports confirmed dropped-item identity without inventing missing metadata', () => {
  const bot = {
    entity: { id: 1, position: { x: 0, y: 64, z: 0 } },
    entities: {
      2: { id: 2, name: 'item', type: 'other', position: { x: 2, y: 64, z: 0 },
        getDroppedItem: () => ({ name: 'birch_log', count: 1 }) },
      3: { id: 3, name: 'item', type: 'other', position: { x: 3, y: 64, z: 0 },
        getDroppedItem: () => { throw new Error('metadata not ready') } }
    },
    inventory: { items: () => [], slots: [] }
  }
  const state = new LearningObservationBuilder({ bot }).capture({ target: 'entity:2' })
  assert.deepEqual(state.nearbyEntities.find(entity => entity.ref === 'entity:2').droppedItem,
    { name: 'birch_log', count: 1 })
  assert.deepEqual(state.targetState.droppedItem, { name: 'birch_log', count: 1 })
  assert.equal(Object.hasOwn(state.nearbyEntities.find(entity => entity.ref === 'entity:3'), 'droppedItem'), false)
})

test('successful learned sequence retains observed dropped-item identity as evidence', () => {
  const goal = createItemGoal('birch_log')
  const initial = observation()
  const episode = new LearningEpisode({ id: 'drop-test', goal, initialObservation: initial, startedAt: 0 })
  episode.addAttempt({
    observationBefore: observation({}, { targetState: {
      ref: 'entity:7', name: 'item', type: 'other', droppedItem: { name: 'birch_log', count: 1 }
    } }),
    action: { action: 'MOVE_NEAR', target: 'entity:7', distance: 1 },
    observationAfter: observation({ birch_log: 1 }, { inventoryDelta: { birch_log: 1 } }),
    actionResult: { success: true, reason: 'REACHED_TARGET' },
    evaluation: { status: EVALUATION.SUCCESS }
  })
  episode.finish(EPISODE_OUTCOMES.SUCCESS, 'OBJECTIVE_CONFIRMED', { finishedAt: 1 })
  assert.equal(skillFromSuccessfulEpisode(episode).evidence[0].target.droppedItem, 'birch_log')
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
  const evidence = { ref: 'block:5,64,0', name: 'oak_log' }
  const args = { goal: OAK_LOG_EXPERIMENT, initialObservation: initial, observationBefore: initial,
    actionResult: { success: true, reason: 'SYMBOLIC_DISCOVERY', evidence: [evidence] } }
  assert.equal(evaluateAttempt({ ...args, observationAfter: observation() }).status, EVALUATION.NO_PROGRESS)
  assert.equal(evaluateAttempt({ ...args, observationAfter: observation({}, { nearbyBlocks: [evidence] }) }).status, EVALUATION.PARTIAL_PROGRESS)
  const unrelated = { ...evidence, name: 'grass_block' }
  assert.equal(evaluateAttempt({ ...args, actionResult: { ...args.actionResult, evidence: [unrelated] },
    observationAfter: observation({}, { nearbyBlocks: [unrelated] }) }).status, EVALUATION.NO_PROGRESS)
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

  assert.deepEqual(learned.steps, successfulEpisode().attempts
    .filter(attempt => ['PARTIAL_PROGRESS', 'SUCCESS'].includes(attempt.evaluation.status))
    .map(attempt => attempt.action))
  assert.equal(learned.steps.some(step => step.action === 'MOVE_NEAR'), false)
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

test('unrelated initial inventory does not become a learned skill prerequisite', () => {
  const episode = successfulEpisode()
  episode.initialObservation.inventory = { oak_log: 2 }
  const candidate = skillFromSuccessfulEpisode(episode)
  assert.equal('initialInventory' in candidate.preconditions, false)

  const store = new LearningMemoryStore({ filePath: path.join(os.tmpdir(), 'unused-memory-test.json') })
  store.data.skills.push({ ...candidate,
    preconditions: { ...candidate.preconditions, initialInventory: ['oak_log'] } })
  const retrieved = store.findRelevantSkills(episode.goal)[0]
  assert.equal('initialInventory' in retrieved.preconditions, false)
  assert.deepEqual(store.data.skills[0].preconditions.initialInventory, ['oak_log'])
})

test('concurrent episode saves are serialized and preserve both outcomes', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'companion-memory-concurrent-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const filePath = path.join(directory, 'memory.json')
  const store = new LearningMemoryStore({ filePath })
  await store.load()
  const first = new LearningEpisode({ id: 'cancelled-auto', goal: OAK_LOG_EXPERIMENT,
    initialObservation: observation(), startedAt: 0 })
  first.finish(EPISODE_OUTCOMES.CANCELLED, 'PLAYER_MOVEMENT_COMMAND', { finishedAt: 1 })
  const second = new LearningEpisode({ id: 'next-task', goal: OAK_LOG_EXPERIMENT,
    initialObservation: observation(), startedAt: 2 })
  second.finish(EPISODE_OUTCOMES.FAILURE, 'ACTION_BUDGET_EXCEEDED', { finishedAt: 3 })
  await Promise.all([store.recordEpisode(first), store.recordEpisode(second)])
  const reloaded = new LearningMemoryStore({ filePath })
  const saved = await reloaded.load()
  assert.deepEqual(saved.episodes.map(episode => episode.id), ['cancelled-auto', 'next-task'])
  assert.deepEqual((await fs.readdir(directory)).sort(), ['memory.json'])
})
