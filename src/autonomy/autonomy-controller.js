const { GOAL_SOURCES } = require('../goals')
const { AutonomyScheduler } = require('./scheduler')
const { isOllamaPreempted } = require('../ollama')

const REJECTED_SPEECH_BACKOFF_MS = 120000

function isFreshWorldEvent(reason) {
  return reason === 'hurt' || reason === 'weather' || String(reason).startsWith('time_')
}

function timePhase(timeOfDay) {
  if (!Number.isFinite(timeOfDay)) return 'unknown'
  if (timeOfDay < 12000) return 'day'
  if (timeOfDay < 13000) return 'dusk'
  if (timeOfDay < 23000) return 'night'
  return 'dawn'
}

class AutonomyController {
  constructor({ bot, worldState, client, actions, movement, goalManager, journal, logger, config }) {
    this.bot = bot
    this.worldState = worldState
    this.client = client
    this.actions = actions
    this.movement = movement
    this.goalManager = goalManager
    this.journal = journal
    this.logger = logger
    this.config = config
    this.started = false
    this.lastTimePhase = null
    this.listeners = []
    this.suppressedReasons = new Set()
    this.rejectedSpeech = []
    this.recentGoalOutcomes = []
    this.freeIdleStreak = 0
    this.scheduler = new AutonomyScheduler({
      intervalMs: config.intervalMs,
      eventMinGapMs: config.eventMinGapMs,
      onRun: reason => this.#run(reason)
    })
  }

  start() {
    if (this.started) return false
    if (!this.config.enabled) {
      this.logger.info('[AUTONOMY] Disabled by AUTONOMY_ENABLED=false; no proactive conversation')
      return false
    }
    this.started = true
    this.#listen(this.bot, 'entityHurt', entity => {
      const companionHurt = Number.isInteger(entity?.id) && entity.id === this.bot.entity?.id
      const player = companionHurt || !Number.isInteger(entity?.id) ? null : Object.entries(this.bot.players || {})
        .find(([username, entry]) => username !== this.bot.username && entry.entity?.id === entity?.id)?.[0]
      if (!companionHurt && !player) return
      const detail = companionHurt ? 'companion_hurt' : `${player}_hurt`
      this.journal.record('hurt', detail)
      void this.scheduler.trigger('hurt')
    })
    this.#listen(this.bot, 'rain', () => {
      this.journal.record('weather', this.bot.isRaining ? 'rain_started' : 'rain_stopped')
      void this.scheduler.trigger('weather')
    })
    this.#listen(this.bot, 'time', () => this.#handleTime())
    this.#listen(this.bot, 'playerJoined', player => this.journal.record('player_joined', player.username))
    this.#listen(this.bot, 'playerLeft', player => this.journal.record('player_left', player.username))
    this.#listen(this.goalManager, 'changed', change => this.#handleGoalChange(change))
    this.scheduler.start()
    this.logger.info(`Autonomy enabled; interval ${this.config.intervalMs}ms`)
    return true
  }

  stop() {
    if (!this.started) return false
    this.started = false
    this.scheduler.stop()
    for (const { emitter, event, listener } of this.listeners) emitter.removeListener(event, listener)
    this.listeners = []
    return true
  }

  observePlayer(username, message) {
    this.worldState.observePlayer(username)
    this.journal.record('player_chat', `${username}: ${message}`)
    this.freeIdleStreak = 0
  }

  trigger(reason) {
    if (this.suppressedReasons.size) return false
    return this.scheduler.trigger(reason)
  }

  setSuppressed(suppressed, reason = 'external') {
    const wasSuppressed = this.suppressedReasons.size > 0
    if (suppressed) this.suppressedReasons.add(reason)
    else this.suppressedReasons.delete(reason)
    if (suppressed) {
      this.freeIdleStreak = 0
      this.logger.info(`[AUTONOMY] Paused: ${reason}`)
      this.movement.invalidateAutonomy?.()
      this.client.cancelPending?.()
    } else if (wasSuppressed && !this.suppressedReasons.size && this.started) {
      queueMicrotask(() => {
        if (this.started && !this.suppressedReasons.size) void this.scheduler.trigger('resumed')
      })
    }
    return this.suppressedReasons.size > 0
  }

  #listen(emitter, event, listener) {
    emitter.on(event, listener)
    this.listeners.push({ emitter, event, listener })
  }

  async #run(reason) {
    if (!this.started) return
    if (this.bot.isSleeping) return
    if (this.suppressedReasons.size) return
    if (this.goalManager.current?.source === GOAL_SOURCES.SURVIVAL) return

    const state = this.worldState.build()
    if (!state) return
    state.autonomyTrigger = reason
    state.recentRejectedSpeech = this.rejectedSpeech.filter(entry => Date.now() - entry.at < 180000)
      .slice(-3).map(({ message, reason }) => ({ message, reason }))
    const lastRejected = this.rejectedSpeech.at(-1)
    const deferred = lastRejected && Date.now() - lastRejected.at < REJECTED_SPEECH_BACKOFF_MS &&
      !isFreshWorldEvent(reason)
    const speechReadiness = state.companionSession?.speech
    state.autonomousSpeechAllowed = speechReadiness?.eligible !== false && !deferred
    if (!state.autonomousSpeechAllowed) {
      state.autonomousSpeechUnavailableReason = deferred ? 'RECENT_REJECTED_SPEECH' : speechReadiness?.reason
    }
    state.recentAutonomousOutcomes = this.recentGoalOutcomes.slice(-4)
    const freeToChoose = state.behavior?.locomotionOwner === 'NONE' && !state.currentGoal
    state.freeIdleStreak = freeToChoose ? this.freeIdleStreak : 0
    state.autonomousMoveCooldownMs = this.actions.movementCooldownRemainingMs?.() || 0
    state.autonomousFollowCooldownMs = this.actions.followCooldownRemainingMs?.() || 0
    state.availableTaskItems = this.actions.availableTaskItems?.(state) || []
    if (!state.autonomousSpeechAllowed && ['PLAYER', 'SURVIVAL'].includes(state.behavior?.locomotionOwner)) return
    if (state.companionSession?.speech?.eligible && state.companionSession.speech.quietSeconds >= 90 && state.player) {
      state.socialOpportunity = { kind: 'QUIET_COMPANY', quietSeconds: state.companionSession.speech.quietSeconds,
        instruction: '已经安静陪伴一会儿，可以主动聊一句贴近当前情境的小想法；不必等待受伤或玩家先问。没内容可保持安静。' }
    }
    const autonomyEpoch = this.movement.getAutonomyEpoch()

    this.logger.info(`Autonomy inference (${reason})`)
    try {
      const decision = await this.client.decide(state)
      if (!this.started || this.suppressedReasons.size || this.goalManager.current?.source === GOAL_SOURCES.SURVIVAL) {
        this.journal.record('autonomy_decision', `${decision.action}:preempted_by_survival`)
        return
      }
      const result = await this.actions.execute(decision, state, { autonomyEpoch })
      if (freeToChoose && ['IDLE', 'SAY'].includes(decision.action)) {
        this.freeIdleStreak = Math.min(this.freeIdleStreak + 1, 10)
      }
      else if (result.executed && decision.action !== 'SAY') this.freeIdleStreak = 0
      if (decision.action === 'SAY' && !result.executed &&
          !['SPEECH_COOLDOWN', 'CONVERSATION_GAP'].includes(result.reason)) {
        this.rejectedSpeech.push({ at: Date.now(), message: String(decision.message || '').slice(0, 120), reason: result.reason })
        this.rejectedSpeech = this.rejectedSpeech.slice(-3)
      }
      this.journal.record('autonomy_decision', `${decision.action}:${result.executed ? 'executed' : result.reason}`)
      const choice = decision.action === 'TRY_OBTAIN_ITEM' ? `${decision.action} ${decision.goalItem}` : decision.action
      this.logger.info(`Autonomy chose ${choice}${result.executed ? '' : ` (${result.reason})`}`)
      if (decision.action === 'IDLE') this.logger.info(`[AUTONOMY] Chose silence: ${String(decision.reason || 'no reason provided').replace(/\s+/g, ' ').slice(0, 120)}`)
    } catch (error) {
      if (isOllamaPreempted(error)) {
        this.journal.record('autonomy_deferred', 'higher_priority_ollama_request')
        return
      }
      this.logger.throttled('autonomy-error', 10000, 'error', 'Autonomy inference failed', error)
      this.journal.record('autonomy_error', error.message)
    }
  }

  #handleTime() {
    const phase = timePhase(this.bot.time?.timeOfDay)
    if (phase === this.lastTimePhase) return
    this.lastTimePhase = phase
    this.journal.record('time_phase', phase)
    if (phase === 'dusk' || phase === 'night') void this.scheduler.trigger(`time_${phase}`)
  }

  #handleGoalChange(change) {
    this.journal.record('goal', `${change.event}:${change.goal.source}:${change.goal.type}`)
    if (['started', 'resumed'].includes(change.event) &&
        [GOAL_SOURCES.PLAYER, GOAL_SOURCES.SURVIVAL].includes(change.goal.source)) this.freeIdleStreak = 0
    if (change.goal.source === GOAL_SOURCES.AUTONOMOUS &&
        ['completed', 'failed', 'abandoned'].includes(change.event) &&
        change.goal.type !== 'LEARNING_EPISODE') {
      this.recentGoalOutcomes.push({
        action: change.goal.type,
        outcome: change.event.toUpperCase(),
        reason: change.goal.result?.reason || null,
        at: Date.now()
      })
      this.recentGoalOutcomes = this.recentGoalOutcomes.slice(-4)
      this.logger.info(`[AUTONOMY] ${change.goal.type} ${change.event.toUpperCase()}${change.goal.result?.reason ? `: ${change.goal.result.reason}` : ''}`)
    }
    if (['completed', 'failed', 'abandoned'].includes(change.event)) {
      void this.scheduler.trigger('goal_finished')
    }
  }
}

module.exports = { AutonomyController, timePhase }
