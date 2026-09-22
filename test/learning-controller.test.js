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

test('TASK_GOAL starts a PLAYER_TASK learning episode', async () => {
  const fixture = createFixture()
  const controller = new LearningController(fixture.options)
  const episode = await controller.startPlayerTask({ username: 'Steve', message: '帮我弄点木头' })

  assert.equal(episode.goal.source, 'PLAYER_TASK')
  assert.equal(episode.goal.requestedBy, 'Steve')
  assert.equal(episode.outcome, 'SUCCESS')
  assert.equal(fixture.saved[0].goal.source, 'PLAYER_TASK')
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
