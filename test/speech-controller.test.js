const test = require('node:test')
const assert = require('node:assert/strict')
const { SpeechController } = require('../src/autonomy/speech-controller')

test('autonomous speech enforces cooldown and deduplication', () => {
  let now = 0
  const messages = []
  const speech = new SpeechController(
    { chat: message => messages.push(message) },
    {
      cooldownMs: 1000,
      dedupMs: 5000,
      now: () => now,
      logger: { info() {} }
    }
  )

  assert.equal(speech.say('天快黑了', 'night'), true)
  now = 500
  assert.equal(speech.say('先找个地方吧', 'shelter'), false)
  now = 1500
  assert.equal(speech.say('天快黑了', 'night'), false)
  assert.equal(speech.say('先找个地方吧', 'shelter'), true)
  now = 6000
  assert.equal(speech.say('天快黑了', 'night'), true)
  assert.deepEqual(messages, ['天快黑了', '先找个地方吧', '天快黑了'])
})
