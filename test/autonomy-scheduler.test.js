const test = require('node:test')
const assert = require('node:assert/strict')
const { AutonomyScheduler } = require('../src/autonomy/scheduler')

test('autonomy scheduler uses the configured interval', () => {
  let scheduledCallback = null
  let scheduledMs = null
  const scheduler = new AutonomyScheduler({
    intervalMs: 30000,
    eventMinGapMs: 10000,
    onRun: async () => {},
    setIntervalFn(callback, ms) {
      scheduledCallback = callback
      scheduledMs = ms
      return 1
    },
    clearIntervalFn() {}
  })

  assert.equal(scheduler.start(), true)
  assert.equal(scheduledMs, 30000)
  assert.equal(typeof scheduledCallback, 'function')
  assert.equal(scheduler.start(), false)
})

test('autonomy scheduler permits only one inference at a time', async () => {
  let release
  let runs = 0
  const gate = new Promise(resolve => { release = resolve })
  const scheduler = new AutonomyScheduler({
    intervalMs: 30000,
    eventMinGapMs: 0,
    onRun: async () => {
      runs += 1
      await gate
    }
  })

  const first = scheduler.request('first')
  const second = await scheduler.request('second')
  assert.equal(second, false)
  assert.equal(runs, 1)
  release()
  assert.equal(await first, true)
})

test('event triggers respect their minimum gap', async () => {
  let now = 1000
  let runs = 0
  const scheduler = new AutonomyScheduler({
    intervalMs: 30000,
    eventMinGapMs: 10000,
    now: () => now,
    onRun: async () => { runs += 1 }
  })

  assert.equal(await scheduler.trigger('first'), true)
  now = 5000
  assert.equal(await scheduler.trigger('too-soon'), false)
  now = 12000
  assert.equal(await scheduler.trigger('later'), true)
  assert.equal(runs, 2)
})

test('goal completion during inference is coalesced and reconsidered after the gap', async () => {
  let now = 1000
  let release
  let pendingTimer
  const runs = []
  const scheduler = new AutonomyScheduler({
    intervalMs: 30000,
    eventMinGapMs: 10000,
    now: () => now,
    setTimeoutFn(callback, delay) { pendingTimer = { callback, delay }; return 1 },
    clearTimeoutFn() { pendingTimer = null },
    onRun: async reason => {
      runs.push(reason)
      if (reason === 'first') await new Promise(resolve => { release = resolve })
    }
  })
  const first = scheduler.request('first')
  await scheduler.trigger('goal_finished')
  await scheduler.trigger('goal_finished')
  release()
  await first
  assert.deepEqual(runs, ['first'])
  assert.equal(pendingTimer.delay, 10000)
  now = 11000
  pendingTimer.callback()
  await Promise.resolve()
  assert.deepEqual(runs, ['first', 'goal_finished'])
  scheduler.stop()
})

test('stopping scheduler discards a queued goal event', async () => {
  let release
  let pendingTimer
  const runs = []
  const scheduler = new AutonomyScheduler({
    intervalMs: 30000,
    eventMinGapMs: 10000,
    setTimeoutFn(callback) { pendingTimer = callback; return 1 },
    clearTimeoutFn() { pendingTimer = null },
    onRun: async reason => {
      runs.push(reason)
      if (reason === 'first') await new Promise(resolve => { release = resolve })
    }
  })
  const first = scheduler.request('first')
  await scheduler.trigger('goal_finished')
  release()
  await first
  scheduler.stop()
  assert.equal(pendingTimer, null)
  assert.deepEqual(runs, ['first'])
})
