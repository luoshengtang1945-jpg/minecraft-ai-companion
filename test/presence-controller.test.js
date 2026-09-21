const test = require('node:test')
const assert = require('node:assert/strict')
const { PresenceController } = require('../src/presence/presence-controller')

function vector(x = 0, y = 64, z = 0) {
  return {
    x,
    y,
    z,
    offset(dx, dy, dz) { return vector(x + dx, y + dy, z + dz) },
    distanceTo(other) { return Math.hypot(x - other.x, y - other.y, z - other.z) }
  }
}

function presenceFixture({ canRun = true } = {}) {
  const scheduled = []
  let looks = 0
  const bot = {
    username: 'AI_Companion',
    entity: { position: vector() },
    players: {},
    async lookAt() { looks += 1 }
  }
  const movement = {
    canRunPresence: () => canRun,
    getBehaviorSummary: () => ({ username: null }),
    startPresenceWalk: () => false,
    cancelPresenceWalk() {}
  }
  const controller = new PresenceController({
    bot,
    movement,
    logger: { info() {}, throttled() {} },
    config: {
      enabled: true,
      initialMinMs: 1000,
      initialMaxMs: 2000,
      intervalMinMs: 10000,
      intervalMaxMs: 20000,
      walkTimeoutMs: 8000,
      maxPlayerDistance: 16
    },
    random: () => 0.5,
    setTimeoutFn(callback, delay) {
      scheduled.push({ callback, delay })
      return scheduled.length
    },
    clearTimeoutFn() {}
  })
  return { controller, scheduled, getLooks: () => looks }
}

test('spawn presence is scheduled quickly without Ollama', async () => {
  const { controller, scheduled, getLooks } = presenceFixture()
  controller.start()
  assert.equal(scheduled.length, 1)
  assert.ok(scheduled[0].delay >= 1000 && scheduled[0].delay <= 2000)
  await scheduled[0].callback()
  assert.equal(getLooks(), 1)
})

test('presence does not run while FOLLOW owns locomotion', async () => {
  const { controller, getLooks } = presenceFixture({ canRun: false })
  controller.start()
  assert.equal(await controller.runOnce(), false)
  assert.equal(getLooks(), 0)
})

test('presence does not run while survival owns locomotion', async () => {
  const { controller, getLooks } = presenceFixture({ canRun: false })
  controller.start()
  assert.equal(await controller.runOnce(), false)
  assert.equal(getLooks(), 0)
})

test('LOOK presence does not stop or replace a pathfinder goal', async () => {
  let pathMutations = 0
  const { controller } = presenceFixture()
  controller.movement.startPresenceWalk = () => { pathMutations += 1; return false }
  controller.movement.cancelPresenceWalk = () => { pathMutations += 1 }
  controller.start()
  await controller.runOnce()
  assert.equal(pathMutations, 0)
})
