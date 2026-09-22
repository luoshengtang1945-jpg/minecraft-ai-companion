const { GOAL_SOURCES } = require('../goals')

// One arrival intention, not a per-tick replacement of GoalFollow.
class ArrivalController {
  constructor({ bot, movement, logger, config, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout }) {
    Object.assign(this, { bot, movement, logger, config, setTimeoutFn, clearTimeoutFn })
    this.timer = null
    this.remaining = 20
    this.started = false
  }

  start() {
    if (this.started || !this.config.enabled) return
    this.started = true
    this.epoch = this.movement.getPlayerCommandEpoch()
    this.#schedule(this.config.delayMs)
  }

  stop() {
    this.started = false
    if (this.timer !== null) this.clearTimeoutFn(this.timer)
    this.timer = null
  }

  #schedule(delay) {
    this.timer = this.setTimeoutFn(() => { this.timer = null; this.tryAccompany() }, delay)
  }

  tryAccompany() {
    if (!this.started) return false
    if (this.epoch !== this.movement.getPlayerCommandEpoch()) { this.stop(); return false }
    const origin = this.bot.entity?.position
    const candidate = origin && Object.entries(this.bot.players || {})
      .filter(([name, player]) => name !== this.bot.username && player.entity?.position)
      .map(([name, player]) => ({ name, distance: origin.distanceTo(player.entity.position) }))
      .filter(player => player.distance <= this.config.range)
      .sort((a, b) => a.distance - b.distance)[0]
    if (candidate && this.movement.canRunPresence() && this.movement.follow(candidate.name, {
      source: GOAL_SOURCES.AUTONOMOUS, expectedAutonomyEpoch: this.movement.getAutonomyEpoch()
    })) {
      this.logger.info(`[COMPANION] Arrival: accompanying ${candidate.name}; player commands override`)
      this.stop()
      return true
    }
    if (--this.remaining > 0) this.#schedule(1000)
    else { this.logger.info('[COMPANION] Arrival: no available nearby companion opportunity'); this.stop() }
    return false
  }
}

module.exports = { ArrivalController }
