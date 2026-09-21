const { goals } = require('mineflayer-pathfinder')
const { GoalFollow, GoalNear } = goals
const { GOAL_SOURCES, GOAL_STATES } = require('../goals')
const { LocomotionArbiter, LOCOMOTION_OWNERS } = require('./locomotion-arbiter')

class MovementController {
  constructor(bot, { logger, goalManager = null }) {
    this.bot = bot
    this.logger = logger
    this.goalManager = goalManager
    this.arbiter = new LocomotionArbiter({ logger })
    this.movements = null
    this.behavior = { type: 'STOP', source: null, goalId: null }
    this.overrideOwner = null
    this.playerCommandEpoch = 0
    this.goalManager?.on('changed', change => this.#handleGoalChange(change))
  }

  initialize(movements) {
    this.movements = movements
    this.bot.pathfinder.setMovements(movements)
  }

  getPlayer(username) {
    return this.bot.players[username]?.entity
  }

  follow(username, { source = GOAL_SOURCES.PLAYER, expectedAutonomyEpoch = null } = {}) {
    const player = this.getPlayer(username)
    if (!player) {
      if (source === GOAL_SOURCES.PLAYER) this.bot.chat('我没看到你，你跑哪去了？')
      return false
    }

    if (source === GOAL_SOURCES.AUTONOMOUS) {
      if (!this.#canStartAutonomous(expectedAutonomyEpoch)) return false
      const requested = this.#requestGoal('FOLLOW_PLAYER', source, { username }, true)
      if (!requested.accepted || !this.arbiter.acquire(LOCOMOTION_OWNERS.AUTONOMY, 'FOLLOW_PLAYER')) {
        if (requested.goal) this.goalManager?.complete(requested.goal.id, GOAL_STATES.ABANDONED)
        return false
      }
      this.behavior = { type: 'FOLLOW', username, source, goalId: requested.goal?.id ?? null }
      this.#applyBehavior()
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
    if (!player) {
      if (source === GOAL_SOURCES.PLAYER) this.bot.chat('我现在看不到你。')
      return false
    }

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

  completeAutonomousGoal(goalId) {
    if (this.behavior.source !== GOAL_SOURCES.AUTONOMOUS || this.behavior.goalId !== goalId) return false
    this.behavior = { type: 'STOP', source: null, goalId: null }
    this.goalManager?.complete(goalId)
    if (this.arbiter.owner === LOCOMOTION_OWNERS.AUTONOMY) {
      this.arbiter.release(LOCOMOTION_OWNERS.AUTONOMY)
      this.#stopPathing()
    }
    return true
  }

  canRunAutonomousNonMovement(expectedAutonomyEpoch) {
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
    return this.arbiter.owner === LOCOMOTION_OWNERS.NONE
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

  #canStartAutonomous(expectedEpoch) {
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
    this.behavior = { type: 'STOP', source: null, goalId: null }
    return { owner: LOCOMOTION_OWNERS.NONE, reason: null }
  }

  #applyBehavior() {
    if (!this.movements) return
    const { type, username, point } = this.behavior
    const player = username ? this.getPlayer(username) : null

    if (type === 'FOLLOW' && player) {
      this.bot.pathfinder.setGoal(new GoalFollow(player, 2), true)
    } else if (type === 'COME' && player) {
      const { x, y, z } = player.position
      this.bot.pathfinder.setGoal(new GoalNear(x, y, z, 1))
    } else if (type === 'AUTONOMOUS_COME' && player) {
      const { x, y, z } = player.position
      this.bot.pathfinder.setGoal(new GoalNear(x, y, z, 2))
    } else if (['WANDER_NEAR_PLAYER', 'EXPLORE_NEARBY', 'PRESENCE_WANDER'].includes(type) && point) {
      this.bot.pathfinder.setGoal(new GoalNear(point.x, point.y, point.z, 1))
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

    const wasAutonomous = this.behavior.source === GOAL_SOURCES.AUTONOMOUS
    this.behavior = { type: 'STOP', source: null, goalId: null }
    if (wasAutonomous && this.arbiter.owner === LOCOMOTION_OWNERS.AUTONOMY) {
      this.arbiter.release(LOCOMOTION_OWNERS.AUTONOMY)
      this.#stopPathing()
    }
  }
}

module.exports = { MovementController }
