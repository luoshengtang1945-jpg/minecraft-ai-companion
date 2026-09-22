const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { OllamaClient } = require('../src/agent/ollama-client')
const { isRepeatedReply, hasReversedFollowReply, validateReply } = require('../src/agent/reply-variety')
const { AutonomyController } = require('../src/autonomy/autonomy-controller')
const { SpeechController } = require('../src/autonomy/speech-controller')
const { AutonomyOllamaClient } = require('../src/autonomy/ollama-client')
const { personality } = require('../src/personality')
const config = { url: 'http://localhost/test', model: 'test', timeoutMs: 1000, responseRetries: 0 }

function modelReplies(t, values) {
  const original = global.fetch
  t.after(() => { global.fetch = original })
  const requests = []
  global.fetch = async (url, options) => {
    requests.push(JSON.parse(options.body))
    const value = values.shift()
    if (value instanceof Error) throw value
    assert.ok(value, 'unexpected extra inference')
    return { ok: true, text: async () => JSON.stringify({ message: { content: JSON.stringify(value) } }) }
  }
  return requests
}

test('reply dedup ignores punctuation and includes repeated short acknowledgements', () => {
  assert.equal(isRepeatedReply('我在跟着你！', ['我在跟着你。']), true)
  assert.equal(isRepeatedReply('好。', ['好']), true)
  assert.equal(isRepeatedReply('你走前面，我跟着。', ['我在跟着你']), false)
  assert.throws(() => validateReply({ reply: '我跟着', action: 'ATTACK' }))
  assert.throws(() => validateReply({ reply: '' }))
  for (const reply of ['跟上，别掉队', '好，跟紧点', '跟紧点，别走散', '你跟紧我']) {
    assert.equal(hasReversedFollowReply('FOLLOW', reply), true)
  }
  assert.equal(hasReversedFollowReply('FOLLOW', '我跟紧你'), false)
  assert.equal(hasReversedFollowReply('CHAT', '跟紧点'), false)
})

test('duplicate conversation gets one reply-only revision without changing the action', async t => {
  const requests = modelReplies(t, [
    { action: 'FOLLOW', reply: '我在跟着你。' },
    { action: 'FOLLOW', reply: '我在跟着你！' },
    { reply: '我会跟着，你走前面。' }
  ])
  const client = new OllamaClient(config)
  await client.decide('Steve', '跟着我')
  const decision = await client.decide('Steve', '跟着我')
  assert.deepEqual(decision, { action: 'FOLLOW', reply: '我会跟着，你走前面。' })
  assert.equal(requests.length, 3)
  assert.deepEqual(Object.keys(requests[2].format.properties), ['reply'])
  assert.equal(requests[0].options.temperature, 0.5)
  assert.equal(requests[2].options.temperature, 0.7)
})

test('repeated repair is suppressed and does not loop or discard the original action', async t => {
  const requests = modelReplies(t, [
    { action: 'FOLLOW', reply: '我在跟着你。' },
    { action: 'FOLLOW', reply: '我在跟着你。' },
    { reply: '我在跟着你！' }
  ])
  const client = new OllamaClient(config)
  await client.decide('Steve', '跟着我')
  assert.deepEqual(await client.decide('Steve', '跟着我'), { action: 'FOLLOW', reply: '' })
  assert.equal(requests.length, 3)
})

test('invalid revision cannot introduce a new tool or action', async t => {
  modelReplies(t, [
    { action: 'CHAT', reply: '我就在你旁边。' },
    { action: 'CHAT', reply: '我就在你旁边。' },
    { reply: '开始攻击', action: 'ATTACK' }
  ])
  const client = new OllamaClient(config)
  await client.decide('Steve', '你好')
  assert.deepEqual(await client.decide('Steve', '你好'), { action: 'CHAT', reply: '' })
})

test('a reversed FOLLOW acknowledgement is rewritten without reversing the actual action', async t => {
  modelReplies(t, [{ action: 'FOLLOW', reply: '跟上，别掉队。' }, { reply: '我跟着你走。' }])
  const client = new OllamaClient(config)
  assert.deepEqual(await client.decide('Steve', '跟着我'), { action: 'FOLLOW', reply: '我跟着你走。' })
})

test('empty conversation reply gets a single text-only repair', async t => {
  const requests = modelReplies(t, [{ action: 'CHAT', reply: '' }, { reply: '我更喜欢晴天。' }])
  assert.equal((await new OllamaClient(config).decide('Steve', '喜欢晴天吗')).reply, '我更喜欢晴天。')
  assert.equal(requests.length, 2)
})

test('player-owned autonomy uses speech-only schema and validates it independently', async t => {
  const requests = modelReplies(t, [
    { action: 'SAY', message: '开始下雨了', reason: 'new_rain' },
    { action: 'FOLLOW_PLAYER' }
  ])
  const client = new AutonomyOllamaClient({ ollama: config, personality })
  const state = { behavior: { locomotionOwner: 'PLAYER' } }
  assert.equal((await client.decide(state)).action, 'SAY')
  assert.deepEqual(requests[0].format.properties.action.enum, ['SAY', 'IDLE'])
  await assert.rejects(client.decide(state), /cannot control movement/)
})

test('unowned autonomy retains existing action schema and deterministic temperature', async t => {
  const requests = modelReplies(t, [{ action: 'IDLE' }])
  await new AutonomyOllamaClient({ ollama: config, personality }).decide({ behavior: { locomotionOwner: 'NONE' } })
  assert.ok(requests[0].format.properties.action.enum.includes('FOLLOW_PLAYER'))
  assert.equal(requests[0].options.temperature, 0)
})

test('disabled autonomy clearly reports that proactive conversation is disabled', () => {
  const logs = []
  const controller = new AutonomyController({ config: { enabled: false }, logger: { info: text => logs.push(text) } })
  assert.equal(controller.start(), false)
  assert.match(logs[0], /AUTONOMY_ENABLED=false/)
})

test('autonomy can emit speech during FOLLOW without owning or changing locomotion', async t => {
  const bot = new EventEmitter()
  const goals = new EventEmitter()
  goals.current = { source: 'PLAYER', type: 'FOLLOW' }
  const logs = []
  const state = { behavior: { type: 'FOLLOW', locomotionOwner: 'PLAYER' } }
  let executed = 0
  const controller = new AutonomyController({ bot, goalManager: goals,
    worldState: { build: () => state }, client: { decide: async received => {
      assert.equal(received.autonomyTrigger, 'weather')
      return { action: 'SAY', message: '开始下雨了', reason: 'new_rain' }
    } }, actions: { execute: async decision => { assert.equal(decision.action, 'SAY'); executed++; return { executed: true } } },
    movement: { getAutonomyEpoch: () => 0 }, journal: { record() {} },
    logger: { info: text => logs.push(text), throttled() {} }, config: { enabled: true, intervalMs: 600000, eventMinGapMs: 0 } })
  controller.start()
  t.after(() => controller.stop())
  await controller.trigger('weather')
  assert.equal(executed, 1)
  assert.equal(goals.current.type, 'FOLLOW')
})

test('speech diagnostics distinguish recent conversation from cooldown and topic dedup', () => {
  let now = 0
  const speech = new SpeechController({ chat() {} }, { cooldownMs: 1000, dedupMs: 5000, now: () => now, logger: { info() {} } })
  assert.equal(speech.say('开始下雨了', 'rain'), true)
  assert.equal(speech.say('夜晚来了', 'night'), false)
  assert.equal(speech.lastResult.reason, 'SPEECH_COOLDOWN')
  now = 1500
  assert.equal(speech.say('还在下雨', 'rain'), false)
  assert.equal(speech.lastResult.reason, 'TOPIC_DEDUP')
  speech.session = { canSpeakProactively: () => false, speechReadiness: () => ({ reason: 'CONVERSATION_GAP' }) }
  assert.equal(speech.say('夜晚来了', 'night'), false)
  assert.equal(speech.lastResult.reason, 'CONVERSATION_GAP')
})
