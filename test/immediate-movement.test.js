const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { recognizeImmediateMovement } = require('../src/agent/immediate-movement')
const { createAgent } = require('../src/agent')

test('latency-sensitive Chinese movement commands are recognized without LLM inference', () => {
  assert.equal(recognizeImmediateMovement('跟我来'), 'FOLLOW')
  assert.equal(recognizeImmediateMovement('过来一下'), 'COME')
  assert.equal(recognizeImmediateMovement('别追了，回来！'), 'COME')
  assert.equal(recognizeImmediateMovement('回到我身边'), 'COME')
  assert.equal(recognizeImmediateMovement('停下'), 'STOP')
  assert.equal(recognizeImmediateMovement('别动'), 'STOP')
  assert.equal(recognizeImmediateMovement('等我'), 'STOP')
  assert.equal(recognizeImmediateMovement('你觉得我们去哪'), null)
})

test('FOLLOW takes locomotion immediately before Ollama responds', async () => {
  const originalFetch = global.fetch
  let releaseFetch
  const responseGate = new Promise(resolve => { releaseFetch = resolve })
  global.fetch = () => responseGate

  try {
    const bot = new EventEmitter()
    bot.username = 'AI_Companion'
    bot.chat = () => {}
    let follows = 0
    let commandEpoch = 0
    const movement = {
      follow() { follows += 1; commandEpoch += 1; return true },
      come() { commandEpoch += 1; return true },
      stop() { commandEpoch += 1; return true },
      getPlayerCommandEpoch: () => commandEpoch
    }
    const agent = createAgent({
      bot,
      movement,
      survival: {
        observePlayer() {},
        setCombatMode() {},
        requestAttack: () => ({ accepted: false, reason: 'NO_TARGET' })
      },
      autonomy: { observePlayer() {} },
      logger: { info() {}, error() {} },
      config: { url: 'http://localhost/test', model: 'test', timeoutMs: 5000 }
    })
    agent.start()
    bot.emit('chat', 'Steve', '跟我来')

    assert.equal(follows, 1)
    releaseFetch({
      ok: true,
      async json() {
        return { message: { content: '{"action":"CHAT","reply":"好"}' } }
      }
    })
    await new Promise(resolve => setImmediate(resolve))
    agent.stop()
  } finally {
    global.fetch = originalFetch
  }
})

test('回来 cancels pursuit before inference and invalidates an older pending attack decision', async t => {
  const originalFetch = global.fetch
  t.after(() => { global.fetch = originalFetch })
  let releaseAttack
  let calls = 0
  global.fetch = async () => {
    calls++
    if (calls === 1) return new Promise(resolve => { releaseAttack = resolve })
    return { ok: true, json: async () => ({ message: { content: '{"action":"CHAT","reply":"来了"}' } }) }
  }
  const bot = new EventEmitter()
  bot.username = 'AI_Companion'
  bot.chat = () => {}
  let epoch = 0
  let cancelled = 0
  let attacks = 0
  let comes = 0
  const agent = createAgent({ bot,
    movement: { getPlayerCommandEpoch: () => epoch, come() { comes++; epoch++ }, follow() {}, stop() {} },
    survival: { observePlayer() {}, cancelPursuit() { cancelled++ }, requestAttack() { attacks++; return { accepted: true } }, setCombatMode() {} },
    logger: { info() {}, error() {} }, config: { url: 'http://localhost/test', model: 'test', timeoutMs: 5000 } })
  agent.start()
  t.after(() => agent.stop())
  bot.emit('chat', 'Steve', '帮我打它')
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(releaseAttack)
  bot.emit('chat', 'Steve', '别追了，回来！')
  assert.equal(cancelled, 1)
  assert.equal(comes, 1)
  releaseAttack({ ok: true, json: async () => ({ message: { content: '{"action":"ATTACK","reply":"我去打它"}' } }) })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(attacks, 0)
})
