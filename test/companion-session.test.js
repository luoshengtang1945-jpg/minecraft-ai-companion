const test = require('node:test')
const assert = require('node:assert/strict')
const { CompanionSessionContext } = require('../src/companion/session-context')
const { SpeechController } = require('../src/autonomy/speech-controller')
const { WorldStateBuilder } = require('../src/autonomy/world-state')
const { OllamaClient } = require('../src/agent/ollama-client')
const { createAgent, isRedundantMovementDecision } = require('../src/agent')
const { EventEmitter } = require('node:events')

function fixture() {
  let now = 0
  let callback
  let cleared = 0
  const behavior = { type: 'FOLLOW', username: 'Steve', source: 'PLAYER', locomotionOwner: 'PLAYER' }
  const position = { x: 3, y: 64, z: 0 }
  const bot = {
    username: 'AI_Companion', entity: { position: { x: 0, y: 64, z: 0, distanceTo: () => 3 } },
    players: { Steve: { entity: { position, heldItem: { name: 'iron_pickaxe' } } } }
  }
  const movement = { getBehaviorSummary: () => ({ ...behavior }) }
  const session = new CompanionSessionContext({ bot, movement, now: () => now,
    setIntervalFn: fn => { callback = fn; return 1 }, clearIntervalFn: () => { cleared++ } })
  return { session, bot, movement, behavior, position, clock: value => { now = value }, now: () => now,
    tick: () => callback(), cleared: () => cleared }
}

test('session detects actual position changes without remote velocity and does not infer tool use', () => {
  const f = fixture()
  f.session.start()
  assert.equal(f.session.snapshot().player.activity, 'UNKNOWN')
  f.clock(1000); f.position.x = 5; f.tick()
  assert.equal(f.session.snapshot().player.activity, 'MOVING')
  f.clock(4000); f.tick()
  assert.equal(f.session.snapshot().player.activity, 'STATIONARY')
  assert.equal(f.session.snapshot().player.heldItem, 'iron_pickaxe')
})

test('session observes FOLLOW, survival interruption and STOP without owning locomotion', () => {
  const f = fixture()
  f.session.start()
  assert.equal(f.session.snapshot().playerCommitment, 'FOLLOW')
  f.behavior.locomotionOwner = 'SURVIVAL'
  assert.equal(f.session.snapshot().interruptedBySurvival, true)
  assert.equal(f.session.snapshot().playerCommitment, 'FOLLOW')
  f.behavior.locomotionOwner = 'PLAYER'
  f.behavior.type = 'STOP'
  assert.equal(f.session.snapshot().playerCommitment, 'STOP')
  assert.equal(f.session.snapshot().interruptedBySurvival, false)
})

test('session does not silently substitute another player or retain stale activity', () => {
  const f = fixture()
  f.session.start()
  f.clock(1000); f.position.x += 2; f.tick()
  f.clock(6000)
  assert.equal(f.session.snapshot().player.activity, 'UNKNOWN')
  f.bot.players.Alex = { entity: { position: { ...f.position } } }
  delete f.bot.players.Steve
  assert.equal(f.session.snapshot().player, null)
  f.tick()
  assert.equal(f.session.sample, null)
})

test('session conversation is shared, bounded, copied and expires after five minutes', () => {
  const f = fixture()
  f.session.recordPlayer('Steve', '跟我来')
  f.session.recordSpeech('来了')
  const first = f.session.snapshot()
  assert.equal(first.recentDialogue[0].speaker, 'player')
  first.recentDialogue[0].text = 'mutated'
  assert.equal(f.session.snapshot().recentDialogue[0].text, '跟我来')
  for (let i = 0; i < 10; i++) f.session.recordSpeech('x'.repeat(500))
  assert.equal(f.session.snapshot().recentDialogue.length, 6)
  assert.equal(f.session.snapshot().recentDialogue[0].text.length, 220)
  f.clock(300000)
  assert.deepEqual(f.session.snapshot().recentDialogue, [])
})

test('session cleans up its single lightweight timer and memory on disconnect', () => {
  const f = fixture()
  f.session.start(); f.session.start()
  f.session.recordSpeech('来了')
  f.session.stop(); f.session.stop()
  assert.equal(f.cleared(), 1)
  assert.equal(f.session.timer, null)
  assert.equal(f.session.sample, null)
  assert.equal(f.session.recentDialogue.length, 0)
})

test('proactive speech leaves space after conversation and cannot repeat its reply with a different key', () => {
  const f = fixture()
  const messages = []
  const speech = new SpeechController({ chat: text => messages.push(text) }, {
    session: f.session, cooldownMs: 1000, dedupMs: 5000, logger: { info() {} }, now: f.now
  })
  f.session.recordPlayer('Steve', '等一下')
  assert.equal(speech.say('天黑了', 'night'), false)
  f.clock(16000)
  f.session.recordSpeech('天黑了。')
  f.clock(32000)
  assert.equal(speech.say('天黑了！', 'new-reason'), false)
  assert.equal(speech.say('开始下雨了', 'rain'), true)
  assert.deepEqual(messages, ['开始下雨了'])
  assert.equal(f.session.snapshot().recentDialogue.at(-1).text, '开始下雨了')
})

test('autonomy world state includes the same session context as conversation', () => {
  const f = fixture()
  f.session.recordSpeech('我在这等你')
  const builder = new WorldStateBuilder({ bot: f.bot, movement: f.movement, session: f.session,
    survival: { getCombatMode: () => 'DEFENSIVE' }, goalManager: { snapshot: () => null },
    journal: { recent: () => [] }, config: { summaryRange: 12, resourceScanRange: 10 } })
  assert.deepEqual(builder.build().companionSession, f.session.snapshot())
})

test('conversation sends fresh context without keeping old observation snapshots in history', async t => {
  const oldFetch = global.fetch
  t.after(() => { global.fetch = oldFetch })
  const requests = []
  global.fetch = async (url, options) => {
    requests.push(JSON.parse(options.body))
    return { ok: true, status: 200, text: async () => JSON.stringify({ message: { content: '{"action":"CHAT","reply":"好"}' } }) }
  }
  const client = new OllamaClient({ url: 'http://localhost/test', model: 'test', timeoutMs: 1000, responseRetries: 0 })
  await client.decide('Steve', '跟着呢？', 'snapshot-follow')
  await client.decide('Steve', '现在呢？', 'snapshot-stop')
  assert.match(JSON.stringify(requests[0].messages), /snapshot-follow/)
  assert.doesNotMatch(JSON.stringify(requests[1].messages), /snapshot-follow/)
  assert.match(JSON.stringify(requests[1].messages), /snapshot-stop/)
  assert.doesNotMatch(JSON.stringify(client.history), /snapshot-/)
})

test('repeated model movement decisions cannot reset an already matching player path', () => {
  for (const type of ['FOLLOW', 'COME', 'STOP']) {
    const behavior = { type, username: 'Steve', source: 'PLAYER', locomotionOwner: 'PLAYER' }
    assert.equal(isRedundantMovementDecision(type, 'Steve', behavior), true)
    assert.equal(isRedundantMovementDecision(type, 'Steve', { ...behavior, locomotionOwner: 'SURVIVAL' }), false)
    assert.equal(isRedundantMovementDecision(type, 'Steve', { ...behavior, source: 'AUTONOMOUS' }), false)
  }
  assert.equal(isRedundantMovementDecision('FOLLOW', 'Alex', { type: 'FOLLOW', username: 'Steve', source: 'PLAYER', locomotionOwner: 'PLAYER' }), false)
  assert.equal(isRedundantMovementDecision('STOP', 'Steve', { type: 'FOLLOW', source: 'PLAYER', locomotionOwner: 'PLAYER' }), false)
})

test('chat integration supplies shared context and leaves a matching FOLLOW path untouched', async t => {
  const originalFetch = global.fetch
  t.after(() => { global.fetch = originalFetch })
  const f = fixture()
  const bot = Object.assign(new EventEmitter(), f.bot)
  const spoken = []
  bot.chat = text => spoken.push(text)
  let request
  global.fetch = async (url, options) => {
    request = JSON.parse(options.body)
    return { ok: true, text: async () => JSON.stringify({ message: { content: '{"action":"FOLLOW","reply":"在跟着你呢。"}' } }) }
  }
  const agent = createAgent({ bot, session: f.session,
    movement: { ...f.movement, getPlayerCommandEpoch: () => 1, follow: () => assert.fail('must retain existing FOLLOW') },
    survival: { observePlayer() {}, cancelPursuit: () => assert.fail('ordinary chat must not cancel pursuit') },
    logger: { info() {}, error: error => assert.fail(String(error)) },
    config: { url: 'http://localhost/test', model: 'test', timeoutMs: 1000, responseRetries: 0 } })
  agent.start()
  t.after(() => agent.stop())
  bot.emit('chat', 'Steve', '你现在在干嘛？')
  await new Promise(resolve => setImmediate(resolve))
  assert.match(request.messages.at(-1).content, /SHORT_TERM_SYMBOLIC_OBSERVATIONS/)
  assert.deepEqual(spoken, ['在跟着你呢。'])
  assert.equal(f.session.snapshot().recentDialogue.at(-1).speaker, 'companion')
})
