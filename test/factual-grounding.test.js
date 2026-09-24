const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { answerFactualQuestion } = require('../src/agent/factual-answer')
const { checkWorldClaim } = require('../src/agent/world-claims')
const { createAgent } = require('../src/agent')
const { SpeechController } = require('../src/autonomy/speech-controller')
const { groundMovementReply } = require('../src/agent/action-claims')

function facts(overrides = {}) {
  return { bot: { game: { dimension: 'overworld' }, time: { timeOfDay: 6000 }, isRaining: false, ...overrides }, movement: {} }
}

test('factual weather uses current precipitation/thunder, not sunny prose or prior messages', () => {
  const state = facts()
  assert.match(answerFactualQuestion('天气怎么样？', state).reply, /没有降水/)
  state.bot.isRaining = true
  assert.match(answerFactualQuestion('现在下雨吗', state).reply, /降水天气/)
  state.bot.thunderState = 1
  assert.match(answerFactualQuestion('天气如何', state).reply, /雷暴/)
  delete state.bot.isRaining
  assert.match(answerFactualQuestion('天气怎么样', state).reply, /不能确定/)
})

test('factual day/night handles transitions and unknown or non-overworld state', () => {
  for (const [time, phase] of [[6000, '白天'], [12500, '接近入夜'], [14000, '夜晚'], [23500, '快天亮']]) {
    assert.match(answerFactualQuestion('现在是白天还是晚上？', facts({ time: { timeOfDay: time } })).reply, new RegExp(phase))
  }
  assert.match(answerFactualQuestion('现在晚上吗', facts({ time: {} })).reply, /没拿到/)
  assert.match(answerFactualQuestion('现在白天吗', facts({ game: { dimension: 'the_nether' } })).reply, /不能按主世界/)
})

test('preferences, hypotheses and compound commands are not stolen by factual routing', () => {
  for (const message of ['你喜欢下雨吗？', '如果现在下雨怎么办？', '跟我来然后告诉我天气怎么样', '睡觉', '起床']) {
    assert.equal(answerFactualQuestion(message, facts()), null)
  }
})

test('sleep and behavior answers distinguish server state, survival and intent from completion', () => {
  assert.match(answerFactualQuestion('你起床了吗', facts({ isSleeping: true })).reply, /还在床上/)
  assert.match(answerFactualQuestion('你在睡觉吗', facts()).reply, /还没确认/)
  const state = facts()
  state.movement.getBehaviorSummary = () => ({ type: 'FOLLOW', locomotionOwner: 'SURVIVAL' })
  assert.match(answerFactualQuestion('你在干嘛', state).reply, /危险/)
  state.movement.getBehaviorSummary = () => ({ type: 'COME', locomotionOwner: 'PLAYER' })
  assert.match(answerFactualQuestion('你在做什么', state).reply, /不能说已经到了/)
})

test('present world claims are checked against live facts without treating preferences as facts', () => {
  const { bot } = facts({ time: { timeOfDay: 14000 }, isRaining: true })
  assert.equal(checkWorldClaim('现在是白天，阳光明媚', bot).valid, false)
  assert.equal(checkWorldClaim('现在天气晴朗', bot).valid, false)
  assert.equal(checkWorldClaim('现在是雷暴', bot).valid, false)
  assert.equal(checkWorldClaim('现在是夜晚', bot).valid, true)
  assert.equal(checkWorldClaim('我喜欢晴天', bot).valid, true)
  assert.equal(checkWorldClaim('如果现在是白天，我们就出去', bot).valid, true)
  assert.equal(checkWorldClaim('现在是白天', {}).valid, false)
})

test('accepted movement is not arrival, and survival owns truthful STOP acknowledgement', () => {
  const state = {
    action: 'COME', bot: { entity: { position: { x: 0, y: 0, z: 0 } }, players: { Steve: { entity: { position: { x: 20, y: 0, z: 0 } } } } },
    movement: { getBehaviorSummary: () => ({ type: 'COME', username: 'Steve', locomotionOwner: 'PLAYER' }) }
  }
  assert.match(groundMovementReply('已经到你身边了。', state), /还没确认/)
  state.bot.players.Steve.entity.position.x = 2
  assert.equal(groundMovementReply('已经到你身边了。', state), '已经到你身边了。')
  state.movement.getBehaviorSummary = () => ({ type: 'STOP', locomotionOwner: 'SURVIVAL' })
  assert.match(groundMovementReply('停好了。', { ...state, action: 'STOP' }), /危险/)
})

test('autonomous contradictory weather is withheld without consuming speech cooldown', () => {
  const messages = []
  const speech = new SpeechController({ isRaining: true, chat: text => messages.push(text) }, {
    cooldownMs: 60000, dedupMs: 300000, logger: { info() {} }, now: () => 10000
  })
  assert.equal(speech.say('现在天气晴朗'), false)
  assert.equal(speech.lastResult.reason, 'UNSUPPORTED_WORLD_CLAIM')
  assert.equal(speech.say('一起玩挺好的'), true)
  assert.deepEqual(messages, ['一起玩挺好的'])
})

function agentFixture(t, movementResult = true) {
  const oldFetch = global.fetch
  t.after(() => { global.fetch = oldFetch })
  const bot = Object.assign(new EventEmitter(), facts().bot, { username: 'AI_Companion' })
  const chats = []
  bot.chat = text => chats.push(text)
  let epoch = 0
  let moves = 0
  const movement = {
    getPlayerCommandEpoch: () => epoch,
    getBehaviorSummary: () => ({ type: 'STOP', source: 'PLAYER', locomotionOwner: 'PLAYER' }),
    follow: () => { moves++; if (movementResult) epoch++; return movementResult },
    stop: () => { moves++; epoch++; return true }
  }
  const agent = createAgent({ bot, movement, survival: { observePlayer() {}, cancelPursuit() {} },
    logger: { info() {}, error: error => assert.fail(String(error)) },
    config: { url: 'http://localhost/test', model: 'test', timeoutMs: 1000, responseRetries: 0 } })
  agent.start(); t.after(() => agent.stop())
  return { bot, chats, agent, movement, moves: () => moves }
}

test('weather questions bypass Ollama and cannot issue a locomotion command', t => {
  const f = agentFixture(t)
  global.fetch = () => assert.fail('factual query must not need a model')
  f.bot.emit('chat', 'Steve', '天气怎么样？')
  f.bot.isRaining = true
  f.bot.emit('chat', 'Steve', '天气怎么样？')
  assert.match(f.chats[0], /没有降水/)
  assert.match(f.chats[1], /降水天气/)
  assert.equal(f.moves(), 0)
})

test('rejected immediate movement cannot be reported as successfully executed', async t => {
  const f = agentFixture(t, false)
  global.fetch = () => assert.fail('rejected immediate movement needs no model acknowledgement')
  f.bot.emit('chat', 'Steve', '跟我来')
  await new Promise(resolve => setImmediate(resolve))
  assert.match(f.chats.at(-1), /没看到你/)
  assert.ok(!f.chats.includes('我已经跟上你了。'))
})

test('old command acknowledgement is dropped if a new STOP arrives while thinking', async t => {
  const f = agentFixture(t)
  let release
  let requests = 0
  const response = text => ({ ok: true, text: async () => JSON.stringify({ message: { content: JSON.stringify({ action: 'CHAT', reply: text }) } }) })
  global.fetch = async () => ++requests === 1 ? new Promise(resolve => { release = resolve }) : response('好，等着。')
  f.bot.emit('chat', 'Steve', '跟我来')
  await new Promise(resolve => setImmediate(resolve))
  f.bot.emit('chat', 'Steve', '停下')
  release(response('我已经跟上你了。'))
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(!f.chats.includes('我已经跟上你了。'))
  assert.ok(f.chats.includes('好，等着。'))
})
