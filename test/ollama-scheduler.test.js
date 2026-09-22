const test = require('node:test')
const assert = require('node:assert/strict')
const { OllamaRequestScheduler, OllamaRequestPreemptedError, OLLAMA_REQUEST_PRIORITIES } = require('../src/ollama')

test('Ollama request priorities keep player-facing work first', () => {
  assert.ok(OLLAMA_REQUEST_PRIORITIES.PLAYER_VISUAL_PERCEPTION > OLLAMA_REQUEST_PRIORITIES.PLAYER_CONVERSATION)
  assert.ok(OLLAMA_REQUEST_PRIORITIES.PLAYER_CONVERSATION > OLLAMA_REQUEST_PRIORITIES.PLAYER_TASK_DECISION)
  assert.ok(OLLAMA_REQUEST_PRIORITIES.PLAYER_TASK_DECISION > OLLAMA_REQUEST_PRIORITIES.TASK_VISUAL_PERCEPTION)
  assert.ok(OLLAMA_REQUEST_PRIORITIES.TASK_VISUAL_PERCEPTION > OLLAMA_REQUEST_PRIORITIES.LEARNING_REFLECTION)
  assert.ok(OLLAMA_REQUEST_PRIORITIES.LEARNING_REFLECTION > OLLAMA_REQUEST_PRIORITIES.BACKGROUND_VISUAL_PERCEPTION)
  assert.ok(OLLAMA_REQUEST_PRIORITIES.BACKGROUND_VISUAL_PERCEPTION > OLLAMA_REQUEST_PRIORITIES.AUTONOMY)
  assert.ok(OLLAMA_REQUEST_PRIORITIES.PLAYER_TASK_DECISION > OLLAMA_REQUEST_PRIORITIES.LEARNING_REFLECTION)
  assert.ok(OLLAMA_REQUEST_PRIORITIES.LEARNING_REFLECTION > OLLAMA_REQUEST_PRIORITIES.AUTONOMY)
})

test('player conversation preempts a running autonomy request', async () => {
  const scheduler = new OllamaRequestScheduler()
  let autonomyStarted = false
  const autonomy = scheduler.schedule('AUTONOMY', ({ signal }) => new Promise((resolve, reject) => {
    autonomyStarted = true
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  }))
  const rejectedAutonomy = assert.rejects(autonomy, OllamaRequestPreemptedError)
  while (!autonomyStarted) await Promise.resolve()

  const conversation = scheduler.schedule('PLAYER_CONVERSATION', async () => 'conversation')
  assert.equal(await conversation, 'conversation')
  await rejectedAutonomy
})

test('autonomy waits while learning reflection owns the model', async () => {
  const scheduler = new OllamaRequestScheduler()
  let releaseReflection
  let autonomyStarted = false
  const reflection = scheduler.schedule('LEARNING_REFLECTION', async () => await new Promise(resolve => {
    releaseReflection = resolve
  }))
  while (!releaseReflection) await Promise.resolve()
  const autonomy = scheduler.schedule('AUTONOMY', async () => {
    autonomyStarted = true
    return 'autonomy'
  })

  await Promise.resolve()
  assert.equal(autonomyStarted, false)
  releaseReflection('reflection')
  assert.equal(await reflection, 'reflection')
  assert.equal(await autonomy, 'autonomy')
})

test('task decisions and learning reflection immediately preempt background vision', async () => {
  for (const kind of ['PLAYER_TASK_DECISION', 'LEARNING_REFLECTION']) {
    const scheduler = new OllamaRequestScheduler()
    let started = false
    const visual = scheduler.schedule('BACKGROUND_VISUAL_PERCEPTION', ({ signal }) => new Promise((resolve, reject) => {
      started = true
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    }))
    const rejected = assert.rejects(visual, OllamaRequestPreemptedError)
    while (!started) await Promise.resolve()
    assert.equal(await scheduler.schedule(kind, async () => kind), kind)
    await rejected
  }
})
