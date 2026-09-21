class AutonomyScheduler {
  constructor({
    intervalMs,
    eventMinGapMs,
    onRun,
    now = Date.now,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval
  }) {
    this.intervalMs = intervalMs
    this.eventMinGapMs = eventMinGapMs
    this.onRun = onRun
    this.now = now
    this.setIntervalFn = setIntervalFn
    this.clearIntervalFn = clearIntervalFn
    this.timer = null
    this.running = false
    this.lastStartedAt = -Infinity
  }

  start() {
    if (this.timer !== null) return false
    this.timer = this.setIntervalFn(() => { void this.request('interval') }, this.intervalMs)
    return true
  }

  stop() {
    if (this.timer === null) return false
    this.clearIntervalFn(this.timer)
    this.timer = null
    return true
  }

  trigger(reason) {
    if (this.now() - this.lastStartedAt < this.eventMinGapMs) return Promise.resolve(false)
    return this.request(reason)
  }

  async request(reason = 'manual') {
    if (this.running) return false
    this.running = true
    this.lastStartedAt = this.now()
    try {
      await this.onRun(reason)
      return true
    } finally {
      this.running = false
    }
  }
}

module.exports = { AutonomyScheduler }
