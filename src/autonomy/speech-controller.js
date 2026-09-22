class SpeechController {
  constructor(bot, { cooldownMs, dedupMs, logger, now = Date.now, session = null }) {
    this.session = session
    this.bot = bot
    this.cooldownMs = cooldownMs
    this.dedupMs = dedupMs
    this.logger = logger
    this.now = now
    this.lastSpokenAt = -Infinity
    this.recent = new Map()
    this.lastResult = null
  }

  say(text, key = text) {
    const message = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim().slice(0, 220) : ''
    if (!message) return this.#reject('EMPTY_MESSAGE')
    if (this.session && !this.session.canSpeakProactively(message)) return this.#reject(this.session.speechReadiness(message).reason)

    const now = this.now()
    if (now - this.lastSpokenAt < this.cooldownMs) return this.#reject('SPEECH_COOLDOWN')

    const normalized = String(key || message).toLowerCase().replace(/\s+/g, ' ').trim()
    if (now - (this.recent.get(normalized) ?? -Infinity) < this.dedupMs) return this.#reject('TOPIC_DEDUP')

    this.lastSpokenAt = now
    this.recent.set(normalized, now)
    for (const [oldKey, spokenAt] of this.recent) {
      if (now - spokenAt >= this.dedupMs) this.recent.delete(oldKey)
    }

    this.bot.chat(message)
    this.session?.recordSpeech(message)
    this.logger.info(`Autonomous speech: ${message}`)
    this.lastResult = { executed: true, reason: null }
    return true
  }

  #reject(reason) {
    this.lastResult = { executed: false, reason }
    this.logger.throttled?.(`speech-${reason}`, 15000, 'info', `[SPEECH] Skipped: ${reason}`)
    return false
  }
}

module.exports = { SpeechController }
