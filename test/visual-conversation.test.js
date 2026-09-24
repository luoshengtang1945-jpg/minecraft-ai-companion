const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { createAgent } = require('../src/agent')
const { conversationVisualContext } = require('../src/vision/conversation-routing')

const logger = { info() {}, error(error) { throw error } }

test('visual chat omits generic self-reported structures that may be small foreground objects', () => {
  const world = { getVisual: () => ({ source: 'OBSERVED_VISUALLY', ageMs: 10,
    frame: { id: 'current', perspective: 'COMPANION_CAMERA' },
    observation: { sceneType: 'OPEN_TERRAIN', salientObjects: [
      { label: 'grass', region: 'NEAR', confidence: 0.98 },
      { label: 'HILL_WITH_STRUCTURES', region: 'RIGHT', confidence: 0.8 }
    ], structures: [{ label: 'RED_AND_WHITE_STRUCTURE', region: 'RIGHT', confidence: 0.75 }],
    terrain: [], hazards: [], uncertainty: [] } }) }
  const context = conversationVisualContext(world)
  assert.deepEqual(context.salientObjects.map(item => item.label), ['grass'])
  assert.deepEqual(context.structures, [])
})

test('visual question and follow-up use successive companion frames without old chat or symbolic scene claims', async t => {
  const originalFetch = global.fetch
  t.after(() => { global.fetch = originalFetch })
  const requests = []
  global.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body))
    return { ok: true, status: 200, text: async () => JSON.stringify({ message: { content: JSON.stringify({ action: 'CHAT', reply: `第${requests.length}次看到沙地。` }) } }) }
  }

  const bot = Object.assign(new EventEmitter(), { username: 'AI_Companion', chat() {} })
  let frameNumber = 0
  let current = null
  const vision = { request: async () => {
    frameNumber++
    current = {
      source: 'OBSERVED_VISUALLY', ageMs: 0,
      frame: { id: `frame-${frameNumber}`, perspective: 'COMPANION_CAMERA' },
      observation: { sceneType: 'OPEN_TERRAIN', summary: 'Old summary text that should not be sent',
        salientObjects: [{ label: `fresh sand view ${frameNumber}`, region: 'CENTER', confidence: 0.9 },
          { label: 'tiny uncertain egg', region: 'RIGHT', confidence: 0.1 }],
        structures: [], terrain: [], hazards: [], uncertainty: [] }
    }
    return { status: 'UPDATED', frameId: current.frame.id }
  } }
  const spoken = []
  bot.chat = text => spoken.push(text)
  const agent = createAgent({
    bot, vision, visualWorldModel: { getVisual: () => current },
    session: { recordPlayer() {}, recordSpeech() {}, snapshot: () => ({ recentDialogue: ['old panda egg and red bed'] }) },
    movement: { getPlayerCommandEpoch: () => 0, getBehaviorSummary: () => ({ type: 'IDLE' }) },
    survival: { observePlayer() {} }, autonomy: { observePlayer() {} }, logger,
    config: { url: 'http://localhost/test', model: 'test', timeoutMs: 1000, responseRetries: 0 }
  })
  agent.start()
  t.after(() => agent.stop())

  bot.emit('chat', 'Steve', '你面前是什么')
  await new Promise(resolve => setImmediate(resolve))
  bot.emit('chat', 'Steve', '现在呢')
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(frameNumber, 2)
  assert.equal(requests.length, 2)
  assert.match(JSON.stringify(requests[1].messages), /fresh sand view 2/)
  assert.doesNotMatch(JSON.stringify(requests[1].messages), /old panda egg|fresh sand view 1|第1次看到沙地|Old summary text|tiny uncertain egg/)
  assert.equal(spoken.length, 2)
})

test('unavailable fresh frame never reuses a previously accepted visual observation', async t => {
  const originalFetch = global.fetch
  t.after(() => { global.fetch = originalFetch })
  global.fetch = () => assert.fail('no model decision without a fresh frame')
  const bot = Object.assign(new EventEmitter(), { username: 'AI_Companion' })
  const spoken = []
  bot.chat = text => spoken.push(text)
  const agent = createAgent({
    bot,
    vision: { request: async () => ({ status: 'UNAVAILABLE', reason: 'NO_FRESH_FRAME' }) },
    visualWorldModel: { getVisual: () => ({ source: 'OBSERVED_VISUALLY', ageMs: 1,
      frame: { id: 'old', perspective: 'COMPANION_CAMERA' },
      observation: { summary: 'old panda egg', sceneType: 'UNKNOWN', salientObjects: [], structures: [], hazards: [], uncertainty: [] } }) },
    movement: { getPlayerCommandEpoch: () => 0 }, survival: { observePlayer() {} }, logger,
    config: { url: 'http://localhost/test', model: 'test', timeoutMs: 1000, responseRetries: 0 }
  })
  agent.start()
  t.after(() => agent.stop())
  bot.emit('chat', 'Steve', '你面前是什么')
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(spoken, ['我现在没有可用的新画面，不能确定你指的是哪个东西。'])
})
