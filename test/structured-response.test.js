const test = require('node:test')
const assert = require('node:assert/strict')
const {
  requestStructured,
  parseStructuredContent,
  STRUCTURED_RESPONSE_STATUS,
  OllamaRequestScheduler,
  OllamaRequestPreemptedError
} = require('../src/ollama')

const schema = {
  type: 'object',
  properties: { action: { const: 'OBSERVE' } },
  required: ['action'],
  additionalProperties: false
}
const validate = value => {
  if (value?.action !== 'OBSERVE' || Object.keys(value).length !== 1) throw new Error('Expected exact OBSERVE action')
  return value
}
const ollama = {
  url: 'http://ollama.test/api/chat',
  model: 'test',
  timeoutMs: 1000,
  responseRetries: 0,
  retryBackoffMs: 0
}

function response(content, overrides = {}, thinking = 'separate reasoning') {
  const envelope = { message: { role: 'assistant', content, thinking }, done: true }
  return { ok: true, status: 200, text: async () => JSON.stringify(envelope), ...overrides }
}

function request(fetchFn, overrides = {}) {
  return requestStructured({
    ollama,
    kind: 'AUTONOMY',
    owner: 'test',
    label: 'TEST decision',
    system: 'Return one action.',
    payload: {},
    schema,
    validate,
    fetchFn,
    ...overrides
  })
}

test('structured response rejects empty content without calling JSON.parse on it', async () => {
  await assert.rejects(request(async () => response('')), error => error.status === STRUCTURED_RESPONSE_STATUS.EMPTY_RESPONSE)
})

test('structured request consistently uses non-streaming JSON schema output', async () => {
  let body
  await request(async (_url, options) => {
    body = JSON.parse(options.body)
    return response('{"action":"OBSERVE"}')
  })
  assert.equal(body.stream, false)
  assert.equal(body.think, false)
  assert.deepEqual(body.format, schema)
})

test('structured response distinguishes an empty HTTP body', async () => {
  await assert.rejects(request(async () => ({ ok: true, status: 200, text: async () => '' })), error => {
    return error.status === STRUCTURED_RESPONSE_STATUS.EMPTY_RESPONSE && error.details.httpStatus === 200
  })
})

test('structured response preserves Ollama HTTP status and error body metadata', async () => {
  await assert.rejects(request(async () => ({ ok: false, status: 503, text: async () => 'busy' })), error => {
    return error.status === STRUCTURED_RESPONSE_STATUS.OLLAMA_ERROR &&
      error.details.httpStatus === 503 && error.details.bodyPreview === 'busy'
  })
})

test('structured response classifies truncated JSON', async () => {
  await assert.rejects(request(async () => response('{"action":"OBSERVE"')), error => error.status === STRUCTURED_RESPONSE_STATUS.INVALID_JSON)
})

test('structured response accepts markdown-fenced JSON', () => {
  assert.deepEqual(parseStructuredContent('```json\n{"action":"OBSERVE"}\n```', validate).value, { action: 'OBSERVE' })
})

test('structured response extracts one JSON object from surrounding prose', () => {
  assert.deepEqual(parseStructuredContent('Here is the decision: {"action":"OBSERVE"} done.', validate).value, { action: 'OBSERVE' })
})

test('schema-valid qwen output in the thinking compatibility channel is accepted', async () => {
  const result = await request(async () => response('', {}, '{"action":"OBSERVE"}'))
  assert.deepEqual(result, { action: 'OBSERVE' })
})

test('schema-invalid JSON in the thinking channel remains schema-invalid', async () => {
  await assert.rejects(
    request(async () => response('', {}, '{"action":"EXEC","command":"rm"}')),
    error => error.status === STRUCTURED_RESPONSE_STATUS.SCHEMA_INVALID
  )
})

test('structured response rejects schema-invalid JSON', async () => {
  await assert.rejects(request(async () => response('{"action":"EXEC","command":"rm"}')), error => error.status === STRUCTURED_RESPONSE_STATUS.SCHEMA_INVALID)
})

test('structured response classifies an independently aborted request', async () => {
  const controller = new AbortController()
  const pending = requestStructured({
    ollama,
    kind: 'AUTONOMY',
    owner: 'test',
    label: 'TEST decision',
    system: 'x',
    payload: {},
    schema,
    validate,
    fetchFn: async (_url, options) => await new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
      controller.abort()
    }),
    scheduler: { schedule: (_kind, execute) => execute({ signal: controller.signal }) }
  })
  await assert.rejects(pending, error => error.status === STRUCTURED_RESPONSE_STATUS.ABORTED)
})

test('player conversation preemption stays distinct from model failure', async () => {
  const scheduler = new OllamaRequestScheduler()
  let learningStarted = false
  const learning = request(async (_url, options) => await new Promise((resolve, reject) => {
    learningStarted = true
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
  }), { scheduler, kind: 'AUTONOMY', owner: 'learning', label: 'LEARNING decision' })
  while (!learningStarted) await Promise.resolve()
  const conversation = scheduler.schedule('PLAYER_CONVERSATION', async () => 'ok')
  assert.equal(await conversation, 'ok')
  await assert.rejects(learning, error => error instanceof OllamaRequestPreemptedError && error.preemptedBy === 'PLAYER_CONVERSATION')
})

test('empty response retry can recover', async () => {
  let calls = 0
  const result = await request(async () => response(++calls === 1 ? '' : '{"action":"OBSERVE"}'), {
    retries: 1,
    backoffMs: 0
  })
  assert.deepEqual(result, { action: 'OBSERVE' })
  assert.equal(calls, 2)
})

test('invalid JSON retry exhaustion preserves the specific status', async () => {
  let calls = 0
  await assert.rejects(request(async () => {
    calls += 1
    return response('{')
  }, { retries: 2, backoffMs: 0 }), error => error.status === STRUCTURED_RESPONSE_STATUS.INVALID_JSON)
  assert.equal(calls, 3)
})
