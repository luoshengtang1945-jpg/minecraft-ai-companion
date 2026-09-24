const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { OllamaClient, groundedFallback } = require('../src/agent/ollama-client')
const { isRepeatedReply, hasReversedFollowReply, isStageDirectionReply, contradictsMovementAction, fallbackMovementReply, validateReply } = require('../src/agent/reply-variety')
const { AutonomyController } = require('../src/autonomy/autonomy-controller')
const { SpeechController } = require('../src/autonomy/speech-controller')
const { AutonomyOllamaClient } = require('../src/autonomy/ollama-client')
const { personality } = require('../src/personality')
const { chatReplyIssue } = require('../src/agent/reply-grounding')
const config = { url: 'http://localhost/test', model: 'test', timeoutMs: 1000, responseRetries: 0 }

test('grounded boredom fallback rotates across recent lines and rejects invented weather resources', () => {
  const first = groundedFallback('OVERLOADED_EMOTION_REPLY', '我有点无聊')
  const second = groundedFallback('OVERLOADED_EMOTION_REPLY', '我有点无聊', [first])
  const third = groundedFallback('OVERLOADED_EMOTION_REPLY', '我有点无聊', [first, second])
  assert.equal(new Set([first, second, third]).size, 3)
  for (const reply of [first, second, third]) assert.equal(chatReplyIssue(reply, { playerMessage: '我有点无聊' }), null)
  assert.equal(chatReplyIssue('我想在雨天收集雨滴。', { playerMessage: '你喜欢下雨天吗？' }),
    'UNSUPPORTED_MECHANIC_CLAIM')
})

test('fresh visual replies cannot both identify and deny the same visible block shape', () => {
  assert.equal(chatReplyIssue('眼前是个蓝色方块，但不确定是不是方块。', { freshVisual: true }),
    'VISUAL_SELF_CONTRADICTION')
  assert.equal(chatReplyIssue('眼前是个蓝色方块，材质没看清。', { freshVisual: true }), null)
  assert.equal(groundedFallback('VISUAL_SELF_CONTRADICTION', '你看见什么？'),
    '我眼前有个方块，材质没看清。')
})

function modelReplies(t, values) {
  const original = global.fetch
  t.after(() => { global.fetch = original })
  const requests = []
  global.fetch = async (url, options) => {
    requests.push(JSON.parse(options.body))
    const value = values.shift()
    if (value instanceof Error) throw value
    assert.ok(value, 'unexpected extra inference')
    return { ok: true, text: async () => JSON.stringify({ message: { content: JSON.stringify(value) } }) }
  }
  return requests
}

test('reply dedup ignores punctuation and includes repeated short acknowledgements', () => {
  assert.equal(isRepeatedReply('我在跟着你！', ['我在跟着你。']), true)
  assert.equal(isRepeatedReply('好。', ['好']), true)
  assert.equal(isRepeatedReply('你走前面，我跟着。', ['我在跟着你']), false)
  assert.throws(() => validateReply({ reply: '我跟着', action: 'ATTACK' }))
  assert.throws(() => validateReply({ reply: '' }))
  for (const reply of ['跟上，别掉队', '好，跟紧点', '跟紧点，别走散', '你跟紧我']) {
    assert.equal(hasReversedFollowReply('FOLLOW', reply), true)
  }
  assert.equal(hasReversedFollowReply('FOLLOW', '我跟紧你'), false)
  assert.equal(hasReversedFollowReply('CHAT', '跟紧点'), false)
  assert.equal(isStageDirectionReply('（跟随玩家移动）'), true)
  assert.equal(isStageDirectionReply('好，我跟着你。'), false)
  assert.equal(contradictsMovementAction('STOP', '我跟上你了。'), true)
  assert.equal(contradictsMovementAction('STOP', '好，我停在这儿。'), false)
  assert.equal(contradictsMovementAction('FOLLOW', '我先不动了。'), true)
  assert.equal(fallbackMovementReply('FOLLOW', ['好，我跟着你。']), '嗯，我走你后面。')
  assert.equal(fallbackMovementReply('CHAT', []), '')
})

test('STOP reply cannot announce following after a stale conversational context', async t => {
  modelReplies(t, [
    { action: 'STOP', reply: '我跟上你了。' },
    { reply: '好，我先停下。' }
  ])
  const decision = await new OllamaClient(config).decide('Steve', '停下')
  assert.deepEqual(decision, { action: 'STOP', reply: '好，我先停下。' })
})

test('stage-direction command reply is revised into player-facing speech', async t => {
  const requests = modelReplies(t, [
    { action: 'FOLLOW', reply: '（跟随玩家移动）' },
    { reply: '好，我跟着你。' }
  ])
  const client = new OllamaClient(config)
  const decision = await client.decide('Player', 'follow me')
  assert.equal(decision.action, 'FOLLOW')
  assert.equal(decision.reply, '好，我跟着你。')
  assert.equal(requests.length, 2)
})

test('duplicate conversation gets one reply-only revision without changing the action', async t => {
  const requests = modelReplies(t, [
    { action: 'FOLLOW', reply: '我在跟着你。' },
    { action: 'FOLLOW', reply: '我在跟着你！' },
    { reply: '我会跟着，你走前面。' }
  ])
  const client = new OllamaClient(config)
  await client.decide('Steve', '跟着我')
  const decision = await client.decide('Steve', '跟着我')
  assert.deepEqual(decision, { action: 'FOLLOW', reply: '我会跟着，你走前面。' })
  assert.equal(requests.length, 3)
  assert.deepEqual(Object.keys(requests[2].format.properties), ['reply'])
  assert.equal(requests[0].options.temperature, 0.5)
  assert.equal(requests[2].options.temperature, 0.7)
})

test('repeated movement repair uses a distinct safe acknowledgement without another inference', async t => {
  const requests = modelReplies(t, [
    { action: 'FOLLOW', reply: '我在跟着你。' },
    { action: 'FOLLOW', reply: '我在跟着你。' },
    { reply: '我在跟着你！' }
  ])
  const client = new OllamaClient(config)
  await client.decide('Steve', '跟着我')
  assert.deepEqual(await client.decide('Steve', '跟着我'), { action: 'FOLLOW', reply: '好，我跟着你。' })
  assert.equal(requests.length, 3)
})

test('invalid revision cannot introduce a new tool or action', async t => {
  modelReplies(t, [
    { action: 'CHAT', reply: '我就在你旁边。' },
    { action: 'CHAT', reply: '我就在你旁边。' },
    { reply: '开始攻击', action: 'ATTACK' }
  ])
  const client = new OllamaClient(config)
  await client.decide('Steve', '你好')
  assert.deepEqual(await client.decide('Steve', '你好'), { action: 'CHAT', reply: '' })
})

test('a reversed FOLLOW acknowledgement is rewritten without reversing the actual action', async t => {
  modelReplies(t, [{ action: 'FOLLOW', reply: '跟上，别掉队。' }, { reply: '我跟着你走。' }])
  const client = new OllamaClient(config)
  assert.deepEqual(await client.decide('Steve', '跟着我'), { action: 'FOLLOW', reply: '我跟着你走。' })
})

test('natural first-person FOLLOW revision is not discarded for a polite prefix', async t => {
  modelReplies(t, [{ action: 'FOLLOW', reply: '明白，跟上' }, { reply: '好的，我跟上。' }])
  const client = new OllamaClient(config)
  assert.deepEqual(await client.decide('Steve', 'follow me'), { action: 'FOLLOW', reply: '好的，我跟上。' })
})

test('unsupported shared-work chat suggestion is revised without changing CHAT action', async t => {
  const requests = modelReplies(t, [
    { action: 'CHAT', reply: '要不要一起挖个矿洞？' },
    { reply: '有点闷的话，我们在附近走走？' }
  ])
  const decision = await new OllamaClient(config).decide('Steve', 'I feel bored')
  assert.deepEqual(decision, { action: 'CHAT', reply: '有点闷的话，我们在附近走走？' })
  assert.equal(requests.length, 2)
  assert.deepEqual(Object.keys(requests[1].format.properties), ['reply'])
})

test('unseen scenery and unstarted guide action are revised into an honest suggestion', async t => {
  assert.equal(chatReplyIssue('附近有片林子，我带你看看。'), 'UNVERIFIED_SCENE')
  assert.equal(chatReplyIssue('我看到远处有几朵蒲公英在风里飘。'), 'UNVERIFIED_SCENE')
  assert.equal(chatReplyIssue('附近好像有动静。'), 'UNVERIFIED_SCENE')
  assert.equal(chatReplyIssue('无聊的话去附近的山洞看看？'), 'UNVERIFIED_SCENE')
  assert.equal(chatReplyIssue('我带你看看。'), 'UNSTARTED_MOVEMENT_CLAIM')
  const requests = modelReplies(t, [
    { action: 'CHAT', reply: '要不要一起散步？附近有片林子，我带你看看。' },
    { reply: '有点闷？要不在附近随便走走，我陪你。' }
  ])
  const decision = await new OllamaClient(config).decide('Steve', 'I feel bored')
  assert.equal(decision.reply, '有点闷？要不在附近随便走走，我陪你。')
  assert.equal(requests.length, 2)
})

test('CHAT does not promise an unrequested fight as a boredom suggestion', async t => {
  assert.equal(chatReplyIssue('或者我陪你打会儿怪？'), 'UNSOLICITED_COMBAT')
  const requests = modelReplies(t, [
    { action: 'CHAT', reply: '一起躲雨？或者我陪你打会儿怪？' },
    { reply: '有点闷？我陪你聊会儿。' }
  ])
  const decision = await new OllamaClient(config).decide('Steve', 'I feel bored')
  assert.deepEqual(decision, { action: 'CHAT', reply: '有点闷？我陪你聊会儿。' })
  assert.equal(requests.length, 2)
})

test('emotion-only player chat is acknowledged before proposing an activity', async t => {
  assert.equal(chatReplyIssue('要不要一起看看附近？', { playerMessage: 'I feel bored' }), 'MISSED_EMOTION')
  assert.equal(chatReplyIssue('有点闷？我陪你聊会儿。', { playerMessage: 'I feel bored' }), null)
  const requests = modelReplies(t, [
    { action: 'CHAT', reply: '要不要一起看看附近？' },
    { reply: '有点闷？我陪你聊会儿。' }
  ])
  assert.equal((await new OllamaClient(config).decide('Steve', 'I feel bored')).reply, '有点闷？我陪你聊会儿。')
  assert.equal(requests.length, 2)
})

test('repetition repair cannot reintroduce an unsupported scene claim', async t => {
  modelReplies(t, [
    { action: 'CHAT', reply: '无聊？一起走走？' },
    { action: 'CHAT', reply: '无聊？一起走走？' },
    { reply: '我带你去看附近的森林。' }
  ])
  const client = new OllamaClient(config)
  await client.decide('Steve', 'I feel bored')
  const second = await client.decide('Steve', 'I feel bored')
  assert.equal(second.action, 'CHAT')
  assert.equal(chatReplyIssue(second.reply, { playerMessage: 'I feel bored' }), null)
  assert.doesNotMatch(second.reply, /森林|我带你去/)
})

test('player asking what the companion wants gets a preference rather than a status report', async t => {
  assert.equal(chatReplyIssue('我在这等你呢。', { playerMessage: 'What do you want to do?' }), 'DODGED_PREFERENCE')
  const requests = modelReplies(t, [
    { action: 'CHAT', reply: '我在这等你呢。' },
    { reply: '我倒想在附近走走，不过你说停，我就先待着。' }
  ])
  assert.match((await new OllamaClient(config).decide('Steve', 'What do you want to do?')).reply, /我倒想/)
  assert.equal(requests.length, 2)
})

test('preference question cannot be answered with an unrelated gameplay claim alone', async t => {
  assert.equal(chatReplyIssue('下雨天能种蘑菇，但跑起来会湿透。', { playerMessage: '你喜欢下雨天吗？' }), 'DODGED_PREFERENCE')
  modelReplies(t, [
    { action: 'CHAT', reply: '下雨天能种蘑菇，但跑起来会湿透。' },
    { reply: '我更喜欢晴天，雨声偶尔听听还挺舒服。' }
  ])
  assert.match((await new OllamaClient(config).decide('Steve', '你喜欢下雨天吗？')).reply, /我更喜欢晴天/)
})

test('unsupported preference revision falls back to a real bounded preference', async t => {
  modelReplies(t, [
    { action: 'CHAT', reply: '我在这等你。' },
    { reply: '我最近在观察小动物，要不要一起看看？' }
  ])
  assert.equal((await new OllamaClient(config).decide('Steve', 'What do you want to do?')).reply,
    '我倒想在附近逛逛，不过先陪你待会儿也挺好。')
})

test('conversation does not promise reliable material gathering that is not implemented', async t => {
  assert.equal(chatReplyIssue('我不会建房，但可以帮你找材料。'), 'UNSUPPORTED_RESOURCE_HELP')
  assert.equal(chatReplyIssue('我不会建房，但可以陪你找材料。'), 'UNSUPPORTED_RESOURCE_HELP')
  assert.equal(chatReplyIssue('我可不会建房，不过我陪你挖点石头？'), 'UNSUPPORTED_RESOURCE_HELP')
  assert.equal(chatReplyIssue('我想在安全的地方找点资源。', { playerMessage: '你想干嘛？' }), 'UNSUPPORTED_RESOURCE_HELP')
  const requests = modelReplies(t, [{ action: 'CHAT', reply: '我不会建房，但可以帮你找材料。' }])
  assert.equal((await new OllamaClient(config).decide('Steve', 'Can you build a house?')).reply,
    '我现在还不能可靠地建房，布局可以一起商量。')
  assert.equal(requests.length, 1)
})

test('emotion replies avoid chore lists and weather preferences avoid invented resource mechanics', () => {
  assert.equal(chatReplyIssue('无聊的时候可以挖矿，或者种点蘑菇。', { playerMessage: '我有点无聊' }), 'OVERLOADED_EMOTION_REPLY')
  assert.equal(chatReplyIssue('我懂，试试挖个矿洞，说不定能挖到钻石？', { playerMessage: 'I feel bored' }), 'OVERLOADED_EMOTION_REPLY')
  assert.equal(chatReplyIssue('我更喜欢晴天，这样能刷更多资源。', { playerMessage: '你喜欢下雨天吗？' }), 'UNSUPPORTED_MECHANIC_CLAIM')
})

test('temporary missing tools are not passed off as the sole building limitation', () => {
  assert.equal(chatReplyIssue('我这会儿没工具，先别想建房啦。', { playerMessage: 'Can you build a house?' }), 'DODGED_BUILD_LIMIT')
  assert.equal(chatReplyIssue('现在不能建房，得先挖点地基。', { playerMessage: 'Can you build a house?' }), 'DODGED_BUILD_LIMIT')
  assert.equal(chatReplyIssue('我可不会建房子，你来指挥我搬砖吧。', { playerMessage: 'Can you build a house?' }), 'DODGED_BUILD_LIMIT')
  assert.equal(chatReplyIssue('我现在还不能可靠地建房。', { playerMessage: 'Can you build a house?' }), null)
})

test('unsupported capability draft is grounded without a second inference', async t => {
  const requests = modelReplies(t, [{ action: 'CHAT', reply: '我不能建房，但可以陪你一起找材料。' }])
  assert.equal((await new OllamaClient(config).decide('Steve', 'Can you build a house?')).reply,
    '我现在还不能可靠地建房，布局可以一起商量。')
  assert.equal(requests.length, 1)
})

test('a player question cannot become proof of a shared past experience', async t => {
  assert.equal(chatReplyIssue('记得，但没看到材料。', { playerMessage: 'Do you remember the house we built?' }), 'UNVERIFIED_SHARED_MEMORY')
  assert.equal(chatReplyIssue('记得，但没印象了。', { playerMessage: '你还记得我们盖的房子吗？' }), 'UNVERIFIED_SHARED_MEMORY')
  assert.equal(chatReplyIssue('那房子屋顶是蓝色的。', { playerMessage: 'Do you remember the house we built?' }), 'UNVERIFIED_SHARED_MEMORY')
  assert.equal(chatReplyIssue('记不清具体位置了，但上次挖的矿洞还行。', { playerMessage: 'Do you remember the house we built?' }), 'UNVERIFIED_SHARED_MEMORY')
  modelReplies(t, [
    { action: 'CHAT', reply: '记得，但没看到材料。' },
    { reply: '那段经过我没有可靠记录，你跟我说说？' }
  ])
  assert.match((await new OllamaClient(config).decide('Steve', 'Do you remember the house we built?')).reply, /没有可靠记录/)
})

test('weather preference avoids invented game mechanics', () => {
  assert.equal(chatReplyIssue('我更喜欢晴天，因为可以晒干蘑菇。', { playerMessage: '你喜欢下雨天吗？' }), 'UNSUPPORTED_MECHANIC_CLAIM')
  assert.equal(chatReplyIssue('我更喜欢晴天，雨声偶尔听听还不错。', { playerMessage: '你喜欢下雨天吗？' }), null)
})

test('player conversation and autonomous speech share the configured companion personality', () => {
  const { SYSTEM_PROMPT } = require('../src/agent/prompt')
  assert.match(SYSTEM_PROMPT, new RegExp(personality.speechStyle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(SYSTEM_PROMPT, /not a servant or help-desk assistant/)
})

test('empty conversation reply gets a single text-only repair', async t => {
  const requests = modelReplies(t, [{ action: 'CHAT', reply: '' }, { reply: '我更喜欢晴天。' }])
  assert.equal((await new OllamaClient(config).decide('Steve', '喜欢晴天吗')).reply, '我更喜欢晴天。')
  assert.equal(requests.length, 2)
})

test('fresh visual conversation excludes old scene history and does not save it as future scene evidence', async t => {
  const requests = modelReplies(t, [
    { action: 'CHAT', reply: '聊完再看。' },
    { action: 'CHAT', reply: '我面前是沙地。' },
    { action: 'CHAT', reply: '看着挺开阔。' }
  ])
  const client = new OllamaClient(config)
  await client.decide('Steve', '刚才说的是熊猫', 'old context')
  await client.decide('Steve', '你面前是什么', 'fresh companion frame f2: sand', { freshVisual: true })
  await client.decide('Steve', '挺好', 'current context')
  assert.doesNotMatch(JSON.stringify(requests[1].messages), /熊猫|old context/)
  assert.match(JSON.stringify(requests[1].messages), /frame f2: sand/)
  assert.doesNotMatch(JSON.stringify(requests[2].messages), /我面前是沙地|frame f2: sand/)
})

test('visible block answer repairs an internally contradictory hedge without changing CHAT', async t => {
  const requests = modelReplies(t, [
    { action: 'CHAT', reply: '眼前是个蓝色方块，但不确定是不是方块。' },
    { reply: '眼前有个蓝色方块，材质还没看清。' }
  ])
  const decision = await new OllamaClient(config).decide('Steve', '你眼前是什么？',
    'fresh companion frame: blue cube', { freshVisual: true })
  assert.deepEqual(decision, { action: 'CHAT', reply: '眼前有个蓝色方块，材质还没看清。' })
  assert.equal(requests.length, 2)
  assert.deepEqual(Object.keys(requests[1].format.properties), ['reply'])
})

test('player-owned autonomy uses speech-only schema and validates it independently', async t => {
  const requests = modelReplies(t, [
    { action: 'SAY', message: '开始下雨了', reason: 'new_rain' },
    { action: 'FOLLOW_PLAYER' }
  ])
  const client = new AutonomyOllamaClient({ ollama: config, personality })
  const state = { behavior: { locomotionOwner: 'PLAYER' } }
  assert.equal((await client.decide(state)).action, 'SAY')
  assert.deepEqual(requests[0].format.properties.action.enum, ['SAY', 'IDLE'])
  await assert.rejects(client.decide(state), /cannot control movement/)
})

test('temporarily unavailable proactive speech is removed from the structured schema', async t => {
  const requests = modelReplies(t, [
    { action: 'IDLE' },
    { action: 'SAY', message: '重复提醒' }
  ])
  const client = new AutonomyOllamaClient({ ollama: config, personality })
  const state = {
    behavior: { locomotionOwner: 'PLAYER' },
    autonomousSpeechAllowed: false,
    autonomousSpeechUnavailableReason: 'RECENT_REJECTED_SPEECH'
  }
  assert.equal((await client.decide(state)).action, 'IDLE')
  assert.deepEqual(requests[0].format.properties.action.enum, ['IDLE'])
  await assert.rejects(client.decide(state), /not currently available/)
})

test('unowned autonomy retains existing action schema and deterministic temperature', async t => {
  const requests = modelReplies(t, [{ action: 'IDLE' }])
  await new AutonomyOllamaClient({ ollama: config, personality }).decide({ behavior: { locomotionOwner: 'NONE' } })
  assert.ok(requests[0].format.properties.action.enum.includes('FOLLOW_PLAYER'))
  assert.equal(requests[0].options.temperature, 0)
})

test('recently completed casual movement is removed from autonomy action schema', async t => {
  const requests = modelReplies(t, [
    { action: 'IDLE' },
    { action: 'WANDER_NEAR_PLAYER' }
  ])
  const client = new AutonomyOllamaClient({ ollama: config, personality, maxPlayerDistance: 16 })
  const state = {
    behavior: { locomotionOwner: 'NONE' },
    player: { username: 'Steve', distance: 4 },
    autonomousMoveCooldownMs: 30000
  }
  await client.decide(state)
  assert.deepEqual(requests[0].format.properties.action.enum, ['IDLE', 'SAY'])
  await assert.rejects(client.decide(state), /not currently available/)
})

test('recent autonomous follow is excluded while other safe intentions remain available', async t => {
  const requests = modelReplies(t, [{ action: 'IDLE' }])
  const client = new AutonomyOllamaClient({ ollama: config, personality })
  await client.decide({
    behavior: { locomotionOwner: 'NONE' },
    player: { distance: 4 },
    autonomousFollowCooldownMs: 60000
  })
  const actions = requests[0].format.properties.action.enum
  assert.equal(actions.includes('FOLLOW_PLAYER'), false)
  assert.equal(actions.includes('EXPLORE_NEARBY'), true)
})

test('autonomous learning schema only exposes currently observed item candidates when opted in', async t => {
  const requests = modelReplies(t, [
    { action: 'TRY_OBTAIN_ITEM', goalItem: 'birch_log' },
    { action: 'TRY_OBTAIN_ITEM', goalItem: 'diamond' },
    { action: 'IDLE' }
  ])
  const state = {
    behavior: { locomotionOwner: 'NONE' },
    player: { distance: 4 },
    availableTaskItems: ['birch_log']
  }
  const enabled = new AutonomyOllamaClient({ ollama: config, personality, autonomousTasksEnabled: true })
  assert.equal((await enabled.decide(state)).goalItem, 'birch_log')
  assert.deepEqual(requests[0].format.oneOf[1].properties.goalItem.enum, ['birch_log'])
  assert.deepEqual(requests[0].format.oneOf[1].required, ['action', 'goalItem'])
  assert.equal(requests[0].format.oneOf[0].properties.action.enum.includes('TRY_OBTAIN_ITEM'), false)
  await assert.rejects(enabled.decide(state), /not observed and allowlisted/)
  const disabled = new AutonomyOllamaClient({ ollama: config, personality, autonomousTasksEnabled: false })
  await disabled.decide(state)
  assert.equal(requests[2].format.properties.action.enum.includes('TRY_OBTAIN_ITEM'), false)
})

test('disabled autonomy clearly reports that proactive conversation is disabled', () => {
  const logs = []
  const controller = new AutonomyController({ config: { enabled: false }, logger: { info: text => logs.push(text) } })
  assert.equal(controller.start(), false)
  assert.match(logs[0], /AUTONOMY_ENABLED=false/)
})

test('autonomy can emit speech during FOLLOW without owning or changing locomotion', async t => {
  const bot = new EventEmitter()
  const goals = new EventEmitter()
  goals.current = { source: 'PLAYER', type: 'FOLLOW' }
  const logs = []
  const state = { behavior: { type: 'FOLLOW', locomotionOwner: 'PLAYER' } }
  let executed = 0
  const controller = new AutonomyController({ bot, goalManager: goals,
    worldState: { build: () => state }, client: { decide: async received => {
      assert.equal(received.autonomyTrigger, 'weather')
      return { action: 'SAY', message: '开始下雨了', reason: 'new_rain' }
    } }, actions: { execute: async decision => { assert.equal(decision.action, 'SAY'); executed++; return { executed: true } } },
    movement: { getAutonomyEpoch: () => 0 }, journal: { record() {} },
    logger: { info: text => logs.push(text), throttled() {} }, config: { enabled: true, intervalMs: 600000, eventMinGapMs: 0 } })
  controller.start()
  t.after(() => controller.stop())
  await controller.trigger('weather')
  assert.equal(executed, 1)
  assert.equal(goals.current.type, 'FOLLOW')
})

test('rejected proactive line is fed back to the next autonomy decision', async t => {
  const bot = new EventEmitter()
  const goals = new EventEmitter()
  goals.current = null
  const received = []
  const controller = new AutonomyController({ bot, goalManager: goals,
    worldState: { build: () => ({ behavior: { locomotionOwner: 'NONE' } }) },
    client: { decide: async state => {
      received.push(state.recentRejectedSpeech)
      return received.length === 1
        ? { action: 'SAY', message: '最近挖煤进度如何？', reason: 'social' }
        : { action: 'IDLE', message: '', reason: 'no grounded topic' }
    } },
    actions: { execute: async decision => decision.action === 'SAY'
      ? { executed: false, reason: 'UNOBSERVED_SHARED_TASK' }
      : { executed: false, reason: 'IDLE' } },
    movement: { getAutonomyEpoch: () => 0 }, journal: { record() {} },
    logger: { info() {}, throttled() {} }, config: { enabled: true, intervalMs: 600000, eventMinGapMs: 0 } })
  controller.start()
  t.after(() => controller.stop())
  await controller.trigger('interval')
  await controller.trigger('interval')
  assert.deepEqual(received[0], [])
  assert.deepEqual(received[1], [{ message: '最近挖煤进度如何？', reason: 'UNOBSERVED_SHARED_TASK' }])
})

test('unrelated mobs being hurt do not trigger social inference', async t => {
  const bot = new EventEmitter()
  bot.username = 'AI_Companion'
  bot.entity = { id: 1 }
  bot.players = { Steve: { entity: { id: 2 } } }
  const goals = new EventEmitter()
  goals.current = null
  const details = []
  let calls = 0
  const controller = new AutonomyController({ bot, goalManager: goals,
    worldState: { build: () => ({ behavior: { locomotionOwner: 'NONE' } }) },
    client: { decide: async () => { calls++; return { action: 'IDLE', reason: 'quiet' } } },
    actions: { execute: async () => ({ executed: false, reason: 'IDLE' }) },
    movement: { getAutonomyEpoch: () => 0 }, journal: { record: (type, detail) => details.push([type, detail]) },
    logger: { info() {}, throttled() {} }, config: { enabled: true, intervalMs: 600000, eventMinGapMs: 0 } })
  controller.start()
  t.after(() => controller.stop())
  bot.emit('entityHurt', { id: 3, name: 'chicken' })
  assert.equal(calls, 0)
  assert.deepEqual(details.filter(([type]) => type === 'hurt'), [])
  await controller.scheduler.trigger('interval')
  bot.emit('entityHurt', { id: 2, username: 'Steve' })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(details.filter(([type]) => type === 'hurt'), [['hurt', 'Steve_hurt']])
})

test('speech diagnostics distinguish recent conversation from cooldown and topic dedup', () => {
  let now = 0
  const speech = new SpeechController({ chat() {} }, { cooldownMs: 1000, dedupMs: 5000, now: () => now, logger: { info() {} } })
  assert.equal(speech.say('开始下雨了', 'rain'), true)
  assert.equal(speech.say('夜晚来了', 'night'), false)
  assert.equal(speech.lastResult.reason, 'SPEECH_COOLDOWN')
  now = 1500
  assert.equal(speech.say('还在下雨', 'rain'), false)
  assert.equal(speech.lastResult.reason, 'TOPIC_DEDUP')
  speech.session = { canSpeakProactively: () => false, speechReadiness: () => ({ reason: 'CONVERSATION_GAP' }) }
  assert.equal(speech.say('夜晚来了', 'night'), false)
  assert.equal(speech.lastResult.reason, 'CONVERSATION_GAP')
})
