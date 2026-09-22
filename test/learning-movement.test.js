const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { MovementController } = require('../src/skills')
const { GoalManager, GOAL_SOURCES } = require('../src/goals')
const { PrimitiveActionExecutor } = require('../src/learning')

function vector(x, y, z) {
  return { x, y, z, offset(dx, dy, dz) { return vector(x + dx, y + dy, z + dz) } }
}

function fixture() {
  const goals = []
  const bot = new EventEmitter()
  bot.entity = { id: 1, position: vector(0, 64, 0) }
  bot.players = { Steve: { entity: { position: { x: 5, y: 64, z: 0 } } } }
  bot.pathfinder = { setMovements() {}, setGoal(goal, dynamic) { goals.push({ goal, dynamic }) } }
  bot.clearControlStates = () => {}
  bot.chat = () => {}
  bot.blockAt = position => position.y === 63
    ? { name: 'stone', boundingBox: 'block' }
    : { name: 'air', boundingBox: 'empty' }
  const goalManager = new GoalManager()
  const movement = new MovementController(bot, { logger: { info() {} }, goalManager })
  movement.initialize({})
  return { bot, movement, goalManager, goals }
}

test('learning lease blocks normal autonomy and presence', () => {
  const { movement } = fixture()
  assert.equal(movement.beginLearningSession(), true)
  assert.equal(movement.canRunPresence(), false)
  assert.equal(movement.canRunAutonomousNonMovement(movement.getAutonomyEpoch()), false)
  assert.equal(movement.startAutonomousMovement({
    type: 'EXPLORE_NEARBY', point: { x: 2, y: 64, z: 0 }, expectedAutonomyEpoch: movement.getAutonomyEpoch()
  }), false)
})

test('pending player task blocks presence before its episode or inference acquires movement', () => {
  const { movement } = fixture()
  movement.setLearningPending(true)
  assert.equal(movement.canRunPresence(), false)
  assert.equal(movement.startPresenceWalk(vector(1, 64, 0)), false)
  movement.beginLearningSession(GOAL_SOURCES.PLAYER_TASK)
  movement.setLearningPending(false)
  assert.equal(movement.canRunPresence(), false)
  movement.endLearningSession()
  assert.equal(movement.canRunPresence(), true)
})

test('persistent EXPLORE crosses short segments without stopping and discovers a model-watched target', async () => {
  const { bot, movement, goals } = fixture()
  movement.beginLearningSession(GOAL_SOURCES.PLAYER_TASK)
  let now = 0
  let poll
  let blocks = []
  const executor = new PrimitiveActionExecutor({ bot, movement,
    observer: { capture: () => ({ position: bot.entity.position, nearbyBlocks: blocks, inventory: {} }) },
    now: () => now, setTimeoutFn: callback => { poll = callback; return 1 }, clearTimeoutFn() {} })
  const pending = executor.execute({ action: 'EXPLORE', heading: 90, distance: 16, watchFor: ['test_target'] })
  const initialGoals = goals.length
  for (const x of [4, 8, 12]) {
    bot.entity.position = vector(x, 64, 0)
    now += 1000
    poll()
    assert.equal(movement.getLocomotionOwner(), 'PLAYER_TASK')
    assert.equal(goals.length, initialGoals)
  }
  blocks = [{ name: 'test_target', ref: 'block:13,64,0' }]
  now += 1000
  poll()
  assert.equal((await pending).reason, 'SYMBOLIC_DISCOVERY')
  assert.equal(movement.getLocomotionOwner(), 'NONE')
})

test('MOVE_NEAR keeps one path until route failure and supplies replanning evidence', async () => {
  const { bot, movement, goals } = fixture()
  movement.beginLearningSession()
  const executor = new PrimitiveActionExecutor({ bot, movement, observer: { resolve: () => ({ position: vector(14, 64, 0) }) } })
  const pending = executor.execute({ action: 'MOVE_NEAR', target: 'block:14,64,0', distance: 1 })
  const count = goals.length
  bot.entity.position = vector(5, 64, 0)
  bot.emit('goal_reached') // unrelated/stale event must not complete this intention
  assert.equal(goals.length, count)
  assert.equal(movement.getLocomotionOwner(), 'AUTONOMY')
  bot.emit('path_update', { status: 'noPath' })
  assert.equal((await pending).reason, 'NO_PATH')
})

test('player FOLLOW interrupts a persistent intention without its cleanup clearing FOLLOW', async () => {
  const { bot, movement, goals } = fixture()
  movement.beginLearningSession(GOAL_SOURCES.PLAYER_TASK)
  let poll
  const executor = new PrimitiveActionExecutor({ bot, movement, observer: {},
    setTimeoutFn: callback => { poll = callback; return 1 }, clearTimeoutFn() {} })
  const intention = executor.execute({ action: 'EXPLORE', heading: 90, distance: 16 })
  movement.follow('Steve')
  const followGoal = goals.at(-1)
  poll()
  assert.equal((await intention).reason, 'PLAYER_PREEMPTED')
  assert.equal(movement.getLocomotionOwner(), 'PLAYER')
  assert.equal(goals.at(-1), followGoal)
})

test('background visual inference leaves an active intention path intact', async () => {
  const { VisualPerceptionController, MultimodalWorldModel } = require('../src/vision')
  const { bot, movement, goals } = fixture()
  movement.beginLearningSession()
  const executor = new PrimitiveActionExecutor({ bot, movement, observer: {} })
  const moving = executor.execute({ action: 'EXPLORE', heading: 90, distance: 16 })
  const count = goals.length
  let complete
  const vision = new VisualPerceptionController({ frameStore: { getLatest: () => ({ id: 'frame', capturedAt: 0 }) },
    worldModel: new MultimodalWorldModel(), logger: { info() {}, error() {} }, now: () => 100,
    client: { observe: () => new Promise(resolve => { complete = resolve }) },
    config: { enabled: true, frameMaxAgeMs: 15000, backgroundIntervalMs: 30000 } })
  const perceiving = vision.request({ priority: 'BACKGROUND' })
  bot.entity.position = vector(6, 64, 0)
  complete({ sceneType: 'OPEN_TERRAIN' })
  assert.equal((await perceiving).status, 'UPDATED')
  assert.equal(goals.length, count)
  assert.equal(movement.getLocomotionOwner(), 'AUTONOMY')
  bot.entity.position = vector(16, 64, 0)
  bot.emit('goal_reached')
  assert.equal((await moving).reason, 'REACHED_TARGET')
})

test('survival preempts a learning movement and it resumes through the same arbiter', () => {
  const { movement, goalManager, goals } = fixture()
  movement.beginLearningSession()
  goalManager.request({ type: 'LEARNING_EPISODE', source: GOAL_SOURCES.AUTONOMOUS, resumable: true })
  assert.equal(movement.startLearningMovement({ x: 4, y: 64, z: 0 }, 2), true)
  assert.equal(movement.getLocomotionOwner(), 'AUTONOMY')

  movement.beginOverride('survival')
  assert.equal(movement.getLocomotionOwner(), 'SURVIVAL')
  movement.endOverride('survival')

  assert.equal(movement.getLocomotionOwner(), 'AUTONOMY')
  assert.ok(goals.at(-1).goal)
})

test('FOLLOW and STOP preempt PLAYER_TASK locomotion without ending learning state', () => {
  const { movement, goalManager } = fixture()
  movement.beginLearningSession(GOAL_SOURCES.PLAYER_TASK)
  const task = goalManager.request({ type: 'LEARNING_EPISODE', source: GOAL_SOURCES.PLAYER_TASK, resumable: true }).goal
  movement.startLearningMovement({ x: 4, y: 64, z: 0 }, 2)

  movement.follow('Steve')
  assert.equal(movement.getLocomotionOwner(), 'PLAYER')
  assert.equal(movement.isLearningActive(), true)
  assert.equal(goalManager.suspended.some(goal => goal.id === task.id), true)

  movement.stop()
  assert.equal(movement.getLocomotionOwner(), 'PLAYER')
  assert.equal(movement.isLearningActive(), true)
  assert.equal(goalManager.suspended.some(goal => goal.id === task.id), true)
})

test('primitive executor rejects invalid model actions before touching Mineflayer', async () => {
  let touched = false
  const executor = new PrimitiveActionExecutor({
    bot: { chat() { touched = true } },
    movement: {},
    observer: { resolve() { touched = true } }
  })
  const result = await executor.execute({ action: 'SHELL', command: 'echo unsafe' })
  assert.equal(result.success, false)
  assert.match(result.reason, /^INVALID_ACTION:/)
  assert.equal(touched, false)
})

test('learning ATTACK_ENTITY cannot bypass default DEFENSIVE combat policy', async () => {
  let attacked = false
  const target = { id: 2, type: 'hostile', position: { x: 1, y: 64, z: 0 } }
  const executor = new PrimitiveActionExecutor({
    bot: { entity: { position: { x: 0, y: 64, z: 0 } }, attack() { attacked = true } },
    movement: {},
    observer: { resolve: () => target },
    survival: { getCombatMode: () => 'DEFENSIVE' }
  })
  const result = await executor.execute({ action: 'ATTACK_ENTITY', target: 'entity:2' })
  assert.equal(result.success, false)
  assert.equal(result.reason, 'ATTACK_NOT_AUTHORIZED_IN_DEFENSIVE_MODE')
  assert.equal(attacked, false)
})

test('DIG_BLOCK performs one complete physical dig attempt', async () => {
  let dug = null
  const block = { name: 'test_block', position: { x: 1, y: 64, z: 0 } }
  const executor = new PrimitiveActionExecutor({
    bot: {
      entity: { position: { x: 0, y: 64, z: 0 } },
      canDigBlock: () => true,
      async dig(target) { dug = target }
    },
    movement: {},
    observer: { resolve: () => block }
  })
  const result = await executor.execute({ action: 'DIG_BLOCK', target: 'block:1,64,0' })
  assert.equal(result.success, true)
  assert.equal(result.reason, 'DIG_COMPLETED')
  assert.equal(dug, block)
})

test('EXPLORE uses learning locomotion and survives a survival preemption', async () => {
  const { bot, movement, goalManager } = fixture()
  movement.beginLearningSession()
  goalManager.request({ type: 'LEARNING_EPISODE', source: GOAL_SOURCES.AUTONOMOUS, resumable: true })
  const executor = new PrimitiveActionExecutor({ bot, movement, observer: { resolve: () => null }, moveTimeoutMs: 2000 })
  const pending = executor.execute({ action: 'EXPLORE', heading: 90, distance: 4 })
  while (movement.getLocomotionOwner() !== 'AUTONOMY') await Promise.resolve()

  movement.beginOverride('survival')
  assert.equal(movement.getLocomotionOwner(), 'SURVIVAL')
  movement.endOverride('survival')
  assert.equal(movement.getLocomotionOwner(), 'AUTONOMY')

  bot.entity.position = vector(4, 64, 0)
  bot.emit('goal_reached')
  const result = await pending
  assert.equal(result.success, true)
  assert.deepEqual(result.destination, { x: 4, y: 64, z: 0 })
})
