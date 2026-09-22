// Read-only, bounded session context. Never owns movement or calls a model.
class CompanionSessionContext {
  constructor({ bot, movement, now = Date.now, setIntervalFn = setInterval, clearIntervalFn = clearInterval }) {
    this.bot = bot
    this.movement = movement
    this.now = now
    this.setIntervalFn = setIntervalFn
    this.clearIntervalFn = clearIntervalFn
    this.timer = null
    this.preferredPlayer = null
    this.sample = null
    this.recentDialogue = []
    this.startedAt = this.now()
  }

  start() {
    if (this.timer !== null) return
    this.samplePlayer()
    this.timer = this.setIntervalFn(() => this.samplePlayer(), 1000)
  }

  stop() {
    if (this.timer !== null) this.clearIntervalFn(this.timer)
    this.timer = null
    this.sample = null
    this.recentDialogue = []
    this.preferredPlayer = null
  }

  recordPlayer(username, text) {
    this.preferredPlayer = username
    this.#record('player', username, text)
  }

  recordSpeech(text) {
    this.#record('companion', this.bot.username, text)
  }

  #record(speaker, username, text) {
    this.recentDialogue.push({ speaker, username, text: String(text).replace(/\s+/g, ' ').trim().slice(0, 220), at: this.now() })
    this.#prune()
  }

  #prune() {
    this.recentDialogue = this.recentDialogue.filter(entry => this.now() - entry.at < 300000).slice(-6)
  }

  #player() {
    const preferred = this.movement.getBehaviorSummary().username || this.preferredPlayer
    const players = this.bot.players || {}
    // A missing followed player is missing evidence, not permission to switch identity.
    if (preferred) return players[preferred]?.entity?.position ? { username: preferred, entity: players[preferred].entity } : null
    const entry = Object.entries(players).find(([name, player]) => name !== this.bot.username && player.entity?.position)
    return entry ? { username: entry[0], entity: entry[1].entity } : null
  }

  samplePlayer() {
    const player = this.#player()
    if (!player) { this.sample = null; return }
    const now = this.now()
    const { x, y, z } = player.entity.position
    const previous = this.sample
    const continuous = previous && previous.username === player.username && now - previous.at <= 5000 && now >= previous.at
    const displacement = continuous ? Math.hypot(x - previous.position.x, z - previous.position.z) : null
    const moved = displacement !== null && displacement >= 0.25
    const lastMovedAt = moved ? now : continuous ? previous.lastMovedAt : null
    const observedSince = continuous ? previous.observedSince : now
    const activity = lastMovedAt !== null && now - lastMovedAt < 3000
      ? 'MOVING' : now - observedSince >= 3000 ? 'STATIONARY' : 'UNKNOWN'
    this.sample = {
      username: player.username, position: { x, y, z }, at: now, observedSince, lastMovedAt,
      activity, activitySince: continuous && previous.activity === activity ? previous.activitySince : now
    }
  }

  snapshot() {
    this.#prune()
    const now = this.now()
    const behavior = this.movement.getBehaviorSummary()
    const player = this.#player()
    const sample = player && this.sample?.username === player.username && now - this.sample.at <= 3000 ? this.sample : null
    const origin = this.bot.entity?.position
    const target = player?.entity.position
    return {
      source: 'SHORT_TERM_SYMBOLIC_OBSERVATIONS',
      behavior,
      world: { timeOfDay: this.bot.time?.timeOfDay ?? null, raining: this.bot.isRaining ?? null, isDay: this.bot.time?.isDay ?? null },
      companion: { health: this.bot.health ?? null, sleeping: Boolean(this.bot.isSleeping) },
      playerCommitment: behavior.source === 'PLAYER' ? behavior.type : null,
      interruptedBySurvival: behavior.locomotionOwner === 'SURVIVAL',
      speech: this.speechReadiness(),
      player: player ? {
        username: player.username,
        distance: origin ? Math.round(Math.hypot(origin.x - target.x, origin.y - target.y, origin.z - target.z) * 10) / 10 : null,
        activity: sample?.activity || 'UNKNOWN',
        activityDurationSeconds: sample ? Math.floor((now - sample.activitySince) / 1000) : 0,
        heldItem: player.entity.heldItem?.name || null
      } : null,
      recentDialogue: this.recentDialogue.map(({ at, ...entry }) => ({ ...entry, ageSeconds: Math.floor((now - at) / 1000) }))
    }
  }

  canSpeakProactively(text) {
    return this.speechReadiness(text).eligible
  }

  speechReadiness(text = null) {
    this.#prune()
    const quietSeconds = Math.floor((this.now() - (this.recentDialogue.at(-1)?.at ?? this.startedAt)) / 1000)
    if (quietSeconds < 15) return { eligible: false, reason: 'CONVERSATION_GAP', quietSeconds }
    const normalize = value => value.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '')
    const repeated = text !== null && this.recentDialogue.some(entry => entry.speaker === 'companion' && normalize(entry.text) === normalize(text))
    return { eligible: !repeated, reason: repeated ? 'RECENT_TEXT' : 'READY', quietSeconds }
  }
}

module.exports = { CompanionSessionContext }
