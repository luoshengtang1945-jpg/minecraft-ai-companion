const { GOAL_SOURCES } = require('../goals')
const { AutonomyScheduler } = require('./scheduler')

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
    this.scheduler = new AutonomyScheduler({
      intervalMs: config.intervalMs,
      eventMinGapMs: config.eventMinGapMs,
      onRun: reason => this.#run(reason)
    })
  }

  start() {
    if (this.started || !this.config.enabled) return false
    this.started = true
    this.#listen(this.bot, 'entityHurt', entity => {
      const detail = entity.id === this.bot.entity?.id ? 'companion_hurt' : `${entity.name || entity.username || 'entity'}_hurt`
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
  }

  trigger(reason) {
    return this.scheduler.trigger(reason)
  }

  #listen(emitter, event, listener) {
    emitter.on(event, listener)
    this.listeners.push({ emitter, event, listener })
  }

  async #run(reason) {
    if (!this.started) return
    if (this.goalManager.current?.source === GOAL_SOURCES.SURVIVAL) return

    const state = this.worldState.build()
    if (!state) return
    const autonomyEpoch = this.movement.getAutonomyEpoch()

    this.logger.info(`Autonomy inference (${reason})`)
    try {
      const decision = await this.client.decide(state)
      if (!this.started || this.goalManager.current?.source === GOAL_SOURCES.SURVIVAL) {
        this.journal.record('autonomy_decision', `${decision.action}:preempted_by_survival`)
        return
      }
      const result = await this.actions.execute(decision, state, { autonomyEpoch })
      this.journal.record('autonomy_decision', `${decision.action}:${result.executed ? 'executed' : result.reason}`)
      this.logger.info(`Autonomy chose ${decision.action}${result.executed ? '' : ` (${result.reason})`}`)
    } catch (error) {
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
    if (['completed', 'failed', 'abandoned'].includes(change.event)) {
      void this.scheduler.trigger('goal_finished')
    }
  }
}

module.exports = { AutonomyController, timePhase }
