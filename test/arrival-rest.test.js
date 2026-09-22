const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { Vec3 } = require('vec3')
const { ArrivalController } = require('../src/companion/arrival-controller')
const { RestController, recognizeRestRequest } = require('../src/companion/rest-controller')
const { MovementController } = require('../src/skills/movement-controller')
const { GoalManager } = require('../src/goals')
const { groundActionReply } = require('../src/agent/action-claims')
const { createAgent } = require('../src/agent')

function fixture() {
  const bot = new EventEmitter()
  const goals = []
  const chats = []
  const timers = new Map()
  let timerId = 0
  const bed = { name: 'red_bed', position: new Vec3(1, 64, 0) }
  Object.assign(bot, {
    username: 'AI_Companion', entity: { position: new Vec3(0, 64, 0) },
    players: { Steve: { entity: { position: new Vec3(5, 64, 0) } } }, entities: {},
    game: { dimension: 'overworld' }, time: { timeOfDay: 14000 }, isSleeping: false,
    pathfinder: { setMovements() {}, setGoal: (goal, dynamic) => goals.push({ goal, dynamic }) },
    clearControlStates() {}, chat: text => chats.push(text), findBlocks: () => [bed.position],
    blockAt: () => bed, isABed: block => block.name === 'red_bed', parseBedMetadata: () => ({ occupied: false }),
    sleep: async () => { bot.isSleeping = true; bot.emit('sleep') }, wake: async () => { bot.isSleeping = false; bot.emit('wake') }
  })
  const logger = { info() {} }
  const movement = new MovementController(bot, { logger, goalManager: new GoalManager() })
  movement.initialize({})
  const options = { bot, movement, logger,
    setIntervalFn: callback => { timers.set(++timerId, callback); return timerId },
    clearIntervalFn: id => timers.delete(id),
    setTimeoutFn: callback => { timers.set(++timerId, callback); return timerId },
    clearTimeoutFn: id => timers.delete(id) }
  const rest = new RestController({ ...options, survival: { cancelPursuit() {} } })
  const arrival = new ArrivalController({ ...options, config: { enabled: true, delayMs: 3500, range: 16 } })
  return { bot, movement, goals, chats, timers, rest, arrival }
}

test('arrival starts one persistent autonomous FOLLOW without any model request', () => {
  const f = fixture()
  f.arrival.start()
  assert.equal(f.arrival.tryAccompany(), true)
  assert.equal(f.movement.getBehaviorSummary().source, 'AUTONOMOUS')
  const count = f.goals.length
  assert.equal(f.arrival.tryAccompany(), false)
  assert.equal(f.goals.length, count)
  assert.equal(f.goals.at(-1).dynamic, true)
})

test('STOP before arrival permanently invalidates that arrival intention', () => {
  const f = fixture()
  f.arrival.start()
  f.movement.stop()
  assert.equal(f.arrival.tryAccompany(), false)
  assert.equal(f.movement.getBehaviorSummary().type, 'STOP')
  assert.equal(f.arrival.started, false)
})

test('arrival cannot interrupt survival or a pending learning task', () => {
  const f = fixture()
  f.arrival.start()
  f.movement.beginOverride('survival')
  assert.equal(f.arrival.tryAccompany(), false)
  f.movement.endOverride('survival')
  f.movement.setLearningPending(true)
  assert.equal(f.arrival.tryAccompany(), false)
  f.arrival.stop()
})

test('sleep routing only recognizes explicit supported requests, not questions or negations', () => {
  for (const text of ['睡觉', '你躺床上', '上床睡觉', '睡一觉吧']) assert.equal(recognizeRestRequest(text), 'SLEEP')
  for (const text of ['起床', '别睡了', '你醒醒']) assert.equal(recognizeRestRequest(text), 'WAKE')
  for (const text of ['你会睡觉吗？', '不要睡觉', '我在睡觉', '设置重生点']) assert.equal(recognizeRestRequest(text), null)
})

test('sleep commands bypass model inference and unsupported respawn commands cannot fabricate completion', async t => {
  const f = fixture()
  const oldFetch = global.fetch
  t.after(() => { global.fetch = oldFetch })
  global.fetch = () => assert.fail('bed requests must not be conversation inference')
  const agent = createAgent({ bot: f.bot, movement: f.movement, rest: f.rest,
    survival: { observePlayer() {} }, logger: { info() {}, error: error => assert.fail(String(error)) }, config: {} })
  agent.start()
  t.after(() => agent.stop())
  f.bot.emit('chat', 'Steve', '睡觉')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.bot.isSleeping, true)
  f.bot.emit('chat', 'Steve', '设置一个重生点')
  assert.match(f.chats.at(-1), /还没接入/)
})

test('known unsupported bed completion claims are grounded before being sent', () => {
  for (const reply of ['重生点设好了，你先去休息', '床点好了，你先去休息', '我躺床上了']) {
    assert.notEqual(groundActionReply(reply, { isSleeping: false }), reply)
  }
  assert.equal(groundActionReply('我躺床上了', { isSleeping: true }), '我躺床上了')
  assert.equal(groundActionReply('你先休息', {}), '你先休息')
})

test('sleep refuses daytime and dangerous or unknown dimensions before interacting', async () => {
  for (const [dimension, time] of [['overworld', 1000], ['the_nether', 14000], ['the_end', 14000], [undefined, 14000]]) {
    const f = fixture()
    f.bot.game.dimension = dimension
    f.bot.time.timeOfDay = time
    f.bot.sleep = () => assert.fail('must not activate a bed')
    await f.rest.request('SLEEP')
    assert.equal(f.bot.isSleeping, false)
    assert.equal(f.goals.length, 0)
  }
})

test('sleep refuses occupied, missing or threatened beds', async () => {
  for (const problem of ['occupied', 'missing', 'hostile']) {
    const f = fixture()
    if (problem === 'occupied') f.bot.parseBedMetadata = () => ({ occupied: true })
    if (problem === 'missing') f.bot.findBlocks = () => []
    if (problem === 'hostile') f.bot.entities[2] = { type: 'hostile', position: new Vec3(5, 64, 0) }
    f.bot.sleep = () => assert.fail('unsafe sleep')
    await f.rest.request('SLEEP')
    assert.equal(f.goals.length, 0)
  }
})

test('sleep uses existing PLAYER ownership and confirms success only from server state', async () => {
  const f = fixture()
  f.rest.start()
  await f.rest.request('SLEEP')
  assert.equal(f.bot.isSleeping, true)
  assert.equal(f.movement.getLocomotionOwner(), 'PLAYER')
  assert.ok(f.chats.includes('这次确实躺下了。'))
  f.rest.stop()
  assert.equal(f.timers.size, 0)
})

test('rejected sleep never announces successful sleep', async () => {
  const f = fixture()
  f.bot.sleep = async () => { throw new Error('bed blocked') }
  await f.rest.request('SLEEP')
  assert.ok(!f.chats.includes('这次确实躺下了。'))
  assert.equal(f.rest.sleepPending, false)
  assert.equal(f.timers.size, 0)
})

test('FOLLOW during a pending sleep invalidates its completion and wakes a late sleep', async () => {
  const f = fixture()
  let release
  f.bot.sleep = async () => { await new Promise(resolve => { release = resolve }); f.bot.isSleeping = true }
  const pending = f.rest.request('SLEEP')
  f.rest.cancel()
  f.movement.follow('Steve')
  const pathCount = f.goals.length
  release()
  await pending
  assert.equal(f.bot.isSleeping, false)
  assert.equal(f.movement.getBehaviorSummary().type, 'FOLLOW')
  assert.equal(f.goals.length, pathCount)
  assert.ok(!f.chats.includes('这次确实躺下了。'))
})

test('survival wakes sleeping companion without replacing its emergency path', async () => {
  const f = fixture()
  f.rest.start()
  await f.rest.request('SLEEP')
  f.movement.beginOverride('survival')
  const count = f.goals.length
  for (const callback of [...f.timers.values()]) callback()
  await Promise.resolve()
  assert.equal(f.bot.isSleeping, false)
  assert.equal(f.movement.getLocomotionOwner(), 'SURVIVAL')
  assert.equal(f.goals.length, count)
  f.rest.stop()
})

test('confirmed wake restores the previous player FOLLOW once without another command', async () => {
  const f = fixture()
  f.movement.follow('Steve')
  f.rest.start()
  await f.rest.request('SLEEP')
  await f.rest.request('WAKE')
  assert.equal(f.movement.getBehaviorSummary().type, 'FOLLOW')
  assert.equal(f.movement.getBehaviorSummary().source, 'PLAYER')
  assert.equal(f.goals.at(-1).dynamic, true)
  const count = f.goals.length
  for (const callback of [...f.timers.values()]) callback()
  f.bot.emit('wake')
  assert.equal(f.goals.length, count)
  f.rest.stop()
})

test('natural morning wake restores autonomous companionship at its original lower priority', async () => {
  const f = fixture()
  f.movement.follow('Steve', { source: 'AUTONOMOUS' })
  f.rest.start()
  await f.rest.request('SLEEP')
  f.bot.isSleeping = false
  f.bot.emit('wake')
  assert.equal(f.movement.getBehaviorSummary().type, 'FOLLOW')
  assert.equal(f.movement.getBehaviorSummary().source, 'AUTONOMOUS')
  assert.equal(f.movement.getLocomotionOwner(), 'AUTONOMY')
  f.rest.stop()
})

test('explicit waiting before sleep remains waiting after wake', async () => {
  const f = fixture()
  f.movement.stop()
  await f.rest.request('SLEEP')
  await f.rest.request('WAKE')
  assert.equal(f.movement.getBehaviorSummary().type, 'STOP')
  assert.equal(f.movement.getLocomotionOwner(), 'PLAYER')
})

test('new STOP during sleep invalidates restoration even when no cancel hook is invoked', async () => {
  const f = fixture()
  f.movement.follow('Steve')
  f.rest.start()
  await f.rest.request('SLEEP')
  f.movement.stop()
  f.bot.isSleeping = false
  f.bot.emit('wake')
  assert.equal(f.movement.getBehaviorSummary().type, 'STOP')
  assert.equal(f.rest.resumePlan, null)
  f.rest.stop()
})

test('wake during survival defers FOLLOW until survival releases ownership', async () => {
  const f = fixture()
  f.movement.follow('Steve')
  f.rest.start()
  await f.rest.request('SLEEP')
  f.movement.beginOverride('survival')
  const count = f.goals.length
  f.bot.isSleeping = false
  f.bot.emit('wake')
  assert.equal(f.movement.getLocomotionOwner(), 'SURVIVAL')
  assert.equal(f.goals.length, count)
  f.movement.endOverride('survival')
  for (const callback of [...f.timers.values()]) callback()
  assert.equal(f.movement.getBehaviorSummary().type, 'FOLLOW')
  f.rest.stop()
})

test('failed sleep restores previous FOLLOW instead of leaving a temporary STOP', async () => {
  const f = fixture()
  f.movement.follow('Steve')
  f.bot.sleep = async () => { throw new Error('server denied') }
  await f.rest.request('SLEEP')
  assert.equal(f.movement.getBehaviorSummary().type, 'FOLLOW')
})

test('rest entered from idle releases its temporary PLAYER lock after waking', async () => {
  const f = fixture()
  await f.rest.request('SLEEP')
  await f.rest.request('WAKE')
  assert.equal(f.movement.getLocomotionOwner(), 'NONE')
  assert.equal(f.movement.canRunPresence(), true)
})

test('a missing follow target is not replaced with another player and resume expires', async () => {
  const f = fixture()
  let now = 0
  f.rest.now = () => now
  f.movement.follow('Steve')
  f.rest.start()
  await f.rest.request('SLEEP')
  delete f.bot.players.Steve
  f.bot.players.Alex = { entity: { position: new Vec3(1, 64, 0) } }
  await f.rest.request('WAKE')
  assert.equal(f.movement.getBehaviorSummary().type, 'STOP')
  now = 31000
  for (const callback of [...f.timers.values()]) callback()
  assert.equal(f.rest.resumePlan, null)
  assert.equal(f.movement.getBehaviorSummary().type, 'STOP')
  f.rest.stop()
})
