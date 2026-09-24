const { goals } = require('mineflayer-pathfinder')
const { GoalFollow, GoalNear } = goals
const { GOAL_SOURCES, GOAL_STATES } = require('../goals')
const { LocomotionArbiter, LOCOMOTION_OWNERS } = require('./locomotion-arbiter')

class MovementController {
  constructor(bot, { logger, goalManager = null, autonomousMoveTimeoutMs = 45000,
    setIntervalFn = setInterval, clearIntervalFn = clearInterval }) {
    this.bot = bot
    this.logger = logger
    this.goalManager = goalManager
    this.autonomousMoveTimeoutMs = autonomousMoveTimeoutMs
    this.setIntervalFn = setIntervalFn
    this.clearIntervalFn = clearIntervalFn
    this.autonomousWatchdog = null
    this.arbiter = new LocomotionArbiter({ logger })
    this.movements = null
    this.behavior = { type: 'STOP', source: null, goalId: null }
    this.overrideOwner = null
    this.learningActive = false
    this.learningOwner = null
    this.learningGoalSource = null
    this.playerCommandEpoch = 0
    this.goalManager?.on('changed', change => this.#handleGoalChange(change))
  }

  initialize(movements) {
    this.movements = movements
    this.bot.pathfinder.setMovements(movements)
  }

  shutdown() {
    this.#clearAutonomousWatchdog()
  }

  getPlayer(username) {
    return this.bot.players[username]?.entity
  }

  follow(username, { source = GOAL_SOURCES.PLAYER, expectedAutonomyEpoch = null,
    maxDurationMs = null } = {}) {
    const player = this.getPlayer(username)
    if (!player) return false

    if (source === GOAL_SOURCES.AUTONOMOUS) {
      if (!this.#canStartAutonomous(expectedAutonomyEpoch)) return false
      const requested = this.#requestGoal('FOLLOW_PLAYER', source, { username }, true)
      if (!requested.accepted || !this.arbiter.acquire(LOCOMOTION_OWNERS.AUTONOMY, 'FOLLOW_PLAYER')) {
        if (requested.goal) this.goalManager?.complete(requested.goal.id, GOAL_STATES.ABANDONED)
        return false
      }
      this.behavior = { type: 'FOLLOW', username, source, goalId: requested.goal?.id ?? null }
      this.#applyBehavior()
      if (Number.isFinite(maxDurationMs) && maxDurationMs > 0) this.#watchAutonomousFollow(maxDurationMs)
      this.logger.info(`Following ${username} autonomously`)
      return true
    }

    this.#beginPlayerCommand()
    const ownsLocomotion = this.arbiter.acquire(LOCOMOTION_OWNERS.PLAYER, 'FOLLOW', { allowSame: true })
    const requested = this.#requestGoal('FOLLOW_PLAYER', source, { username }, true)
    if (!requested.accepted) return false

    this.behavior = { type: 'FOLLOW', username, source, goalId: requested.goal?.id ?? null }
    if (ownsLocomotion) this.#applyBehavior()
    this.logger.info(`Following ${username}`)
    return true
  }

  come(username, { source = GOAL_SOURCES.PLAYER, expectedAutonomyEpoch = null } = {}) {
    const player = this.getPlayer(username)
    if (!player) return false

    if (source === GOAL_SOURCES.AUTONOMOUS) {
      return this.startAutonomousMovement({
        type: 'AUTONOMOUS_COME',
        username,
        goalType: 'COME_TO_PLAYER',
        expectedAutonomyEpoch,
        resumable: true
      })
    }

    this.#beginPlayerCommand()
    const ownsLocomotion = this.arbiter.acquire(LOCOMOTION_OWNERS.PLAYER, 'COME', { allowSame: true })
    const requested = this.#requestGoal('COME_TO_PLAYER', source, { username }, false)
    if (!requested.accepted) return false

    this.behavior = { type: 'COME', username, source, goalId: requested.goal?.id ?? null }
    if (ownsLocomotion) this.#applyBehavior()
    this.logger.info(`Going to ${username}`)
    return true
  }

  stop() {
    this.#beginPlayerCommand()
    const ownsLocomotion = this.arbiter.acquire(LOCOMOTION_OWNERS.PLAYER, 'STOP', { allowSame: true })
    const requested = this.#requestGoal('WAIT', GOAL_SOURCES.PLAYER, {}, true)
    if (!requested.accepted) return false

    this.behavior = { type: 'STOP', source: GOAL_SOURCES.PLAYER, goalId: requested.goal?.id ?? null }
    if (ownsLocomotion) this.#stopPathing()
    this.logger.info('Movement stopped')
    return true
  }

  resumeAfterRest(previous, expectedPlayerEpoch) {
    if (this.playerCommandEpoch !== expectedPlayerEpoch || this.arbiter.owner !== LOCOMOTION_OWNERS.PLAYER ||
        this.behavior.type !== 'STOP' || this.behavior.source !== GOAL_SOURCES.PLAYER ||
        this.learningActive || this.learningPending) return false
    if (previous.source === GOAL_SOURCES.PLAYER && previous.type !== 'FOLLOW') return true
    if (previous.type === 'FOLLOW' && !this.getPlayer(previous.username)) return false
    if (previous.type === 'FOLLOW' && previous.source === GOAL_SOURCES.PLAYER) return this.follow(previous.username)

    // Release only the temporary STOP created by this rest episode. Never release
    // a newer player STOP, and never bypass a survival/learning owner.
    const goalId = this.behavior.goalId
    this.behavior = { type: 'STOP', source: null, goalId: null }
    if (goalId) this.goalManager?.complete(goalId)
    this.arbiter.invalidateAutonomy()
    this.arbiter.release(LOCOMOTION_OWNERS.PLAYER)
    if (previous.type === 'FOLLOW' && previous.source === GOAL_SOURCES.AUTONOMOUS) {
      return this.follow(previous.username, { source: GOAL_SOURCES.AUTONOMOUS, expectedAutonomyEpoch: this.getAutonomyEpoch() })
    }
    return true
  }

  startAutonomousMovement({
    type,
    username,
    point,
    goalType = type,
    expectedAutonomyEpoch,
    resumable = true
  }) {
    if (!this.#canStartAutonomous(expectedAutonomyEpoch)) return false

    const requested = this.#requestGoal(
      goalType,
      GOAL_SOURCES.AUTONOMOUS,
      { username, point: point ? { x: point.x, y: point.y, z: point.z } : null },
      resumable
    )
    if (!requested.accepted || !this.arbiter.acquire(LOCOMOTION_OWNERS.AUTONOMY, goalType)) {
      if (requested.goal) this.goalManager?.complete(requested.goal.id, GOAL_STATES.ABANDONED)
      return false
    }

    this.behavior = {
      type,
      username,
      point,
      source: GOAL_SOURCES.AUTONOMOUS,
      goalId: requested.goal?.id ?? null
    }
    this.#applyBehavior()
    this.#watchAutonomousMovement()
    return true
  }

  startAutonomousWait({ durationMs, expectedAutonomyEpoch }) {
    if (!this.#canStartAutonomous(expectedAutonomyEpoch)) return null
    const requested = this.#requestGoal('WAIT', GOAL_SOURCES.AUTONOMOUS, { durationMs }, false)
    if (!requested.accepted || !this.arbiter.acquire(LOCOMOTION_OWNERS.AUTONOMY, 'WAIT')) {
      if (requested.goal) this.goalManager?.complete(requested.goal.id, GOAL_STATES.ABANDONED)
      return null
    }
    this.behavior = { type: 'AUTONOMOUS_WAIT', source: GOAL_SOURCES.AUTONOMOUS, goalId: requested.goal?.id ?? null }
    return requested.goal
  }

  completeAutonomousGoal(goalId, reason = 'GOAL_REACHED') {
    if (this.behavior.source !== GOAL_SOURCES.AUTONOMOUS || this.behavior.goalId !== goalId) return false
    this.#clearAutonomousWatchdog()
    this.behavior = { type: 'STOP', source: null, goalId: null }
    this.goalManager?.complete(goalId, GOAL_STATES.COMPLETED, { reason })
    if (this.arbiter.owner === LOCOMOTION_OWNERS.AUTONOMY) {
      this.arbiter.release(LOCOMOTION_OWNERS.AUTONOMY)
      this.#stopPathing()
    }
    return true
  }

  canRunAutonomousNonMovement(expectedAutonomyEpoch) {
    if (this.learningActive) return false
    if (expectedAutonomyEpoch !== null && !this.arbiter.isAutonomyEpoch(expectedAutonomyEpoch)) return false
    return this.arbiter.owner === LOCOMOTION_OWNERS.NONE
  }

  isAutonomousMovementActive() {
    return this.arbiter.owner === LOCOMOTION_OWNERS.AUTONOMY
  }

  getAutonomyEpoch() {
    return this.arbiter.getAutonomyEpoch()
  }

  isAutonomyEpoch(epoch) {
    return this.arbiter.isAutonomyEpoch(epoch)
  }

  invalidateAutonomy() {
    return this.arbiter.invalidateAutonomy()
  }

  getPlayerCommandEpoch() {
    return this.playerCommandEpoch
  }

  getLocomotionOwner() {
    return this.arbiter.owner
  }

  canRunPresence() {
    return !this.learningPending && !this.learningActive && this.goalManager?.current?.source !== GOAL_SOURCES.PLAYER_TASK && this.arbiter.owner === LOCOMOTION_OWNERS.NONE
  }

  setLearningPending(pending) {
    this.learningPending = pending
    if (pending) this.cancelPresenceWalk()
  }

  beginLearningSession(source = GOAL_SOURCES.AUTONOMOUS) {
    if (this.learningActive) return true
    if ([LOCOMOTION_OWNERS.PLAYER, LOCOMOTION_OWNERS.SURVIVAL].includes(this.arbiter.owner)) return false
    this.arbiter.invalidateAutonomy()
    if (this.arbiter.owner === LOCOMOTION_OWNERS.PRESENCE) this.cancelPresenceWalk()
    if (this.arbiter.owner === LOCOMOTION_OWNERS.AUTONOMY) {
      const goalId = this.behavior.goalId
      this.behavior = { type: 'STOP', source: null, goalId: null }
      this.arbiter.release(LOCOMOTION_OWNERS.AUTONOMY)
      this.#stopPathing()
      if (goalId) this.goalManager?.complete(goalId, GOAL_STATES.ABANDONED)
    }
    this.learningActive = true
    this.learningGoalSource = source
    this.learningOwner = source === GOAL_SOURCES.PLAYER_TASK
      ? LOCOMOTION_OWNERS.PLAYER_TASK
      : LOCOMOTION_OWNERS.AUTONOMY
    return true
  }

  startLearningMovement(point, distance = 1) {
    if (!this.learningActive || !point) return false
    if (![LOCOMOTION_OWNERS.NONE, this.learningOwner].includes(this.arbiter.owner)) return false
    if (!this.arbiter.acquire(this.learningOwner, 'LEARNING', { allowSame: true })) return false
    this.behavior = {
      type: 'LEARNING_MOVE_NEAR',
      point,
      distance,
      source: this.learningGoalSource,
      goalId: this.goalManager?.current?.type === 'LEARNING_EPISODE' ? this.goalManager.current.id : null
    }
    this.bot.pathfinder.setGoal(new GoalNear(point.x, point.y, point.z, distance))
    return true
  }

  finishLearningMovement() {
    if (!this.learningActive || this.behavior.type !== 'LEARNING_MOVE_NEAR') return false
    if (this.arbiter.owner !== this.learningOwner) return false
    this.behavior = { type: 'STOP', source: null, goalId: null }
    this.arbiter.release(this.learningOwner)
    this.#stopPathing()
    return true
  }

  stopLearningMotion() {
    if (!this.learningActive) return false
    if (this.behavior.type === 'LEARNING_MOVE_NEAR') return this.finishLearningMovement()
    return true
  }

  endLearningSession() {
    if (!this.learningActive) return false
    const learningOwner = this.learningOwner
    this.learningActive = false
    this.learningOwner = null
    this.learningGoalSource = null
    if (this.behavior.type === 'LEARNING_MOVE_NEAR') {
      this.behavior = { type: 'STOP', source: null, goalId: null }
      if (this.arbiter.owner === learningOwner) {
        this.arbiter.release(learningOwner)
        this.#stopPathing()
      }
    }
    this.arbiter.invalidateAutonomy()
    return true
  }

  isLearningActive() {
    return this.learningActive
  }

  isLearningLocomotionOwner() {
    return this.learningActive && this.arbiter.owner === this.learningOwner
  }

  startPresenceWalk(point) {
    if (!this.canRunPresence()) return false
    if (!this.arbiter.acquire(LOCOMOTION_OWNERS.PRESENCE, 'WANDER')) return false
    this.behavior = { type: 'PRESENCE_WANDER', point, source: 'PRESENCE', goalId: null }
    this.bot.pathfinder.setGoal(new GoalNear(point.x, point.y, point.z, 1))
    return true
  }

  cancelPresenceWalk() {
    if (this.arbiter.owner !== LOCOMOTION_OWNERS.PRESENCE) return false
    this.behavior = { type: 'STOP', source: null, goalId: null }
    this.arbiter.release(LOCOMOTION_OWNERS.PRESENCE)
    this.#stopPathing()
    return true
  }

  getBehaviorSummary() {
    const { type, username, source } = this.behavior
    return {
      type,
      username: username || null,
      source: source || null,
      locomotionOwner: this.arbiter.owner
    }
  }

  beginOverride(owner) {
    if (this.overrideOwner && this.overrideOwner !== owner) return false
    if (!this.arbiter.acquire(LOCOMOTION_OWNERS.SURVIVAL, null, { allowSame: true })) return false
    this.overrideOwner = owner
    return true
  }

  setOverrideGoal(owner, goal, dynamic = false) {
    if (this.overrideOwner !== owner || this.arbiter.owner !== LOCOMOTION_OWNERS.SURVIVAL) return false
    this.bot.pathfinder.setGoal(goal, dynamic)
    return true
  }

  endOverride(owner) {
    if (this.overrideOwner !== owner || this.arbiter.owner !== LOCOMOTION_OWNERS.SURVIVAL) return false
    this.overrideOwner = null
    this.bot.clearControlStates()

    const next = this.#resumableOwner()
    this.arbiter.release(LOCOMOTION_OWNERS.SURVIVAL, next.owner, next.reason)
    if (next.owner === LOCOMOTION_OWNERS.NONE) this.#stopPathing()
    else this.#applyBehavior()
    return true
  }

  handleGoalReached() {
    if (this.arbiter.owner === LOCOMOTION_OWNERS.PRESENCE) {
      this.cancelPresenceWalk()
      return
    }
    if (this.overrideOwner) return

    if (this.arbiter.owner === LOCOMOTION_OWNERS.AUTONOMY && [
      'WANDER_NEAR_PLAYER',
      'EXPLORE_NEARBY',
      'AUTONOMOUS_COME'
    ].includes(this.behavior.type)) {
      this.completeAutonomousGoal(this.behavior.goalId)
      return
    }

    if (this.arbiter.owner === LOCOMOTION_OWNERS.PLAYER && this.behavior.type === 'COME') {
      const completed = this.behavior
      this.behavior = { type: 'STOP', source: null, goalId: null }
      if (completed.goalId) this.goalManager?.complete(completed.goalId)
      this.arbiter.release(LOCOMOTION_OWNERS.PLAYER)
      this.logger.info('Reached player')
    }
  }

  handlePathUpdate(result) {
    if (result?.status !== 'noPath' || this.arbiter.owner !== LOCOMOTION_OWNERS.AUTONOMY ||
        !this.#isFiniteAutonomousMove()) return false
    return this.#failAutonomousMovement('NO_PATH')
  }

  #isFiniteAutonomousMove() {
    return this.behavior.source === GOAL_SOURCES.AUTONOMOUS &&
      ['WANDER_NEAR_PLAYER', 'EXPLORE_NEARBY', 'AUTONOMOUS_COME'].includes(this.behavior.type)
  }

  #watchAutonomousMovement() {
    this.#clearAutonomousWatchdog()
    if (!this.#isFiniteAutonomousMove()) return
    const goalId = this.behavior.goalId
    let activeMs = 0
    let stalledMs = 0
    let previous = this.bot.entity?.position?.clone?.() || this.bot.entity?.position || null
    this.autonomousWatchdog = this.setIntervalFn(() => {
      if (!this.#isFiniteAutonomousMove() || this.behavior.goalId !== goalId) {
        this.#clearAutonomousWatchdog()
        return
      }
      if (this.arbiter.owner !== LOCOMOTION_OWNERS.AUTONOMY) return
      activeMs += 2000
      const current = this.bot.entity?.position
      if (current && previous && current.distanceTo?.(previous) >= 0.5) stalledMs = 0
      else stalledMs += 2000
      previous = current?.clone?.() || current || null
      if (activeMs >= this.autonomousMoveTimeoutMs || stalledMs >= Math.min(16000, this.autonomousMoveTimeoutMs)) {
        this.#failAutonomousMovement(activeMs >= this.autonomousMoveTimeoutMs ? 'MOVE_TIMEOUT' : 'STALLED')
      }
    }, 2000)
    this.autonomousWatchdog?.unref?.()
  }

  #watchAutonomousFollow(maxDurationMs) {
    this.#clearAutonomousWatchdog()
    const goalId = this.behavior.goalId
    let activeMs = 0
    this.autonomousWatchdog = this.setIntervalFn(() => {
      if (this.behavior.source !== GOAL_SOURCES.AUTONOMOUS ||
          this.behavior.type !== 'FOLLOW' || this.behavior.goalId !== goalId) {
        this.#clearAutonomousWatchdog()
        return
      }
      if (this.arbiter.owner !== LOCOMOTION_OWNERS.AUTONOMY) return
      activeMs += 2000
      if (activeMs >= maxDurationMs) this.completeAutonomousGoal(goalId, 'FOLLOW_INTERVAL_ENDED')
    }, 2000)
    this.autonomousWatchdog?.unref?.()
  }

  #clearAutonomousWatchdog() {
    if (this.autonomousWatchdog !== null) this.clearIntervalFn(this.autonomousWatchdog)
    this.autonomousWatchdog = null
  }

  #failAutonomousMovement(reason) {
    if (!this.#isFiniteAutonomousMove()) return false
    const goalId = this.behavior.goalId
    const type = this.behavior.type
    this.#clearAutonomousWatchdog()
    this.behavior = { type: 'STOP', source: null, goalId: null }
    if (goalId) this.goalManager?.complete(goalId, GOAL_STATES.FAILED, { reason })
    this.arbiter.release(LOCOMOTION_OWNERS.AUTONOMY)
    this.#stopPathing()
    this.logger.info(`[AUTONOMY] ${type} failed: ${reason}`)
    return true
  }

  #canStartAutonomous(expectedEpoch) {
    if (this.learningActive) return false
    if (expectedEpoch !== null && !this.arbiter.isAutonomyEpoch(expectedEpoch)) return false
    return this.arbiter.owner === LOCOMOTION_OWNERS.NONE
  }

  #beginPlayerCommand() {
    this.playerCommandEpoch += 1
    this.arbiter.invalidateAutonomy()
  }

  #resumableOwner() {
    if (this.behavior.source === GOAL_SOURCES.PLAYER) {
      return { owner: LOCOMOTION_OWNERS.PLAYER, reason: `resume ${this.behavior.type}` }
    }
    if (
      this.behavior.source === GOAL_SOURCES.AUTONOMOUS &&
      this.goalManager?.current?.id === this.behavior.goalId
    ) {
      return { owner: LOCOMOTION_OWNERS.AUTONOMY, reason: `resume ${this.behavior.type}` }
    }
    if (
      this.behavior.source === GOAL_SOURCES.PLAYER_TASK &&
      this.goalManager?.current?.id === this.behavior.goalId
    ) {
      return { owner: LOCOMOTION_OWNERS.PLAYER_TASK, reason: `resume ${this.behavior.type}` }
    }
    this.behavior = { type: 'STOP', source: null, goalId: null }
    return { owner: LOCOMOTION_OWNERS.NONE, reason: null }
  }

  #applyBehavior() {
    if (!this.movements) return
    const { type, username, point, distance = 1 } = this.behavior
    const player = username ? this.getPlayer(username) : null

    if (type === 'FOLLOW' && player) {
      this.bot.pathfinder.setGoal(new GoalFollow(player, 2), true)
    } else if (type === 'COME' && player) {
      const { x, y, z } = player.position
      this.bot.pathfinder.setGoal(new GoalNear(x, y, z, 1))
    } else if (type === 'AUTONOMOUS_COME' && player) {
      const { x, y, z } = player.position
      this.bot.pathfinder.setGoal(new GoalNear(x, y, z, 2))
    } else if (['WANDER_NEAR_PLAYER', 'EXPLORE_NEARBY', 'PRESENCE_WANDER', 'LEARNING_MOVE_NEAR'].includes(type) && point) {
      this.bot.pathfinder.setGoal(new GoalNear(point.x, point.y, point.z, type === 'LEARNING_MOVE_NEAR' ? distance : 1))
    } else if (type === 'AUTONOMOUS_WAIT' || type === 'STOP') {
      this.#stopPathing()
    }
  }

  #stopPathing() {
    this.bot.pathfinder.setGoal(null)
    this.bot.clearControlStates()
  }

  #requestGoal(type, source, payload, resumable) {
    if (!this.goalManager) return { accepted: true, goal: null }
    return this.goalManager.request({ type, source, payload, resumable })
  }

  #handleGoalChange(change) {
    if (!['completed', 'abandoned', 'failed'].includes(change.event)) return
    if (!this.behavior.goalId || this.behavior.goalId !== change.goal.id) return
    if (this.overrideOwner && change.event === 'completed') return

    this.#clearAutonomousWatchdog()

    const movementOwner = this.behavior.source === GOAL_SOURCES.PLAYER_TASK
      ? LOCOMOTION_OWNERS.PLAYER_TASK
      : LOCOMOTION_OWNERS.AUTONOMY
    const wasLearningOrAutonomous = [GOAL_SOURCES.AUTONOMOUS, GOAL_SOURCES.PLAYER_TASK].includes(this.behavior.source)
    this.behavior = { type: 'STOP', source: null, goalId: null }
    if (wasLearningOrAutonomous && this.arbiter.owner === movementOwner) {
      this.arbiter.release(movementOwner)
      this.#stopPathing()
    }
  }
}

module.exports = { MovementController }
