class AutonomyScheduler {
  constructor({
    intervalMs,
    eventMinGapMs,
    onRun,
    now = Date.now,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout
  }) {
    this.intervalMs = intervalMs
    this.eventMinGapMs = eventMinGapMs
    this.onRun = onRun
    this.now = now
    this.setIntervalFn = setIntervalFn
    this.clearIntervalFn = clearIntervalFn
    this.setTimeoutFn = setTimeoutFn
    this.clearTimeoutFn = clearTimeoutFn
    this.timer = null
    this.pendingTimer = null
    this.pendingReason = null
    this.running = false
    this.lastStartedAt = -Infinity
  }

  start() {
    if (this.timer !== null) return false
    this.timer = this.setIntervalFn(() => { void this.request('interval') }, this.intervalMs)
    return true
  }

  stop() {
    const wasStarted = this.timer !== null
    if (wasStarted) this.clearIntervalFn(this.timer)
    this.timer = null
    if (this.pendingTimer !== null) this.clearTimeoutFn(this.pendingTimer)
    this.pendingTimer = null
    this.pendingReason = null
    return wasStarted
  }

  trigger(reason) {
    if (this.running || this.pendingTimer !== null) {
      this.pendingReason = reason
      return Promise.resolve(false)
    }
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
      this.#schedulePending()
    }
  }

  #schedulePending() {
    if (this.pendingReason === null || this.pendingTimer !== null || this.running) return
    const delay = Math.max(0, this.eventMinGapMs - (this.now() - this.lastStartedAt))
    this.pendingTimer = this.setTimeoutFn(() => {
      this.pendingTimer = null
      if (this.running) return
      if (this.now() - this.lastStartedAt < this.eventMinGapMs) {
        this.#schedulePending()
        return
      }
      const pending = this.pendingReason
      this.pendingReason = null
      if (pending !== null) void this.request(pending)
    }, delay)
    this.pendingTimer?.unref?.()
  }
}

module.exports = { AutonomyScheduler }
