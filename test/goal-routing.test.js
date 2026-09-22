const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { classifyPlayerMessage, PLAYER_MESSAGE_TYPES } = require('../src/agent/goal-router')
const { createAgent } = require('../src/agent')

test('player messages route to conversation, immediate command, task goal, or cancellation', () => {
  assert.equal(classifyPlayerMessage('Steve', '你好').type, PLAYER_MESSAGE_TYPES.CONVERSATION)
  assert.equal(classifyPlayerMessage('Steve', '跟我来').type, PLAYER_MESSAGE_TYPES.IMMEDIATE_COMMAND)
  assert.equal(classifyPlayerMessage('Steve', '停下').type, PLAYER_MESSAGE_TYPES.IMMEDIATE_COMMAND)
  assert.equal(classifyPlayerMessage('Steve', '帮我弄点木头').type, PLAYER_MESSAGE_TYPES.TASK_GOAL)
  assert.equal(classifyPlayerMessage('Steve', '你试试怎么获得一个原木').type, PLAYER_MESSAGE_TYPES.TASK_GOAL)
  assert.equal(classifyPlayerMessage('Steve', '别弄了').type, PLAYER_MESSAGE_TYPES.CANCEL_TASK)
})

test('natural wood request maps only to the oak_log outcome, not a solution', () => {
  const routed = classifyPlayerMessage('Steve', '去搞一个原木')
  assert.equal(routed.goal.source, 'PLAYER_TASK')
  assert.deepEqual(routed.goal.objective, { type: 'INVENTORY_AT_LEAST', item: 'oak_log', count: 1 })
  assert.equal('steps' in routed.goal, false)
  assert.equal('recipe' in routed.goal, false)
})

function agentFixture() {
  const bot = new EventEmitter()
  const messages = []
  bot.username = 'AI_Companion'
  bot.chat = message => messages.push(message)
  let cancels = 0
  const taskStarts = []
  const learning = {
    cancel() { cancels += 1; return true },
    startPlayerTask(task) { taskStarts.push(task); return Promise.resolve() },
    getTaskSummary: () => ({ goal: 'Obtain at least one oak_log.', attempts: 1, lastAction: 'OBSERVE', lastEvaluation: 'NO_PROGRESS' })
  }
  let follows = 0
  let stops = 0
  let epoch = 0
  const movement = {
    follow() { follows += 1; epoch += 1; return true },
    come() { epoch += 1; return true },
    stop() { stops += 1; epoch += 1; return true },
    getPlayerCommandEpoch: () => epoch
  }
  const agent = createAgent({
    bot,
    movement,
    survival: { observePlayer() {}, setCombatMode() {}, requestAttack: () => ({ reason: 'NO_TARGET' }) },
    autonomy: { observePlayer() {} },
    learning,
    logger: { info() {}, error() {} },
    config: { url: 'http://local.test', model: 'test', timeoutMs: 5000 }
  })
  return { bot, messages, learning, taskStarts, movement, agent, counts: () => ({ cancels, follows, stops }) }
}

test('TASK_GOAL acknowledges immediately before asynchronous task completion', () => {
  const fixture = agentFixture()
  fixture.learning.startPlayerTask = task => {
    fixture.taskStarts.push(task)
    return new Promise(() => {})
  }
  fixture.agent.start()
  fixture.bot.emit('chat', 'Steve', '帮我弄点木头')

  assert.deepEqual(fixture.messages, ['行，我试试。'])
  assert.equal(fixture.taskStarts.length, 1)
  assert.equal(fixture.taskStarts[0].goal.source, 'PLAYER_TASK')
  fixture.agent.stop()
})

test('normal chat does not cancel learning and explicit cancellation does', async () => {
  const originalFetch = global.fetch
  global.fetch = async () => ({ ok: true, json: async () => ({ message: { content: '{"action":"CHAT","reply":"在试呢。"}' } }) })
  try {
    const fixture = agentFixture()
    fixture.agent.start()
    fixture.bot.emit('chat', 'Steve', '你在干嘛？')
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(fixture.counts().cancels, 0)
    assert.ok(fixture.messages.includes('在试呢。'))

    fixture.bot.emit('chat', 'Steve', '算了，别弄了')
    assert.equal(fixture.counts().cancels, 1)
    assert.equal(fixture.messages.at(-1), '好，不弄了。')
    fixture.agent.stop()
  } finally {
    global.fetch = originalFetch
  }
})

test('FOLLOW and STOP take immediate control without cancelling the task', async () => {
  const originalFetch = global.fetch
  global.fetch = async () => ({ ok: true, json: async () => ({ message: { content: '{"action":"CHAT","reply":"好"}' } }) })
  try {
    const fixture = agentFixture()
    fixture.agent.start()
    fixture.bot.emit('chat', 'Steve', '跟我来')
    fixture.bot.emit('chat', 'Steve', '停下')
    assert.equal(fixture.counts().follows, 1)
    assert.equal(fixture.counts().stops, 1)
    assert.equal(fixture.counts().cancels, 0)
    await new Promise(resolve => setImmediate(resolve))
    fixture.agent.stop()
  } finally {
    global.fetch = originalFetch
  }
})
