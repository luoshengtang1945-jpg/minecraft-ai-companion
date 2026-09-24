const test = require('node:test')
const assert = require('node:assert/strict')
const { GoalManager } = require('../src/goals')
const { LearningController, LearningOllamaClient, OAK_LOG_EXPERIMENT } = require('../src/learning')
const { OllamaRequestPreemptedError, StructuredResponseError, STRUCTURED_RESPONSE_STATUS } = require('../src/ollama')

function createFixture(overrides = {}) {
  let inventory = {}
  const saved = []
  const movement = {
    owner: 'NONE',
    learning: false,
    beginLearningSession() {
      if (this.owner === 'PLAYER' || this.owner === 'SURVIVAL') return false
      this.learning = true
      return true
    },
    endLearningSession() { this.learning = false; return true },
    getLocomotionOwner() { return this.owner }
  }
  const observer = {
    capture({ previousInventory = null } = {}) {
      const current = { ...inventory }
      const delta = {}
      for (const name of new Set([...Object.keys(previousInventory || current), ...Object.keys(current)])) {
        const change = (current[name] || 0) - ((previousInventory || current)[name] || 0)
        if (change) delta[name] = change
      }
      return { inventory: current, inventoryDelta: delta, nearbyBlocks: [], nearbyEntities: [], targetState: null }
    }
  }
  const memory = {
    async load() {},
    findRelevantSkills: () => [],
    async recordEpisode(episode) { saved.push(episode); return null },
    async updateSkillOutcome() {}
  }
  const logger = { info() {}, error() {} }
  const base = {
    movement,
    goalManager: new GoalManager(),
    observer,
    executor: {
      async execute() {
        inventory = { oak_log: 1 }
        return { success: true, reason: 'TEST' }
      }
    },
    client: {
      async decide() { return { action: 'OBSERVE' } },
      async reflect() { return { reflection: 'No change.', lesson: 'Try a different action.', nextApproach: 'Change target.' } }
    },
    memory,
    autonomy: { setSuppressed() {} },
    logger,
    config: { enabled: true, startDelayMs: 1000, maxActions: 5, maxDurationMs: 10000, repeatedActionLimit: 3 },
    now: (() => { let time = 0; return () => ++time })(),
    sleep: async () => {}
  }
  return { options: { ...base, ...overrides }, movement, saved, setInventory(value) { inventory = value } }
}

test('autonomous learning decisions use lower model priority than player tasks', async () => {
  const kinds = []
  const client = new LearningOllamaClient({
    ollama: { url: 'http://localhost/test', model: 'test', timeoutMs: 1000, responseRetries: 0 },
    scheduler: { schedule(kind) { kinds.push(kind); return Promise.reject(new Error('probe')) } }
  })
  const context = { observation: {}, attempts: [], learnedSkills: [] }
  await assert.rejects(client.decide({ ...context, goal: { source: 'AUTONOMOUS' } }), /probe/)
  await assert.rejects(client.decide({ ...context, goal: { source: 'PLAYER_TASK' } }), /probe/)
  assert.deepEqual(kinds, ['AUTONOMOUS_TASK_DECISION', 'PLAYER_TASK_DECISION'])
})

test('survival preempts learning and the stale decision is not executed', async () => {
  const fixture = createFixture()
  let releaseFirst
  let decisions = 0
  let executions = 0
  fixture.options.client = {
    decide: async () => {
      decisions += 1
      if (decisions === 1) return await new Promise(resolve => { releaseFirst = resolve })
      return { action: 'OBSERVE' }
    },
    reflect: async () => ({ reflection: 'x', lesson: 'y', nextApproach: 'z' })
  }
  fixture.options.executor = {
    async execute() {
      executions += 1
      fixture.setInventory({ oak_log: 1 })
      return { success: true }
    }
  }
  fixture.options.sleep = async () => { fixture.movement.owner = 'NONE' }
  const controller = new LearningController(fixture.options)
  const pending = controller.runExperiment()
  while (!releaseFirst) await Promise.resolve()
  fixture.movement.owner = 'SURVIVAL'
  releaseFirst({ action: 'OBSERVE' })
  const episode = await pending

  assert.equal(executions, 1)
  assert.equal(decisions, 2)
  assert.equal(episode.outcome, 'SUCCESS')
})

test('player cancellation invalidates an in-flight learning decision', async () => {
  const fixture = createFixture()
  let releaseDecision
  let executions = 0
  fixture.options.client = {
    decide: async () => await new Promise(resolve => { releaseDecision = resolve }),
    reflect: async () => ({ reflection: 'x', lesson: 'y', nextApproach: 'z' })
  }
  fixture.options.executor = { async execute() { executions += 1; return { success: true } } }
  const controller = new LearningController(fixture.options)
  const pending = controller.runExperiment(OAK_LOG_EXPERIMENT)
  while (!releaseDecision) await Promise.resolve()

  assert.equal(controller.cancel('PLAYER_CANCELLED'), true)
  fixture.movement.owner = 'PLAYER'
  releaseDecision({ action: 'OBSERVE' })
  const episode = await pending

  assert.equal(executions, 0)
  assert.equal(episode.outcome, 'CANCELLED')
  assert.equal(episode.terminationReason, 'PLAYER_CANCELLED')
  assert.equal(fixture.movement.learning, false)
})

test('player-preempted movement pauses learning without charging a failed attempt', async () => {
  const fixture = createFixture()
  let executions = 0
  fixture.options.client = { async decide() { return { action: 'EXPLORE', heading: 90, distance: 8 } },
    async reflect() { throw new Error('preemption must not be reflected as a failure') } }
  fixture.options.executor = { async execute() {
    executions += 1
    if (executions === 1) {
      fixture.movement.owner = 'PLAYER'
      return { success: false, reason: 'PLAYER_PREEMPTED' }
    }
    fixture.setInventory({ oak_log: 1 })
    return { success: true, reason: 'ARRIVED' }
  } }
  fixture.options.sleep = async () => { fixture.movement.owner = 'NONE' }
  const episode = await new LearningController(fixture.options).runExperiment()
  assert.equal(executions, 2)
  assert.equal(episode.outcome, 'SUCCESS')
  assert.equal(episode.attempts.length, 1)
  assert.equal(episode.attempts[0].evaluation.status, 'SUCCESS')
})

test('TASK_GOAL starts a PLAYER_TASK learning episode', async () => {
  const fixture = createFixture()
  const controller = new LearningController(fixture.options)
  const episode = await controller.startPlayerTask({ username: 'Steve', message: '帮我弄点木头' })

  assert.equal(episode.goal.source, 'PLAYER_TASK')
  assert.equal(episode.goal.requestedBy, 'Steve')
  assert.equal(episode.outcome, 'SUCCESS')
  assert.equal(fixture.saved[0].goal.source, 'PLAYER_TASK')
})

test('successful block interaction allows a brief server pickup update before objective evaluation', async () => {
  const fixture = createFixture()
  let settleCalls = 0
  fixture.options.client = { async decide() { return { action: 'DIG_BLOCK', target: 'block:1,64,0' } } }
  fixture.options.executor = { async execute() { return { success: true, reason: 'DIG_COMPLETED' } } }
  fixture.options.sleep = async duration => {
    if (duration === 300) {
      settleCalls += 1
      fixture.setInventory({ oak_log: 1 })
    }
  }
  const episode = await new LearningController(fixture.options).runExperiment()
  assert.equal(episode.outcome, 'SUCCESS')
  assert.equal(settleCalls, 1)
  assert.equal(episode.attempts[0].observationAfter.inventoryDelta.oak_log, 1)
})

test('grounded reflection receives the actual primitive result reason', async () => {
  const fixture = createFixture()
  let reflected = null
  fixture.options.executor = { async execute() { return { success: true, reason: 'ALREADY_NEAR_TARGET' } } }
  fixture.options.client = {
    async decide() { return { action: 'OBSERVE' } },
    async reflect(context) {
      reflected = context
      return { reflection: 'No change.', lesson: 'Distance was already satisfied.', nextApproach: 'Try another primitive.' }
    }
  }
  fixture.options.config = { ...fixture.options.config, maxActions: 1 }
  await new LearningController(fixture.options).runExperiment()
  assert.equal(reflected.actionResult.reason, 'ALREADY_NEAR_TARGET')
})

test('approaching an observed dropped item allows pickup evidence to arrive before evaluation', async () => {
  const fixture = createFixture()
  let count = 0
  let settleCalls = 0
  fixture.options.observer = { capture({ previousInventory = null } = {}) {
    const inventory = count ? { oak_log: count } : {}
    return {
      inventory,
      inventoryDelta: { ...(previousInventory && count > (previousInventory.oak_log || 0) ? { oak_log: count - (previousInventory.oak_log || 0) } : {}) },
      nearbyBlocks: [],
      nearbyEntities: [{ ref: 'entity:7', name: 'item', droppedItem: { name: 'oak_log', count: 1 } }]
    }
  } }
  fixture.options.client = { async decide() { return { action: 'MOVE_NEAR', target: 'entity:7', distance: 1 } } }
  fixture.options.executor = { async execute() { return { success: true, reason: 'REACHED_TARGET' } } }
  fixture.options.sleep = async duration => {
    if (duration === 300) { settleCalls += 1; count = 1 }
  }
  const episode = await new LearningController(fixture.options).runExperiment()
  assert.equal(episode.outcome, 'SUCCESS')
  assert.equal(settleCalls, 1)
  assert.equal(episode.attempts[0].observationAfter.inventoryDelta.oak_log, 1)
})

test('post-action settling cannot turn a result beyond the episode deadline into success', async () => {
  const fixture = createFixture()
  let time = 0
  fixture.options.now = () => time
  fixture.options.config = { ...fixture.options.config, maxDurationMs: 100, observationSettleMs: 300 }
  fixture.options.client = { async decide() { return { action: 'DIG_BLOCK', target: 'block:1,64,0' } } }
  fixture.options.executor = { async execute() { return { success: true, reason: 'DIG_COMPLETED' } } }
  fixture.options.sleep = async duration => {
    if (duration === 300) { time = 101; fixture.setInventory({ oak_log: 1 }) }
  }
  const episode = await new LearningController(fixture.options).runExperiment()
  assert.equal(episode.outcome, 'FAILURE')
  assert.equal(episode.terminationReason, 'TIME_BUDGET_EXCEEDED')
})

test('finishing an old episode does not unsuppress autonomy over a queued player task', async () => {
  const fixture = createFixture()
  const suppression = []
  let releaseFirstSave
  let firstSaveStarted
  const firstSave = new Promise(resolve => { firstSaveStarted = resolve })
  let saves = 0
  fixture.options.autonomy = { setSuppressed(value) { suppression.push(value) } }
  fixture.options.memory = {
    async load() {}, findRelevantSkills: () => [],
    async recordEpisode() {
      saves += 1
      if (saves === 1) {
        firstSaveStarted()
        await new Promise(resolve => { releaseFirstSave = resolve })
      }
      return null
    }
  }
  const controller = new LearningController(fixture.options)
  const old = controller.runExperiment()
  await firstSave
  const player = controller.startPlayerTask({ username: 'Steve', message: '帮我弄点木头' })
  releaseFirstSave()
  await old
  assert.equal(controller.pendingPlayerTask !== null, true)
  assert.equal(suppression.at(-1), true)
  await player
  assert.equal(suppression.at(-1), false)
})

test('CANCEL_TASK cancels a pending player task before it acquires locomotion', async () => {
  const fixture = createFixture()
  fixture.movement.owner = 'PLAYER'
  let releaseWait
  fixture.options.sleep = async () => await new Promise(resolve => { releaseWait = resolve })
  const controller = new LearningController(fixture.options)
  const pending = controller.startPlayerTask({ username: 'Steve', message: '帮我弄点木头' })
  while (!releaseWait) await Promise.resolve()

  assert.equal(controller.getTaskSummary().outcome, 'PENDING')
  assert.equal(controller.cancel('PLAYER_CANCELLED'), true)
  releaseWait()
  assert.equal(await pending, null)
  assert.equal(controller.getTaskSummary(), null)
})

test('partial progress yields for conversation and does not trigger reflection', async () => {
  const fixture = createFixture()
  let decisions = 0
  let reflections = 0
  let yieldedBetweenActions = false
  fixture.options.client = {
    async decide() {
      decisions += 1
      if (decisions === 2) assert.equal(yieldedBetweenActions, true)
      return { action: 'OBSERVE' }
    },
    async reflect() { reflections += 1; return { reflection: 'x', lesson: 'y', nextApproach: 'z' } }
  }
  fixture.options.executor = {
    async execute() {
      fixture.setInventory({ oak_log: decisions })
      return { success: true }
    }
  }
  fixture.options.sleep = async duration => {
    if (duration === 0 && decisions === 1) yieldedBetweenActions = true
  }
  const controller = new LearningController(fixture.options)
  const goal = { ...OAK_LOG_EXPERIMENT, objective: { type: 'INVENTORY_AT_LEAST', item: 'oak_log', count: 2 } }
  const episode = await controller.runExperiment(goal)

  assert.equal(episode.outcome, 'SUCCESS')
  assert.equal(decisions, 2)
  assert.equal(reflections, 0)
})

test('preempted model request consumes no action budget and the episode resumes', async () => {
  const fixture = createFixture()
  let decisions = 0
  let executions = 0
  fixture.options.client = {
    async decide() {
      decisions += 1
      if (decisions === 1) throw new OllamaRequestPreemptedError(undefined, { preemptedBy: 'PLAYER_CONVERSATION' })
      return { action: 'OBSERVE' }
    },
    async reflect() { return { reflection: 'x', lesson: 'y', nextApproach: 'z' } }
  }
  fixture.options.executor = {
    async execute() {
      executions += 1
      fixture.setInventory({ oak_log: 1 })
      return { success: true }
    }
  }
  const controller = new LearningController(fixture.options)
  const episode = await controller.runExperiment()

  assert.equal(episode.outcome, 'SUCCESS')
  assert.equal(decisions, 2)
  assert.equal(executions, 1)
  assert.equal(episode.attempts.length, 1)
})

test('schema-invalid model response executes no primitive and ends with a specific reason', async () => {
  const fixture = createFixture()
  let executions = 0
  fixture.options.client = {
    async decide() {
      throw new StructuredResponseError(STRUCTURED_RESPONSE_STATUS.SCHEMA_INVALID, 'bad action')
    }
  }
  fixture.options.executor = { async execute() { executions += 1; return { success: true } } }
  const controller = new LearningController(fixture.options)
  const episode = await controller.runExperiment()

  assert.equal(executions, 0)
  assert.equal(episode.attempts.length, 0)
  assert.equal(episode.outcome, 'FAILURE')
  assert.equal(episode.terminationReason, 'MODEL_RESPONSE_FAILURE:SCHEMA_INVALID')
})

test('learning episode survives a recoverable empty model response', async () => {
  const fixture = createFixture()
  let calls = 0
  fixture.options.client = new LearningOllamaClient({
    ollama: {
      url: 'http://ollama.test/api/chat',
      model: 'test',
      timeoutMs: 1000,
      responseRetries: 1,
      retryBackoffMs: 0,
      think: false
    },
    fetchFn: async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        message: { content: ++calls === 1 ? '' : '{"action":"OBSERVE"}', thinking: '' },
        done: true
      })
    })
  })
  const controller = new LearningController(fixture.options)
  const episode = await controller.runExperiment()

  assert.equal(calls, 2)
  assert.equal(episode.outcome, 'SUCCESS')
  assert.equal(episode.attempts.length, 1)
})

test('truncated optional reflection does not erase a real action or end the episode', async () => {
  const fixture = createFixture()
  let actions = 0
  fixture.options.client = {
    async decide() { return { action: 'OBSERVE' } },
    async reflect() {
      throw new StructuredResponseError(STRUCTURED_RESPONSE_STATUS.INVALID_JSON, 'truncated reflection')
    }
  }
  fixture.options.executor = { async execute() {
    actions += 1
    if (actions === 2) fixture.setInventory({ oak_log: 1 })
    return { success: true, reason: 'OBSERVATION_CAPTURED' }
  } }
  const episode = await new LearningController(fixture.options).runExperiment()
  assert.equal(episode.outcome, 'SUCCESS')
  assert.equal(episode.attempts.length, 2)
  assert.equal(episode.attempts[0].reflection, null)
  assert.equal(episode.attempts[0].evaluation.status, 'NO_PROGRESS')
})

test('controller preserves the model decision after supplying repeated-failure context', async () => {
  const fixture = createFixture()
  const contexts = []
  const executed = []
  fixture.options.config = { ...fixture.options.config, repeatedActionLimit: 4 }
  fixture.options.client = {
    async decide(context) {
      contexts.push(context)
      return { action: 'OBSERVE' }
    },
    async reflect() {
      return {
        reflection: 'Nothing new was observed.',
        lesson: 'Repeated observation found no new target.',
        nextApproach: 'Explore a different nearby region.'
      }
    }
  }
  fixture.options.executor = {
    async execute(action) {
      executed.push(action)
      if (executed.length === 4) fixture.setInventory({ oak_log: 1 })
      return { success: true, reason: 'TEST' }
    }
  }
  const controller = new LearningController(fixture.options)
  const episode = await controller.runExperiment()

  assert.equal(contexts[1].attempts[0].reflection.lesson, 'Repeated observation found no new target.')
  assert.equal(contexts[3].repetitionThreshold, 3)
  assert.deepEqual(executed[3], { action: 'OBSERVE' })
  assert.equal(episode.outcome, 'SUCCESS')
})
