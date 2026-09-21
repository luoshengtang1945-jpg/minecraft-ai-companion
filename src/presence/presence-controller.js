const { findSafePositionNear } = require('../autonomy/safe-position')

class PresenceController {
  constructor({ bot, movement, logger, config, random = Math.random, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout }) {
    this.bot = bot
    this.movement = movement
    this.logger = logger
    this.config = config
    this.random = random
    this.setTimeoutFn = setTimeoutFn
    this.clearTimeoutFn = clearTimeoutFn
    this.timer = null
    this.walkTimer = null
    this.started = false
    this.hasRun = false
  }

  start() {
    if (this.started || !this.config.enabled) return false
    this.started = true
    this.#schedule(this.#randomDelay(this.config.initialMinMs, this.config.initialMaxMs))
    this.logger.info('Lightweight presence enabled')
    return true
  }

  stop() {
    if (!this.started) return false
    this.started = false
    if (this.timer) this.clearTimeoutFn(this.timer)
    if (this.walkTimer) this.clearTimeoutFn(this.walkTimer)
    this.timer = null
    this.walkTimer = null
    return true
  }

  async runOnce() {
    if (!this.started || !this.movement.canRunPresence()) return false

    if (!this.hasRun) {
      this.hasRun = true
      return this.#nearbyPlayer() ? this.#lookAtPlayer() : this.#lookAround()
    }

    const roll = this.random()
    if (roll < 0.35) return this.#lookAtPlayer()
    if (roll < 0.65) return this.#lookAround()
    if (roll < 0.75) return this.#shortWalk()
    return true
  }

  #schedule(delayMs) {
    this.timer = this.setTimeoutFn(async () => {
      this.timer = null
      try {
        await this.runOnce()
      } catch (error) {
        this.logger.throttled('presence-error', 10000, 'error', 'Presence action failed', error)
      } finally {
        if (this.started) this.#schedule(this.#randomDelay(this.config.intervalMinMs, this.config.intervalMaxMs))
      }
    }, delayMs)
  }

  async #lookAtPlayer() {
    const player = this.#nearbyPlayer()
    if (!player || !this.movement.canRunPresence()) return false
    await this.bot.lookAt(player.position.offset(0, Math.max((player.height || 1.8) * 0.8, 1), 0), true)
    return true
  }

  async #lookAround() {
    if (!this.bot.entity?.position || !this.movement.canRunPresence()) return false
    const angle = this.random() * Math.PI * 2
    const target = this.bot.entity.position.offset(Math.cos(angle) * 5, 1.4, Math.sin(angle) * 5)
    await this.bot.lookAt(target, true)
    return true
  }

  #shortWalk() {
    if (!this.bot.entity?.position || !this.movement.canRunPresence()) return false
    const player = this.#nearbyPlayer()
    const point = findSafePositionNear(this.bot, this.bot.entity.position, {
      minRadius: 1,
      maxRadius: 3,
      attempts: 10,
      random: this.random
    })
    if (!point) return false
    if (player && player.position.distanceTo(point) > this.config.maxPlayerDistance) return false
    if (!this.movement.startPresenceWalk(point)) return false

    if (this.walkTimer) this.clearTimeoutFn(this.walkTimer)
    this.walkTimer = this.setTimeoutFn(() => {
      this.walkTimer = null
      this.movement.cancelPresenceWalk()
    }, this.config.walkTimeoutMs)
    return true
  }

  #nearbyPlayer() {
    const preferred = this.movement.getBehaviorSummary().username
    if (preferred && this.bot.players[preferred]?.entity) return this.bot.players[preferred].entity
    for (const [username, player] of Object.entries(this.bot.players || {})) {
      if (username !== this.bot.username && player.entity) return player.entity
    }
    return null
  }

  #randomDelay(min, max) {
    return Math.round(min + this.random() * Math.max(0, max - min))
  }
}

module.exports = { PresenceController }
