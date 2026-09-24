const { GOAL_SOURCES } = require('../goals')
const { findSafePositionNear } = require('./safe-position')
const { availableTaskItems } = require('./task-candidates')
const { createItemGoal } = require('../learning/item-goal')

const LOCOMOTION_ACTIONS = new Set([
  'FOLLOW_PLAYER',
  'WANDER_NEAR_PLAYER',
  'COME_TO_PLAYER',
  'EXPLORE_NEARBY',
  'WAIT'
])

class AutonomousActionRegistry {
  constructor({
    bot,
    movement,
    goalManager,
    speech,
    journal,
    logger,
    config,
    random = Math.random,
    now = Date.now,
    setTimeoutFn = setTimeout
  }) {
    this.bot = bot
    this.movement = movement
    this.goalManager = goalManager
    this.speech = speech
    this.journal = journal
    this.logger = logger
    this.config = config
    this.random = random
    this.now = now
    this.setTimeoutFn = setTimeoutFn
    this.handlers = new Map()
    this.learning = null
    this.autonomousTasksStarted = 0
    this.#registerDefaults()
  }

  setLearningController(learning) {
    this.learning = learning
  }

  availableTaskItems(state) {
    if (!this.config.taskLearningEnabled || !this.learning ||
        this.autonomousTasksStarted >= (this.config.taskMaxEpisodes ?? 1) ||
        !state.player || !Number.isFinite(state.player.distance) ||
        state.player.distance > this.config.maxPlayerDistance ||
        !Number.isFinite(state.companion?.health) ||
        state.companion.health < (this.config.taskMinHealth ?? 12) ||
        (state.freeIdleStreak || 0) < 2 ||
        (state.nearbyEntities?.hostile || []).length > 0 ||
        state.autonomyTrigger === 'hurt' ||
        (state.recentEvents || []).some(event => event.type === 'hurt' &&
          Number.isFinite(event.at) && this.now() - event.at < 15000) ||
        state.currentGoal || state.behavior?.locomotionOwner !== 'NONE') return []
    return availableTaskItems(state, this.bot)
  }

  register(name, handler) {
    this.handlers.set(name, handler)
  }

  movementCooldownRemainingMs() {
    const last = [...(this.goalManager?.history || [])].reverse().find(goal =>
      goal.source === GOAL_SOURCES.AUTONOMOUS && goal.status === 'COMPLETED' &&
      ['WANDER_NEAR_PLAYER', 'EXPLORE_NEARBY'].includes(goal.type)
    )
    if (!last) return 0
    return Math.max(0, (this.config.moveCooldownMs ?? 90000) - (this.now() - last.finishedAt))
  }

  followCooldownRemainingMs() {
    const last = [...(this.goalManager?.history || [])].reverse().find(goal =>
      goal.source === GOAL_SOURCES.AUTONOMOUS && goal.type === 'FOLLOW_PLAYER' &&
      goal.result?.reason === 'FOLLOW_INTERVAL_ENDED'
    )
    if (!last) return 0
    return Math.max(0, (this.config.followCooldownMs ?? 180000) - (this.now() - last.finishedAt))
  }

  async execute(decision, worldState, { autonomyEpoch = null } = {}) {
    const handler = this.handlers.get(decision.action)
    if (!handler) return { executed: false, reason: 'UNREGISTERED_ACTION' }

    if (decision.action !== 'SAY' && this.movement.isAutonomousMovementActive()) {
      return { executed: false, reason: 'AUTONOMOUS_GOAL_IN_PROGRESS' }
    }
    if (
      decision.action !== 'SAY' &&
      decision.action !== 'IDLE' &&
      !this.movement.canRunAutonomousNonMovement(autonomyEpoch)
    ) {
      return { executed: false, reason: 'LOCOMOTION_OWNED' }
    }

    return handler(decision, worldState, autonomyEpoch)
  }

  #registerDefaults() {
    this.register('IDLE', () => ({ executed: false, reason: 'IDLE' }))
    this.register('WAIT', (decision, state, epoch) => this.#wait(decision.durationMs, epoch))
    this.register('SAY', (decision, state) => {
      const executed = this.speech.say(decision.message, decision.reason || decision.message, state)
      return { executed, reason: executed ? null : this.speech.lastResult?.reason || 'SPEECH_COOLDOWN_OR_DEDUP' }
    })
    this.register('LOOK_AT_PLAYER', (decision, state, epoch) => this.#lookAtPlayer(state, epoch))
    this.register('FOLLOW_PLAYER', (decision, state, epoch) => this.#followPlayer(state, epoch))
    this.register('COME_TO_PLAYER', (decision, state, epoch) => this.#comeToPlayer(state, epoch))
    this.register('WANDER_NEAR_PLAYER', (decision, state, epoch) => this.#moveNearPlayer('WANDER_NEAR_PLAYER', state, epoch))
    this.register('EXPLORE_NEARBY', (decision, state, epoch) => this.#moveNearPlayer('EXPLORE_NEARBY', state, epoch))
    this.register('TRY_OBTAIN_ITEM', (decision, state) => this.#tryObtainItem(decision, state))
  }

  #tryObtainItem(decision, state) {
    if (!this.availableTaskItems(state).includes(decision.goalItem)) {
      return { executed: false, reason: 'TASK_GOAL_NOT_AVAILABLE' }
    }
    if (Number.isFinite(this.bot.health) && this.bot.health < (this.config.taskMinHealth ?? 12)) {
      return { executed: false, reason: 'TASK_HEALTH_CHANGED' }
    }
    const position = this.bot.entity?.position
    const player = state.player?.username && this.bot.players?.[state.player.username]?.entity
    if (position && !player?.position) return { executed: false, reason: 'TASK_PLAYER_LOST' }
    if (position && player.position && position.distanceTo(player.position) > this.config.maxPlayerDistance) {
      return { executed: false, reason: 'TASK_PLAYER_MOVED_AWAY' }
    }
    if (position && Object.values(this.bot.entities || {}).some(entity =>
      entity.type === 'hostile' && entity.position &&
      position.distanceTo(entity.position) <= (this.config.summaryRange ?? 12))) {
      return { executed: false, reason: 'TASK_DANGER_APPEARED' }
    }
    const goal = createItemGoal(decision.goalItem)
    if (!this.learning.queueAutonomousTask(goal)) return { executed: false, reason: 'TASK_PREEMPTED' }
    this.autonomousTasksStarted += 1
    return { executed: true, goal }
  }

  async #lookAtPlayer(state, expectedAutonomyEpoch) {
    const player = this.#playerFromState(state)
    if (!player) return { executed: false, reason: 'NO_PLAYER' }
    if (!this.movement.canRunAutonomousNonMovement(expectedAutonomyEpoch)) {
      return { executed: false, reason: 'LOCOMOTION_OWNED' }
    }

    const requested = this.goalManager.request({
      type: 'LOOK_AT_PLAYER',
      source: GOAL_SOURCES.AUTONOMOUS,
      resumable: false
    })
    if (!requested.accepted) return { executed: false, reason: 'PREEMPTED' }

    try {
      await this.bot.lookAt(player.position.offset(0, Math.max((player.height || 1.8) * 0.8, 1), 0), true)
      this.goalManager.complete(requested.goal.id)
      return { executed: true, goal: requested.goal }
    } catch (error) {
      this.goalManager.complete(requested.goal.id, 'FAILED')
      throw error
    }
  }

  #followPlayer(state, expectedAutonomyEpoch) {
    const username = state.player?.username
    if (!username) return { executed: false, reason: 'NO_PLAYER' }
    if (this.followCooldownRemainingMs() > 0) return { executed: false, reason: 'RECENT_AUTONOMOUS_FOLLOW' }
    const executed = this.movement.follow(username, {
      source: GOAL_SOURCES.AUTONOMOUS,
      expectedAutonomyEpoch,
      maxDurationMs: this.config.followDurationMs ?? 120000
    })
    return { executed, reason: executed ? null : 'PREEMPTED' }
  }

  #comeToPlayer(state, expectedAutonomyEpoch) {
    const username = state.player?.username
    if (!username) return { executed: false, reason: 'NO_PLAYER' }
    const executed = this.movement.come(username, {
      source: GOAL_SOURCES.AUTONOMOUS,
      expectedAutonomyEpoch
    })
    return { executed, reason: executed ? null : 'PREEMPTED' }
  }

  #moveNearPlayer(type, state, expectedAutonomyEpoch) {
    const player = this.#playerFromState(state)
    if (!player) return { executed: false, reason: 'NO_PLAYER' }
    if (state.player.distance > this.config.maxPlayerDistance) {
      return this.#comeToPlayer(state, expectedAutonomyEpoch)
    }
    if (this.movementCooldownRemainingMs() > 0) {
      return { executed: false, reason: 'RECENT_AUTONOMOUS_MOVE' }
    }

    const explore = type === 'EXPLORE_NEARBY'
    const maxRadius = Math.min(
      explore ? this.config.exploreRadius : this.config.wanderRadius,
      this.config.maxPlayerDistance
    )
    const minRadius = explore ? Math.min(this.config.wanderRadius, Math.max(2, maxRadius - 1)) : 2
    const point = findSafePositionNear(this.bot, player.position, {
      minRadius,
      maxRadius,
      random: this.random
    })
    if (!point) return { executed: false, reason: 'NO_SAFE_POSITION' }

    const executed = this.movement.startAutonomousMovement({
      type,
      username: state.player.username,
      point,
      expectedAutonomyEpoch,
      resumable: true
    })
    return { executed, reason: executed ? null : 'PREEMPTED' }
  }

  #wait(durationMs, expectedAutonomyEpoch) {
    const goal = this.movement.startAutonomousWait({ durationMs, expectedAutonomyEpoch })
    if (!goal) return { executed: false, reason: 'PREEMPTED' }

    this.setTimeoutFn(() => this.movement.completeAutonomousGoal(goal.id, 'WAIT_ELAPSED'), durationMs)
    return { executed: true, goal }
  }

  #playerFromState(state) {
    return state.player?.username ? this.bot.players[state.player.username]?.entity : null
  }
}

module.exports = { AutonomousActionRegistry, LOCOMOTION_ACTIONS }
