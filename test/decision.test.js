const test = require('node:test')
const assert = require('node:assert/strict')
const { parseDecision, chatSafe } = require('../src/agent/decision')

test('parseDecision accepts fenced valid actions', () => {
  assert.deepEqual(
    parseDecision('```json\n{"action":"FOLLOW","reply":"来了。"}\n```'),
    { action: 'FOLLOW', reply: '来了。' }
  )
})

test('parseDecision rejects actions outside the supported set', () => {
  assert.throws(() => parseDecision('{"action":"MINE"}'), /Invalid agent action/)
})

test('parseDecision accepts combat mode and explicit attack actions', () => {
  for (const action of ['PASSIVE', 'DEFENSIVE', 'AGGRESSIVE', 'ATTACK']) {
    assert.equal(parseDecision(`{"action":"${action}","reply":"ok"}`).action, action)
  }
})

test('chatSafe flattens and limits replies', () => {
  assert.equal(chatSafe('  hello\n\nworld  ', 9), 'hello wor')
})
