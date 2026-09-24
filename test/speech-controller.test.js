const test = require('node:test')
const assert = require('node:assert/strict')
const { SpeechController } = require('../src/autonomy/speech-controller')
const { speechTopic } = require('../src/autonomy/speech-topic')
const { proactiveClaimIssue } = require('../src/autonomy/proactive-claims')

test('proactive speech does not invent a shared work task or propose unavailable work', () => {
  const state = { currentGoal: null, companionSession: { recentDialogue: [
    { speaker: 'companion', text: '一起挖煤吧？' }
  ] } }
  assert.equal(proactiveClaimIssue('最近挖煤进度如何？', state), 'UNOBSERVED_SHARED_TASK')
  assert.equal(proactiveClaimIssue('白天好，一起挖煤吧？', state), 'UNSUPPORTED_WORK_PROPOSAL')
  assert.equal(proactiveClaimIssue('天亮了，咱们一起找点煤炭吧。', state), 'UNSUPPORTED_WORK_PROPOSAL')
  assert.equal(proactiveClaimIssue('白天好，一起看看附近有没有铜矿？', state), 'UNSUPPORTED_WORK_PROPOSAL')
  assert.equal(proactiveClaimIssue('刚才被发光鱿鱼撞了一下，不过没事。', state), 'UNVERIFIED_ATTACKER')
  assert.equal(proactiveClaimIssue('我得去附近看看有没有煤炭。', state), 'UNSTARTED_MOVEMENT_CLAIM')
  assert.equal(proactiveClaimIssue('天光正好，你站得稳稳的，我跟着你。', {
    ...state, behavior: { type: 'STOP', locomotionOwner: 'PLAYER' }
  }), 'FALSE_FOLLOW_CLAIM')
  assert.equal(proactiveClaimIssue('天光正好，我跟着你。', {
    ...state, behavior: { type: 'FOLLOW', locomotionOwner: 'PLAYER' }
  }), null)
  assert.equal(proactiveClaimIssue('天亮了，一起走吧。', {
    ...state, behavior: { type: 'STOP', source: 'PLAYER', locomotionOwner: 'PLAYER' }
  }), 'CONTRADICTS_PLAYER_STOP')
  assert.equal(proactiveClaimIssue('天亮了，一起走吧。', {
    ...state, behavior: { type: 'FOLLOW', source: 'PLAYER', locomotionOwner: 'PLAYER' }
  }), null)
  assert.equal(proactiveClaimIssue('我有点想看看附近。', state), null)
  assert.equal(proactiveClaimIssue('这边挺安静，我先看看。', state), null)
  assert.equal(proactiveClaimIssue('最近挖煤进度如何？', { ...state, companionSession: { recentDialogue: [
    { speaker: 'player', text: '我们去挖煤吧' }
  ] } }), null)
})

test('unsupported proactive work claim is withheld before speech cooldown is consumed', () => {
  const messages = []
  const speech = new SpeechController({ chat: text => messages.push(text) }, {
    cooldownMs: 60000, dedupMs: 300000, now: () => 0, logger: { info() {} }
  })
  assert.equal(speech.say('最近挖煤进度如何？', 'new reason', { currentGoal: null }), false)
  assert.equal(speech.lastResult.reason, 'UNOBSERVED_SHARED_TASK')
  assert.equal(speech.say('这边挺安静，我先看看。'), true)
  assert.deepEqual(messages, ['这边挺安静，我先看看。'])
})

test('proactive topics group paraphrases without confusing rain and clear weather', () => {
  assert.equal(speechTopic('夜深了，小心点。'), 'TIME_NIGHT')
  assert.equal(speechTopic('夜了，小心点。'), 'TIME_NIGHT')
  assert.equal(speechTopic('今天没下雨'), 'WEATHER_CLEAR')
  assert.equal(speechTopic('开始下雨了'), 'WEATHER_RAIN')
  assert.equal(speechTopic('我挺喜欢这片草地'), null)
})

test('proactive paraphrases about the same night are not repeated with new model reasons', () => {
  let now = 0
  const spoken = []
  const speech = new SpeechController({ chat: text => spoken.push(text) }, {
    cooldownMs: 1000, dedupMs: 300000, now: () => now, logger: { info() {} }
  })
  assert.equal(speech.say('夜深了，小心点。', 'first reason'), true)
  now = 70000
  assert.equal(speech.say('夜了，小心点。', 'completely different reason'), false)
  assert.equal(speech.lastResult.reason, 'TOPIC_DEDUP')
  assert.deepEqual(spoken, ['夜深了，小心点。'])
})

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
