const test = require('node:test')
const assert = require('node:assert/strict')
const {
  validateAutonomousDecision,
  parseAutonomousDecision
} = require('../src/autonomy/action-schema')

test('autonomous action validation accepts the initial extensible action set', () => {
  for (const action of [
    'IDLE',
    'FOLLOW_PLAYER',
    'WANDER_NEAR_PLAYER',
    'LOOK_AT_PLAYER',
    'COME_TO_PLAYER',
    'EXPLORE_NEARBY',
    'SAY',
    'WAIT'
  ]) {
    assert.equal(validateAutonomousDecision({ action }).action, action)
  }
})

test('autonomous action validation rejects unknown capabilities', () => {
  assert.throws(() => parseAutonomousDecision('{"action":"MINE"}'), /Invalid autonomous action/)
})

test('autonomous wait duration is bounded', () => {
  assert.equal(validateAutonomousDecision({ action: 'WAIT', durationMs: 999999 }).durationMs, 30000)
  assert.equal(validateAutonomousDecision({ action: 'WAIT', durationMs: 1 }).durationMs, 1000)
})
