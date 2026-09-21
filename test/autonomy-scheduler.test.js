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
