const fs = require('node:fs/promises')
const path = require('node:path')
const {
  LEARNING_ACTION_SCHEMA,
  REFLECTION_SCHEMA,
  CONVERSATION_SCHEMA
} = require('../src/ollama')
const { validatePrimitiveAction, LearningMemoryStore, LearningEpisode } = require('../src/learning')
const { validateReflection } = require('../src/learning/ollama-client')
const { LEARNING_SYSTEM_PROMPT, REFLECTION_SYSTEM_PROMPT, decisionPayload } = require('../src/learning/prompt')
const { SYSTEM_PROMPT: CONVERSATION_SYSTEM_PROMPT } = require('../src/agent/prompt')
const { validateDecision } = require('../src/agent/decision')
const { BenchmarkOllama, summarize, rate, resourceSnapshot, inferenceSummary, flattenAttempts } = require('./lib')

const ROOT = path.resolve(__dirname, '..')
const RESULTS_DIRECTORY = path.join(__dirname, 'results')
const RESULT_JSON = path.join(RESULTS_DIRECTORY, 'latest.json')
const RESULT_MARKDOWN = path.join(RESULTS_DIRECTORY, 'latest.md')
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434/api/chat'
const TIMEOUT_MS = Number(process.env.BENCHMARK_TIMEOUT_MS || 180000)

const CONDITIONS = [
  { id: 'qwen3-vl-8b-think-false', model: 'qwen3-vl:8b', think: false },
  { id: 'qwen3.5-27b-think-false', model: 'qwen3.5:27b', think: false },
  { id: 'qwen3.5-27b-thinking-enabled', model: 'qwen3.5:27b', think: true, preflightRequired: true }
]

const PLANNING_SCHEMA = {
  type: 'object',
  properties: {
    decision: { type: 'string', enum: ['RETRY', 'MODIFY', 'ABANDON', 'FORM_GOAL'] },
    goal: { type: 'string', maxLength: 180 },
    subgoals: { type: 'array', items: { type: 'string', maxLength: 180 }, maxItems: 5 },
    rationale: { type: 'string', maxLength: 400 },
    requiredCapabilities: {
      type: 'array',
      items: { type: 'string', enum: ['OBSERVE', 'LOOK_AT', 'MOVE_NEAR', 'EXPLORE', 'DIG_BLOCK', 'WAIT', 'STOP', 'SAY'] },
      maxItems: 8
    }
  },
  required: ['decision', 'goal', 'subgoals', 'rationale', 'requiredCapabilities'],
  additionalProperties: false
}

const PLANNING_PROMPT = `You are evaluating a possible high-level goal for a Minecraft learning companion.
Use only facts in the supplied state. Do not claim resources or capabilities that are absent.
The currently available body primitives are OBSERVE, LOOK_AT, MOVE_NEAR, EXPLORE, DIG_BLOCK, WAIT, STOP, and SAY.
Choose whether to RETRY, MODIFY, ABANDON, or FORM_GOAL. Decompose only into feasible evidence-gathering or primitive-level subgoals.
Return one JSON object matching the supplied schema.`

function validatePlanning(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Plan must be an object')
  const exact = ['decision', 'goal', 'subgoals', 'rationale', 'requiredCapabilities']
  if (Object.keys(value).some(key => !exact.includes(key))) throw new Error('Unexpected plan field')
  if (!['RETRY', 'MODIFY', 'ABANDON', 'FORM_GOAL'].includes(value.decision)) throw new Error('Invalid plan decision')
  if (typeof value.goal !== 'string' || typeof value.rationale !== 'string') throw new Error('Invalid plan text')
  if (!Array.isArray(value.subgoals) || !Array.isArray(value.requiredCapabilities)) throw new Error('Invalid plan arrays')
  const allowed = new Set(['OBSERVE', 'LOOK_AT', 'MOVE_NEAR', 'EXPLORE', 'DIG_BLOCK', 'WAIT', 'STOP', 'SAY'])
  if (value.requiredCapabilities.some(capability => !allowed.has(capability))) throw new Error('Unsupported capability')
  return value
}

function coordinate(seed) {
  return {
    x: 3 + ((seed * 7) % 9),
    y: 64 + (seed % 2),
    z: -8 + ((seed * 11) % 17)
  }
}

function blockReference(position) {
  return `block:${position.x},${position.y},${position.z}`
}

function baseObservation(seed, { item = `target_item_${seed % 4}`, targetVisible = false, position = null, inventory = {} } = {}) {
  const targetPosition = coordinate(seed)
  const botPosition = position || { x: seed % 3, y: 64, z: -(seed % 4) }
  const blocks = [
    { ref: `block:${botPosition.x},63,${botPosition.z}`, name: seed % 2 ? 'stone' : 'dirt', position: { x: botPosition.x, y: 63, z: botPosition.z }, distance: 1, diggable: true },
    { ref: `block:${botPosition.x + 1},64,${botPosition.z}`, name: 'weathered_marker', position: { x: botPosition.x + 1, y: 64, z: botPosition.z }, distance: 1, diggable: true }
  ]
  if (targetVisible) {
    blocks.push({
      ref: blockReference(targetPosition),
      name: `${item}_source`,
      position: targetPosition,
      distance: 4,
      diggable: true
    })
  }
  return {
    observedAt: '2026-09-22T00:00:00.000Z',
    elapsedMs: seed * 100,
    position: botPosition,
    health: 20,
    food: 20,
    heldItem: null,
    hotbar: Array.from({ length: 9 }, (_, slot) => ({ slot, name: null, count: 0 })),
    inventory,
    inventoryDelta: {},
    nearbyBlocks: blocks,
    nearbyEntities: [],
    targetState: null,
    recentProgress: [],
    previousActionResult: null
  }
}

function goalFor(item) {
  return {
    id: `obtain-${item}`,
    pattern: `obtain ${item}`,
    description: `Obtain at least one ${item}.`,
    objective: { type: 'INVENTORY_AT_LEAST', item, count: 1 },
    source: 'AUTONOMOUS'
  }
}

function noProgressAttempt(observation, reflection = null, index = 1) {
  return {
    index,
    observationBefore: observation,
    action: { action: 'OBSERVE' },
    observationAfter: observation,
    actionResult: { success: true, reason: 'OBSERVATION_CAPTURED' },
    evaluation: { status: 'NO_PROGRESS', reason: 'No objective-relevant change was observed' },
    reflection
  }
}

function explorationSnapshot(observation) {
  const region = `${Math.floor(observation.position.x / 4)},${Math.floor(observation.position.y / 4)},${Math.floor(observation.position.z / 4)}`
  return {
    regionSize: 4,
    origin: observation.position,
    maxRadius: 16,
    recentObservedRegions: [{ region, visits: 3, lastObservedStep: 3, position: observation.position }],
    recentExploredDestinations: [],
    recentBlockObservations: [{
      step: 3,
      region,
      names: observation.nearbyBlocks.map(block => block.name),
      refs: observation.nearbyBlocks.map(block => block.ref)
    }]
  }
}

async function warm(client, condition) {
  const observation = baseObservation(999)
  const result = await client.structured({
    condition,
    system: LEARNING_SYSTEM_PROMPT,
    payload: decisionPayload({ goal: goalFor('warmup_item'), observation, attempts: [], learnedSkills: [], explorationState: explorationSnapshot(observation) }),
    schema: LEARNING_ACTION_SCHEMA,
    validate: validatePrimitiveAction,
    retries: 0,
    seed: 999
  })
  return result
}

async function structuredReliability(client, condition) {
  const cases = []
  for (let index = 0; index < 30; index += 1) {
    const observation = baseObservation(index, { targetVisible: index % 3 === 0 })
    const context = {
      goal: goalFor(`reliability_item_${index % 5}`),
      observation,
      attempts: index % 4 === 0 ? [noProgressAttempt(observation)] : [],
      learnedSkills: [],
      explorationState: explorationSnapshot(observation),
      repetitionThreshold: 2
    }
    const response = await client.structured({
      condition,
      system: LEARNING_SYSTEM_PROMPT,
      payload: decisionPayload(context),
      schema: LEARNING_ACTION_SCHEMA,
      validate: validatePrimitiveAction,
      retries: 2,
      seed: index
    })
    cases.push({ index, response })
    process.stdout.write(`  structured ${index + 1}/30\r`)
  }
  process.stdout.write('                              \r')
  const responses = cases.map(item => item.response)
  const attempts = flattenAttempts(responses)
  return {
    cases,
    metrics: {
      decisions: cases.length,
      valid: responses.filter(response => response.valid).length,
      validRate: rate(responses.filter(response => response.valid).length, cases.length),
      emptyFinalResponses: responses.filter(response => response.status === 'EMPTY_RESPONSE').length,
      emptyContentAttempts: attempts.filter(attempt => attempt.contentLength === 0).length,
      contentChannelValid: responses.filter(response => response.valid && response.channel === 'content').length,
      thinkingCompatibilityValid: responses.filter(response => response.valid && response.channel === 'thinking_compatibility').length,
      retriesRequired: responses.reduce((sum, response) => sum + response.retriesRequired, 0),
      invalidJson: responses.filter(response => response.status === 'INVALID_JSON').length,
      schemaInvalid: responses.filter(response => response.status === 'SCHEMA_INVALID').length,
      invalidActions: responses.filter(response => response.status === 'SCHEMA_INVALID').length,
      doneLengthAttempts: attempts.filter(attempt => attempt.doneReason === 'length').length,
      inference: inferenceSummary(responses)
    }
  }
}

function reflectionHallucinated(reflection) {
  const text = Object.values(reflection || {}).join(' ').toLowerCase()
  return /(?:successfully|already)\s+(?:obtained|acquired|found)|inventory\s+(?:now|has|contains)|target\s+(?:is|was)\s+visible/.test(text)
}

async function strategyChange(client, condition) {
  const scenarios = []
  for (let index = 0; index < 20; index += 1) {
    const item = `unseen_item_${index % 5}`
    const observation = baseObservation(100 + index, { item, targetVisible: false })
    const first = noProgressAttempt(observation, null, 1)
    const second = noProgressAttempt(observation, null, 2)
    const reflectionResponse = await client.structured({
      condition,
      system: REFLECTION_SYSTEM_PROMPT,
      payload: {
        observationBefore: second.observationBefore,
        action: second.action,
        observationAfter: second.observationAfter,
        evaluation: second.evaluation
      },
      schema: REFLECTION_SCHEMA,
      validate: validateReflection,
      retries: 2,
      seed: 2000 + index
    })
    if (reflectionResponse.valid) {
      first.reflection = reflectionResponse.value
      second.reflection = reflectionResponse.value
    }
    const decisionResponse = await client.structured({
      condition,
      system: LEARNING_SYSTEM_PROMPT,
      payload: decisionPayload({
        goal: goalFor(item),
        observation,
        attempts: [first, second],
        learnedSkills: [],
        explorationState: explorationSnapshot(observation),
        repetitionThreshold: 2
      }),
      schema: LEARNING_ACTION_SCHEMA,
      validate: validatePrimitiveAction,
      retries: 2,
      seed: 3000 + index
    })
    scenarios.push({ index, item, reflectionResponse, decisionResponse })
    process.stdout.write(`  strategy ${index + 1}/20\r`)
  }
  process.stdout.write('                              \r')
  const validDecisions = scenarios.filter(item => item.decisionResponse.valid)
  const validReflections = scenarios.filter(item => item.reflectionResponse.valid)
  const allResponses = scenarios.flatMap(item => [item.reflectionResponse, item.decisionResponse])
  return {
    scenarios,
    metrics: {
      scenarios: scenarios.length,
      validDecisionRate: rate(validDecisions.length, scenarios.length),
      validReflectionRate: rate(validReflections.length, scenarios.length),
      strategyChangeRate: rate(validDecisions.filter(item => item.decisionResponse.value.action !== 'OBSERVE').length, scenarios.length),
      repeatedFailedActionRate: rate(validDecisions.filter(item => item.decisionResponse.value.action === 'OBSERVE').length, scenarios.length),
      appropriateExploreRate: rate(validDecisions.filter(item => item.decisionResponse.value.action === 'EXPLORE').length, scenarios.length),
      reflectionHallucinationRate: rate(validReflections.filter(item => reflectionHallucinated(item.reflectionResponse.value)).length, scenarios.length),
      invalidActionRate: rate(scenarios.filter(item => !item.decisionResponse.valid).length, scenarios.length),
      inference: inferenceSummary(allResponses)
    }
  }
}

function targetReference(seed) {
  return blockReference(coordinate(seed))
}

function actionSignature(action) {
  return JSON.stringify(action)
}

function simulateAction(state, action) {
  const before = JSON.stringify({ discovered: state.discovered, near: state.near, inventory: state.inventory, position: state.position })
  let success = true
  let reason = 'ACTION_COMPLETED'
  if (action.action === 'EXPLORE') {
    state.position = {
      x: state.position.x + Math.round(Math.sin(action.heading * Math.PI / 180) * action.distance),
      y: state.position.y,
      z: state.position.z - Math.round(Math.cos(action.heading * Math.PI / 180) * action.distance)
    }
    state.discovered = true
    reason = 'NEW_AREA_OBSERVED'
  } else if (action.action === 'MOVE_NEAR') {
    if (state.discovered && action.target === state.targetRef) {
      state.near = true
      reason = 'REACHED_TARGET'
    } else {
      success = false
      reason = 'TARGET_NOT_RELEVANT_OR_VISIBLE'
    }
  } else if (action.action === 'DIG_BLOCK') {
    if (action.target !== state.targetRef || !state.discovered) {
      reason = 'UNPRODUCTIVE_INTERACTION'
    } else if (!state.near) {
      success = false
      reason = 'TARGET_OUT_OF_REACH'
    } else if (!state.interferenceConsumed) {
      state.interferenceConsumed = true
      success = false
      reason = 'TEMPORARY_INTERFERENCE'
    } else {
      state.inventory[state.item] = 1
      reason = 'INTERACTION_YIELDED_ITEM'
    }
  } else if (action.action === 'OBSERVE') {
    reason = 'OBSERVATION_CAPTURED'
  } else if (action.action === 'LOOK_AT') {
    reason = 'LOOKED_AT_TARGET'
  } else if (action.action === 'WAIT') {
    reason = 'WAIT_COMPLETED'
  } else {
    reason = 'NO_SIMULATED_EFFECT'
  }
  const after = JSON.stringify({ discovered: state.discovered, near: state.near, inventory: state.inventory, position: state.position })
  let evaluation
  if (state.inventory[state.item] >= 1) evaluation = { status: 'SUCCESS', reason: 'Objective confirmed by observed inventory' }
  else if (!success) evaluation = { status: 'FAILURE', reason }
  else if (before !== after) evaluation = { status: 'PARTIAL_PROGRESS', reason: 'Observed state changed but objective is not complete' }
  else evaluation = { status: 'NO_PROGRESS', reason: 'No objective-relevant change was observed' }
  return { result: { success, reason }, evaluation }
}

function simulationObservation(state, previousInventory = null) {
  const observation = baseObservation(state.seed, {
    item: state.item,
    targetVisible: state.discovered,
    position: state.position,
    inventory: { ...state.inventory }
  })
  if (state.near && state.discovered) {
    const target = observation.nearbyBlocks.find(block => block.ref === state.targetRef)
    if (target) target.distance = 1
  }
  if (previousInventory) {
    const delta = (state.inventory[state.item] || 0) - (previousInventory[state.item] || 0)
    if (delta) observation.inventoryDelta[state.item] = delta
  }
  return observation
}

async function simulateEpisode(client, condition, { seed, item, learnedSkills = [], maxActions = 10 }) {
  const state = {
    seed,
    item,
    targetRef: targetReference(seed),
    discovered: false,
    near: false,
    interferenceConsumed: false,
    inventory: {},
    position: { x: 0, y: 64, z: 0 }
  }
  const initial = simulationObservation(state)
  const marker = initial.nearbyBlocks.find(block => block.name === 'weathered_marker')
  const attempts = [{
    index: 1,
    observationBefore: initial,
    action: { action: 'LOOK_AT', target: marker.ref },
    observationAfter: initial,
    actionResult: { success: true, reason: 'LOOKED_AT_TARGET' },
    evaluation: { status: 'NO_PROGRESS', reason: 'Looking at the marker did not change the objective state' },
    reflection: {
      reflection: 'The marker was visible, but looking at it did not change inventory or reveal the required item.',
      lesson: 'Looking alone did not progress this objective.',
      nextApproach: 'Use a materially different primitive to gather new evidence.'
    },
    suppliedMisleadingHistory: true
  }]
  const responses = []
  let totalInferenceMs = 0
  let reflections = 0
  for (let step = 0; step < maxActions; step += 1) {
    const observation = simulationObservation(state)
    const decisionResponse = await client.structured({
      condition,
      system: LEARNING_SYSTEM_PROMPT,
      payload: decisionPayload({
        goal: goalFor(item),
        observation,
        attempts,
        learnedSkills,
        explorationState: explorationSnapshot(observation),
        repetitionThreshold: 2
      }),
      schema: LEARNING_ACTION_SCHEMA,
      validate: validatePrimitiveAction,
      retries: 2,
      seed: 5000 + seed * 20 + step
    })
    responses.push(decisionResponse)
    totalInferenceMs += decisionResponse.totalWallMs
    if (!decisionResponse.valid) break
    const before = simulationObservation(state)
    const beforeInventory = { ...state.inventory }
    const { result, evaluation } = simulateAction(state, decisionResponse.value)
    const after = simulationObservation(state, beforeInventory)
    const attempt = {
      index: attempts.length + 1,
      observationBefore: before,
      action: decisionResponse.value,
      observationAfter: after,
      actionResult: result,
      evaluation,
      reflection: null
    }
    attempts.push(attempt)
    if (evaluation.status === 'SUCCESS') break
    if (['FAILURE', 'NO_PROGRESS'].includes(evaluation.status)) {
      const reflectionResponse = await client.structured({
        condition,
        system: REFLECTION_SYSTEM_PROMPT,
        payload: { observationBefore: before, action: attempt.action, observationAfter: after, evaluation },
        schema: REFLECTION_SCHEMA,
        validate: validateReflection,
        retries: 2,
        seed: 6000 + seed * 20 + step
      })
      responses.push(reflectionResponse)
      totalInferenceMs += reflectionResponse.totalWallMs
      reflections += 1
      if (reflectionResponse.valid) attempt.reflection = reflectionResponse.value
    }
  }
  const modelAttempts = attempts.filter(attempt => !attempt.suppliedMisleadingHistory)
  let repeatedActions = 0
  for (let index = 1; index < modelAttempts.length; index += 1) {
    if (actionSignature(modelAttempts[index].action) === actionSignature(modelAttempts[index - 1].action)) repeatedActions += 1
  }
  return {
    seed,
    item,
    success: Boolean(state.inventory[item]),
    actionsToSuccess: modelAttempts.length,
    unnecessaryActions: modelAttempts.filter(attempt => ['FAILURE', 'NO_PROGRESS'].includes(attempt.evaluation.status)).length,
    repeatedActions,
    reflections,
    totalModelCalls: responses.reduce((sum, response) => sum + response.attempts.length, 0),
    totalInferenceMs,
    attempts,
    responses
  }
}

function episodeMetrics(episodes) {
  const successes = episodes.filter(episode => episode.success)
  return {
    episodes: episodes.length,
    successes: successes.length,
    successRate: rate(successes.length, episodes.length),
    actionsToSuccess: summarize(successes.map(episode => episode.actionsToSuccess)),
    unnecessaryActions: summarize(episodes.map(episode => episode.unnecessaryActions)),
    repeatedActions: episodes.reduce((sum, episode) => sum + episode.repeatedActions, 0),
    reflections: episodes.reduce((sum, episode) => sum + episode.reflections, 0),
    totalModelCalls: episodes.reduce((sum, episode) => sum + episode.totalModelCalls, 0),
    totalInferenceMs: episodes.reduce((sum, episode) => sum + episode.totalInferenceMs, 0)
  }
}

async function multiStep(client, condition) {
  const episodes = []
  for (let index = 0; index < 3; index += 1) {
    episodes.push(await simulateEpisode(client, condition, { seed: 700 + index, item: `abstract_item_${index}` }))
    console.log(`  simulation ${index + 1}/3 complete`)
  }
  return { episodes, metrics: episodeMetrics(episodes) }
}

async function createLearnedSkills(conditionId) {
  const filePath = path.join(RESULTS_DIRECTORY, `memory-${conditionId}-${process.pid}.json`)
  const store = new LearningMemoryStore({ filePath, now: () => Date.parse('2026-09-22T00:00:00Z') })
  await store.load()
  const item = 'transfer_item'
  const initial = baseObservation(800, { item, targetVisible: false })
  const episode = new LearningEpisode({ id: `prior-${conditionId}`, goal: goalFor(item), initialObservation: initial, startedAt: 0 })
  const successfulSteps = [
    { action: 'EXPLORE', heading: 90, distance: 4 },
    { action: 'MOVE_NEAR', target: targetReference(800), distance: 2 },
    { action: 'DIG_BLOCK', target: targetReference(800) },
    { action: 'DIG_BLOCK', target: targetReference(800) }
  ]
  for (let index = 0; index < successfulSteps.length; index += 1) {
    episode.addAttempt({
      observationBefore: initial,
      action: successfulSteps[index],
      observationAfter: index === successfulSteps.length - 1
        ? { ...initial, inventory: { [item]: 1 }, inventoryDelta: { [item]: 1 } }
        : initial,
      actionResult: { success: index !== 2, reason: index === 2 ? 'TEMPORARY_INTERFERENCE' : 'PRIOR_EVIDENCE' },
      evaluation: { status: index === successfulSteps.length - 1 ? 'SUCCESS' : index === 2 ? 'FAILURE' : 'PARTIAL_PROGRESS', reason: 'Prior episode evidence' },
      reflection: null
    })
  }
  episode.finish('SUCCESS', 'OBJECTIVE_CONFIRMED', { finishedAt: 100 })
  await store.recordEpisode(episode)
  return store.findRelevantSkills(goalFor('transfer_item_variant'))
}

async function memoryReuse(client, condition) {
  const learnedSkills = await createLearnedSkills(condition.id)
  const fresh = []
  const memory = []
  for (let index = 0; index < 3; index += 1) {
    const options = { seed: 900 + index, item: `transfer_item_variant_${index}`, maxActions: 9 }
    fresh.push(await simulateEpisode(client, condition, { ...options, learnedSkills: [] }))
    memory.push(await simulateEpisode(client, condition, { ...options, learnedSkills }))
    console.log(`  memory pair ${index + 1}/3 complete`)
  }
  const freshMetrics = episodeMetrics(fresh)
  const memoryMetrics = episodeMetrics(memory)
  const staleTargets = memory.reduce((sum, episode) => sum + episode.attempts.filter(attempt => {
    const target = attempt.action?.target
    return target && !attempt.observationBefore?.nearbyBlocks?.some(block => block.ref === target)
  }).length, 0)
  const skillActionNames = new Set(learnedSkills.flatMap(skill => skill.steps.map(step => step.action)))
  const reuseActions = memory.reduce((sum, episode) => sum + episode.attempts.filter(attempt => skillActionNames.has(attempt.action?.action)).length, 0)
  return {
    learnedSkills,
    fresh,
    memory,
    metrics: {
      fresh: freshMetrics,
      memory: memoryMetrics,
      actionReduction: freshMetrics.actionsToSuccess.average !== null && memoryMetrics.actionsToSuccess.average !== null
        ? freshMetrics.actionsToSuccess.average - memoryMetrics.actionsToSuccess.average
        : null,
      staleTargetSelections: staleTargets,
      learnedActionReuseCount: reuseActions
    }
  }
}

const CONVERSATIONS = [
  { message: '你在干嘛？', context: '正在执行学习任务：寻找一个未观察到的目标物品；最近 OBSERVE 没有进展。', expected: 'CHAT', contextPattern: /任务|找|观察|进展|目标|尝试/ },
  { message: '等我一下', context: '当前没有生存危险。', expected: 'STOP' },
  { message: '刚才为什么没成功？', context: '最近动作 OBSERVE；评估 NO_PROGRESS；目标当前不可见。', expected: 'CHAT', contextPattern: /没|没有|观察|目标|进展|看见/ },
  { message: '你觉得我们接下来干什么？', context: '目标不可见，重复观察没有进展。', expected: 'CHAT' },
  { message: '今天这地方还挺安静的。', context: '当前安全，学习任务仍在等待下一步。', expected: 'CHAT' },
  { message: '你找到东西了吗？', context: '库存没有目标物品，任务尚未成功。', expected: 'CHAT', contextPattern: /没|没有|还|尚未/ },
  { message: '先别乱跑', context: '学习探索刚准备开始。', expected: 'STOP' },
  { message: '刚才你做了什么？', context: '最近动作 EXPLORE；移动到新区域，但没有获得目标物品。', expected: 'CHAT', contextPattern: /探索|移动|新|没有|目标/ },
  { message: '休息一下吧', context: '当前安全。', expected: 'STOP' },
  { message: '你觉得刚才的方法靠谱吗？', context: '同一动作连续两次 NO_PROGRESS。', expected: 'CHAT', contextPattern: /不|没|重复|换|进展/ },
  { message: '过来一下', context: '玩家在附近。', expected: 'COME' },
  { message: '保护我就行', context: '当前战斗模式 DEFENSIVE。', expected: 'DEFENSIVE' }
]

function fabricatedConversation(reply) {
  return /已经(?:拿到|完成|成功|找到|挖到)|我(?:拿到|完成|成功|找到|挖到)了|I (?:already )?(?:got|finished|completed|succeeded)/i.test(reply)
}

async function conversations(client, condition) {
  const samples = []
  for (let index = 0; index < CONVERSATIONS.length; index += 1) {
    const sample = CONVERSATIONS[index]
    const response = await client.structured({
      condition,
      messages: [
        { role: 'system', content: CONVERSATION_SYSTEM_PROMPT },
        { role: 'user', content: `Steve 对你说：${sample.message}\n当前状态：${sample.context}` }
      ],
      schema: CONVERSATION_SCHEMA,
      validate: validateDecision,
      retries: 2,
      seed: 8000 + index
    })
    samples.push({ ...sample, response })
  }
  const valid = samples.filter(sample => sample.response.valid)
  return {
    samples,
    metrics: {
      samples: samples.length,
      validRate: rate(valid.length, samples.length),
      expectedActionRate: rate(valid.filter(sample => sample.response.value.action === sample.expected).length, samples.length),
      contextAwareRate: rate(valid.filter(sample => !sample.contextPattern || sample.contextPattern.test(sample.response.value.reply)).length, samples.length),
      conciseRate: rate(valid.filter(sample => sample.response.value.reply.length <= 80).length, samples.length),
      fabricationRate: rate(valid.filter(sample => fabricatedConversation(sample.response.value.reply)).length, samples.length),
      replyCharacters: summarize(valid.map(sample => sample.response.value.reply.length)),
      timeToCompleteResponseMs: summarize(valid.map(sample => sample.response.totalWallMs)),
      totalGenerationLatencyMs: summarize(valid.map(sample => sample.response.totalWallMs)),
      inference: inferenceSummary(samples.map(sample => sample.response))
    }
  }
}

const PLANNING_STATES = [
  { situation: 'We want shelter before night, but inventory is empty and no useful resource is currently observed.', time: 'late afternoon', failures: [] },
  { situation: 'The player is mining. The companion has no active task. Nearby observations show only ordinary ground.', time: 'day', failures: [] },
  { situation: 'The previous strategy repeated OBSERVE three times with NO_PROGRESS. The target remains unseen.', time: 'day', failures: ['OBSERVE', 'OBSERVE', 'OBSERVE'] },
  { situation: 'A prior MOVE_NEAR failed with NO_PATH. A different nearby direction has not been observed.', time: 'day', failures: ['MOVE_NEAR'] },
  { situation: 'Night is approaching. Health is full, no hostile is currently visible, and no building capability exists.', time: 'dusk', failures: [] },
  { situation: 'A learned strategy references an old target coordinate that is absent in the current observation.', time: 'day', failures: ['stale target'] }
]

function planningHallucination(plan) {
  const text = `${plan.goal} ${plan.subgoals.join(' ')} ${plan.rationale}`.toLowerCase()
  return /(?:we have|inventory contains|currently see|already found)\s+(?:wood|stone|iron|a target|resources)/.test(text)
}

function unsupportedPlanAction(plan) {
  const text = `${plan.goal} ${plan.subgoals.join(' ')} ${plan.rationale}`.toLowerCase()
  return /\b(?:craft|build|place|smelt|equip|sleep|chop)\b/.test(text)
}

async function planning(client, condition) {
  const samples = []
  for (let index = 0; index < PLANNING_STATES.length; index += 1) {
    const response = await client.structured({
      condition,
      system: PLANNING_PROMPT,
      payload: PLANNING_STATES[index],
      schema: PLANNING_SCHEMA,
      validate: validatePlanning,
      retries: 2,
      seed: 9000 + index
    })
    samples.push({ state: PLANNING_STATES[index], response })
  }
  const valid = samples.filter(sample => sample.response.valid)
  return {
    samples,
    metrics: {
      samples: samples.length,
      validRate: rate(valid.length, samples.length),
      decompositionRate: rate(valid.filter(sample => sample.response.value.subgoals.length >= 2).length, samples.length),
      groundedRate: rate(valid.filter(sample => !planningHallucination(sample.response.value)).length, samples.length),
      primitiveFeasibleRate: rate(valid.filter(sample => !unsupportedPlanAction(sample.response.value)).length, samples.length),
      hallucinationRate: rate(valid.filter(sample => planningHallucination(sample.response.value)).length, samples.length),
      inference: inferenceSummary(samples.map(sample => sample.response))
    }
  }
}

async function thinkingPreflight(client, condition) {
  const results = []
  for (let index = 0; index < 3; index += 1) {
    const observation = baseObservation(1000 + index)
    const reflection = {
      reflection: 'The local observation did not change.',
      lesson: 'Repeating the same observation produced no new evidence.',
      nextApproach: 'Try a materially different evidence-gathering action.'
    }
    const attempts = [noProgressAttempt(observation, reflection, 1), noProgressAttempt(observation, reflection, 2)]
    results.push(await client.structured({
      condition,
      system: LEARNING_SYSTEM_PROMPT,
      payload: decisionPayload({
        goal: goalFor(`preflight_item_${index}`),
        observation,
        attempts,
        learnedSkills: [],
        explorationState: explorationSnapshot(observation),
        repetitionThreshold: 2
      }),
      schema: LEARNING_ACTION_SCHEMA,
      validate: validatePrimitiveAction,
      retries: 0,
      seed: 10000 + index
    }))
  }
  const attempts = flattenAttempts(results)
  const metrics = {
    trials: results.length,
    valid: results.filter(result => result.valid).length,
    validRate: rate(results.filter(result => result.valid).length, results.length),
    doneLength: attempts.filter(attempt => attempt.doneReason === 'length').length,
    latencyMs: summarize(results.map(result => result.totalWallMs)),
    channels: results.map(result => result.channel)
  }
  return {
    results,
    metrics,
    viable: metrics.validRate === 1 && metrics.doneLength === 0 && metrics.latencyMs.median < 30000
  }
}

function compactCondition(conditionResult) {
  if (!conditionResult.completed) {
    return {
      condition: conditionResult.condition.id,
      completed: false,
      reason: conditionResult.exclusionReason,
      preflight: conditionResult.preflight?.metrics || null
    }
  }
  return {
    condition: conditionResult.condition.id,
    completed: true,
    structuredValidRate: conditionResult.structured.metrics.validRate,
    decisionMedianMs: conditionResult.structured.metrics.inference.wallMs.median,
    decisionP95Ms: conditionResult.structured.metrics.inference.wallMs.p95,
    strategyChangeRate: conditionResult.strategy.metrics.strategyChangeRate,
    exploreRate: conditionResult.strategy.metrics.appropriateExploreRate,
    reflectionHallucinationRate: conditionResult.strategy.metrics.reflectionHallucinationRate,
    multiStepSuccessRate: conditionResult.multiStep.metrics.successRate,
    multiStepActions: conditionResult.multiStep.metrics.actionsToSuccess.average,
    memoryFreshSuccessRate: conditionResult.memory.metrics.fresh.successRate,
    memorySuccessRate: conditionResult.memory.metrics.memory.successRate,
    memoryActionReduction: conditionResult.memory.metrics.actionReduction,
    conversationExpectedActionRate: conditionResult.conversation.metrics.expectedActionRate,
    conversationMedianMs: conditionResult.conversation.metrics.totalGenerationLatencyMs.median,
    conversationP95Ms: conditionResult.conversation.metrics.totalGenerationLatencyMs.p95,
    planningGroundedRate: conditionResult.planning.metrics.groundedRate,
    planningFeasibleRate: conditionResult.planning.metrics.primitiveFeasibleRate,
    realModelCalls: conditionResult.realModelCalls
  }
}

function formatPercent(value) {
  return value === null || value === undefined ? 'n/a' : `${(value * 100).toFixed(1)}%`
}

function formatNumber(value, digits = 1) {
  return value === null || value === undefined ? 'n/a' : Number(value).toFixed(digits)
}

function markdownReport(result) {
  const rows = result.conditions.map(compactCondition)
  const lines = [
    '# Minecraft Learning Agent model benchmark',
    '',
    `Generated: ${result.finishedAt}`,
    '',
    `Ollama: ${result.environment.ollamaVersion}`,
    '',
    '| Condition | Completed | Structured valid | Strategy change | Explore | Multi-step success | Memory fresh → reuse | Decision median / p95 ms | Conversation median / p95 ms | Planning grounded / feasible | Calls |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |'
  ]
  for (const row of rows) {
    if (!row.completed) {
      lines.push(`| ${row.condition} | No (${row.reason}) | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | ${result.conditions.find(item => item.condition.id === row.condition)?.realModelCalls || 0} |`)
      continue
    }
    lines.push(`| ${row.condition} | Yes | ${formatPercent(row.structuredValidRate)} | ${formatPercent(row.strategyChangeRate)} | ${formatPercent(row.exploreRate)} | ${formatPercent(row.multiStepSuccessRate)} | ${formatPercent(row.memoryFreshSuccessRate)} → ${formatPercent(row.memorySuccessRate)} | ${formatNumber(row.decisionMedianMs)} / ${formatNumber(row.decisionP95Ms)} | ${formatNumber(row.conversationMedianMs)} / ${formatNumber(row.conversationP95Ms)} | ${formatPercent(row.planningGroundedRate)} / ${formatPercent(row.planningFeasibleRate)} | ${row.realModelCalls} |`)
  }
  lines.push('', 'See `latest.json` for every request, action, reflection, timing, token rate, and resource snapshot.', '')
  return lines.join('\n')
}

async function environment(client) {
  const [versionResponse, tagsResponse] = await Promise.all([
    fetch(OLLAMA_URL.replace(/\/api\/chat$/, '/api/version')).then(response => response.json()),
    fetch(OLLAMA_URL.replace(/\/api\/chat$/, '/api/tags')).then(response => response.json())
  ])
  return {
    ollamaVersion: versionResponse.version,
    models: tagsResponse.models.filter(model => ['qwen3-vl:8b', 'qwen3.5:27b'].includes(model.name)),
    initialResources: resourceSnapshot(),
    initialRunningModels: await client.runningModels()
  }
}

async function save(result) {
  await fs.mkdir(RESULTS_DIRECTORY, { recursive: true })
  await fs.writeFile(RESULT_JSON, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  await fs.writeFile(RESULT_MARKDOWN, `${markdownReport(result)}\n`, 'utf8')
}

async function runCondition(client, condition) {
  console.log(`\n=== ${condition.id} ===`)
  const callsBefore = client.realCalls
  console.log('warming model...')
  const warmup = await warm(client, condition)
  const afterWarmResources = resourceSnapshot()
  const runningModels = await client.runningModels()
  let preflight = null
  if (condition.preflightRequired) {
    console.log('thinking-mode viability preflight...')
    preflight = await thinkingPreflight(client, condition)
    console.log(`preflight valid=${preflight.metrics.valid}/${preflight.metrics.trials}, median=${preflight.metrics.latencyMs.median?.toFixed(0)}ms, viable=${preflight.viable}`)
    if (!preflight.viable) {
      return {
        condition,
        completed: false,
        exclusionReason: 'thinking-enabled preflight was not reliable/interactive',
        warmup,
        preflight,
        afterWarmResources,
        runningModels,
        realModelCalls: client.realCalls - callsBefore
      }
    }
  }

  console.log('structured reliability...')
  const structured = await structuredReliability(client, condition)
  console.log('failure/reflection/strategy change...')
  const strategy = await strategyChange(client, condition)
  console.log('multi-step simulations...')
  const multiStepResult = await multiStep(client, condition)
  console.log('memory reuse...')
  const memory = await memoryReuse(client, condition)
  console.log('conversation...')
  const conversation = await conversations(client, condition)
  console.log('complex planning...')
  const planningResult = await planning(client, condition)
  return {
    condition,
    completed: true,
    warmup,
    preflight,
    afterWarmResources,
    runningModels,
    structured,
    strategy,
    multiStep: multiStepResult,
    memory,
    conversation,
    planning: planningResult,
    finalResources: resourceSnapshot(),
    finalRunningModels: await client.runningModels(),
    realModelCalls: client.realCalls - callsBefore
  }
}

async function main() {
  await fs.mkdir(RESULTS_DIRECTORY, { recursive: true })
  const client = new BenchmarkOllama({ url: OLLAMA_URL, timeoutMs: TIMEOUT_MS })
  const result = {
    benchmarkVersion: 1,
    startedAt: new Date().toISOString(),
    methodology: {
      structuredDecisionsPerCompletedCondition: 30,
      strategyScenariosPerCompletedCondition: 20,
      multiStepEpisodesPerCompletedCondition: 3,
      memoryPairsPerCompletedCondition: 3,
      conversationSamplesPerCompletedCondition: CONVERSATIONS.length,
      planningSamplesPerCompletedCondition: PLANNING_STATES.length,
      retries: 2,
      temperature: 0,
      stream: false,
      note: 'All model calls use real local Ollama responses. Conditions share identical seeded prompts and scenarios.'
    },
    environment: await environment(client),
    conditions: []
  }
  for (const condition of CONDITIONS) {
    const conditionResult = await runCondition(client, condition)
    result.conditions.push(conditionResult)
    result.totalRealModelCalls = client.realCalls
    await save(result)
  }
  result.finishedAt = new Date().toISOString()
  result.totalRealModelCalls = client.realCalls
  await save(result)
  console.log(`\nSaved ${RESULT_JSON}`)
  console.log(`Saved ${RESULT_MARKDOWN}`)
  console.log(`Real Ollama HTTP calls: ${client.realCalls}`)
}

main().catch(async error => {
  console.error(error)
  process.exitCode = 1
})
