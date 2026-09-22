const test = require('node:test')
const assert = require('node:assert/strict')
const greetings = require('../config/spawn-greetings.json')
const { selectSpawnGreeting, sendSpawnGreeting } = require('../src/companion/spawn-greeting')

test('every configured join greeting is selectable without an LLM', () => {
  assert.ok(greetings.length >= 8)
  assert.equal(new Set(greetings).size, greetings.length)
  for (let index = 0; index < greetings.length; index++) {
    assert.equal(selectSpawnGreeting({ random: () => (index + 0.5) / greetings.length }), greetings[index])
  }
})

test('fixed custom greeting is preserved while unset or blank selects random', () => {
  assert.equal(selectSpawnGreeting({ override: '  自定义\n招呼 ', random: () => assert.fail('must not randomize override') }), '自定义 招呼')
  assert.equal(selectSpawnGreeting({ override: ' ', random: () => 0 }), greetings[0])
  assert.equal(selectSpawnGreeting({ random: () => 0.9999 }), greetings.at(-1))
})

test('empty/invalid greeting pools fall back safely and messages are chat bounded', () => {
  assert.equal(selectSpawnGreeting({ greetings: [] }), '嗨，我来了。')
  assert.equal(selectSpawnGreeting({ greetings: [null, '', '  ', '有效'] }), '有效')
  assert.equal(selectSpawnGreeting({ override: 'x'.repeat(300) }).length, 220)
  assert.equal(selectSpawnGreeting({ random: () => NaN }), greetings[0])
})

test('join sends exactly one greeting and records it in shared speech context', () => {
  const sent = []
  const recorded = []
  const message = sendSpawnGreeting({
    bot: { chat: text => sent.push(text) }, session: { recordSpeech: text => recorded.push(text) }, random: () => 0
  })
  assert.deepEqual(sent, [message])
  assert.deepEqual(recorded, [message])
})
