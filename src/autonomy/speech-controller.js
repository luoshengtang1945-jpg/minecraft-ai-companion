class SpeechController {
  constructor(bot, { cooldownMs, dedupMs, logger, now = Date.now }) {
    this.bot = bot
    this.cooldownMs = cooldownMs
    this.dedupMs = dedupMs
    this.logger = logger
    this.now = now
    this.lastSpokenAt = -Infinity
    this.recent = new Map()
  }

  say(text, key = text) {
    const message = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim().slice(0, 220) : ''
    if (!message) return false

    const now = this.now()
    if (now - this.lastSpokenAt < this.cooldownMs) return false

    const normalized = String(key || message).toLowerCase().replace(/\s+/g, ' ').trim()
    if (now - (this.recent.get(normalized) ?? -Infinity) < this.dedupMs) return false

    this.lastSpokenAt = now
    this.recent.set(normalized, now)
    for (const [oldKey, spokenAt] of this.recent) {
      if (now - spokenAt >= this.dedupMs) this.recent.delete(oldKey)
    }

    this.bot.chat(message)
    this.logger.info(`Autonomous speech: ${message}`)
    return true
  }
}

module.exports = { SpeechController }
