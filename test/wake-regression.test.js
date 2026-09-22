const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { createSerializer } = require('minecraft-protocol')
const { sendWakeRequest } = require('../src/companion/wake-request')
const { RestController, recognizeRestRequest } = require('../src/companion/rest-controller')
const { groundActionReply } = require('../src/agent/action-claims')

function fixture(onWrite = () => {}) {
  const bot = new EventEmitter()
  const chats = []
  const packets = []
  const logs = []
  Object.assign(bot, { version: '1.21.11', entity: { id: 1 }, isSleeping: true,
    chat: text => chats.push(text), wake: () => assert.fail('must not call legacy wake for mapped protocol'),
    _client: { write(name, params) { packets.push({ name, params }); onWrite(bot) } } })
  const controller = new RestController({ bot, movement: { getPlayerCommandEpoch: () => 1, getLocomotionOwner: () => 'PLAYER' },
    survival: {}, logger: { info: text => logs.push(text) }, wakeTimeoutMs: 10 })
  return { bot, chats, packets, logs, controller }
}

test('wake encodes actual 1.21.11 leave_bed action 0 rather than legacy action 2', async () => {
  const f = fixture()
  await sendWakeRequest(f.bot)
  const serializer = createSerializer({ state: 'play', isServer: false, version: '1.21.11' })
  const encoded = serializer.createPacketBuffer(f.packets[0])
  assert.equal(encoded.toString('hex'), '29010000')
  assert.equal(f.packets[0].params.actionId, 'leave_bed')
})

test('wake acknowledges only confirmed sleeping=false, including a synchronous server event', async () => {
  const f = fixture(bot => { bot.isSleeping = false; bot.emit('wake') })
  await f.controller.request('WAKE')
  assert.equal(f.chats.at(-1), '起来了。')
  assert.equal(f.bot.listenerCount('wake'), 0)
  assert.equal(f.packets.length, 1)
})

test('unconfirmed wake times out honestly and removes listener', async () => {
  const f = fixture()
  await f.controller.request('WAKE')
  assert.match(f.chats.at(-1), /没得到服务器确认/)
  assert.ok(!f.chats.includes('起来了。'))
  assert.equal(f.bot.listenerCount('wake'), 0)
  assert.match(f.logs.at(-1), /Wake TIMEOUT/)
})

test('duplicate wake requests share the pending confirmation without packet spam', async () => {
  const f = fixture()
  const pending = f.controller.request('WAKE')
  await f.controller.request('WAKE')
  assert.equal(f.packets.length, 1)
  f.bot.isSleeping = false
  f.bot.emit('wake')
  await pending
  assert.equal(f.chats.filter(text => text === '起来了。').length, 1)
})

test('disconnect cancels a pending wake confirmation without a late success reply', async () => {
  const f = fixture()
  const pending = f.controller.request('WAKE')
  f.controller.stop()
  await pending
  assert.equal(f.bot.listenerCount('wake'), 0)
  assert.ok(!f.chats.includes('起来了。'))
})

test('cancel used by FOLLOW also sends the corrected wake packet', () => {
  const f = fixture()
  f.controller.cancel()
  assert.equal(f.packets[0].params.actionId, 'leave_bed')
})

test('起来 routes to the real wake action and sleeping chat cannot claim already awake', () => {
  for (const text of ['起床', '起来', '你起来', '你起床吧']) assert.equal(recognizeRestRequest(text), 'WAKE')
  assert.notEqual(groundActionReply('我刚起来，你先看看周围。', { isSleeping: true }), '我刚起来，你先看看周围。')
  assert.equal(groundActionReply('我刚起来。', { isSleeping: false }), '我刚起来。')
})
