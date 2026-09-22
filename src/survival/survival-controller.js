const { goals } = require('mineflayer-pathfinder')
const { GoalNear } = goals
const { OVERRIDE_OWNER } = require('../combat/combat-controller')
const { COMBAT_MODES, isCombatMode } = require('../combat/modes')
const { GOAL_SOURCES } = require('../goals')
const {
  selectThreat,
  selectCombatTarget,
  selectOrderedTarget,
  retreatPoint
} = require('./threats')

class SurvivalController {
  constructor(bot, { combat, movement, logger, config, goalManager = null, journal = null, now = Date.now }) {
    this.bot = bot
    this.combat = combat
    this.movement = movement
    this.logger = logger
    this.config = config
    this.now = now
    this.pursuit = null
    this.noPursuit = false
    this.combatGeneration = 0
    this.pursuitBlockedUntil = 0
    this.companionPlayer = null
    this.goalManager = goalManager
    this.journal = journal
    this.timer = null
    this.tickRunning = false
    this.combatMode = config.initialCombatMode || COMBAT_MODES.DEFENSIVE
    if (!isCombatMode(this.combatMode)) throw new Error(`Invalid combat mode: ${this.combatMode}`)
    this.reflexState = 'IDLE'
    this.targetId = null
    this.lastRetreatGoalAt = 0
    this.defendUntil = new Map()
    this.selfDefendUntil = 0
    this.orderedTargetId = null
    this.orderUntil = 0
    this.survivalGoalId = null
    this.onEntityHurt = this.#onEntityHurt.bind(this)
  }

  start() {
    if (this.timer) return
    this.bot.on('entityHurt', this.onEntityHurt)
    this.timer = setInterval(() => this.#scheduleTick(), this.config.tickMs)
    this.logger.info(`Survival reflexes enabled; combat mode is ${this.combatMode}`)
  }

  stop() {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
    this.bot.removeListener('entityHurt', this.onEntityHurt)
    this.#clearThreat()
  }

  observePlayer(username) {
    if (this.bot.players[username]?.entity) this.companionPlayer = username
    return Boolean(this.bot.players[username]?.entity)
  }

  cancelPursuit() {
    this.noPursuit = true
    this.combatGeneration += 1
    this.orderedTargetId = null
    this.orderUntil = 0
    this.selfDefendUntil = 0
    this.defendUntil.clear()
    this.pursuit = null
    this.combat.disengage()
    // A movement command cancels chasing, not an actual escape emergency.
    if (this.reflexState === 'COMBAT') this.#clearThreat()
    this.logger.info('[COMBAT] Player movement command: pursuit cancelled; contact defense only')
  }

  getCombatMode() {
    return this.combatMode
  }

  setCombatMode(mode) {
    if (!isCombatMode(mode)) throw new Error(`Invalid combat mode: ${mode}`)
    this.noPursuit = false
    this.pursuitBlockedUntil = 0
    this.combatGeneration += 1
    if (this.combatMode === mode) return false

    this.combatMode = mode
    if (mode === COMBAT_MODES.PASSIVE) {
      this.orderedTargetId = null
      this.orderUntil = 0
    }
    this.#clearThreat()
    this.logger.info(`Combat mode changed to ${mode}`)
    return true
  }

  requestAttack(username) {
    if (this.combatMode === COMBAT_MODES.PASSIVE) {
      return { accepted: false, reason: 'PASSIVE' }
    }

    const origin = this.bot.players[username]?.entity?.position || this.bot.entity?.position
    if (!origin || !this.bot.entity) return { accepted: false, reason: 'NO_TARGET' }

    const target = selectOrderedTarget({
      entities: Object.values(this.bot.entities),
      origin,
      botPosition: this.bot.entity.position,
      maxRange: this.config.detectionRange * 1.5
    })
    if (!target) return { accepted: false, reason: 'NO_TARGET' }

    this.orderedTargetId = target.id
    this.orderUntil = this.now() + this.config.attackOrderMs
    this.noPursuit = false
    this.pursuitBlockedUntil = 0
    this.combatGeneration += 1
    this.logger.info(`Explicit attack order accepted for ${target.name}`)
    return { accepted: true, target }
  }

  #scheduleTick() {
    void this.tickOnce().catch(error => this.logger.throttled('survival-error', 3000, 'error', 'Survival tick failed', error))
  }

  async tickOnce() {
    if (this.tickRunning) return
    this.tickRunning = true
    try { await this.#tick() } finally { this.tickRunning = false }
  }

  async #tick() {
    if (!this.bot.entity) return

    const now = this.now()
    if (this.orderUntil <= now) this.orderedTargetId = null

    const entities = Object.values(this.bot.entities)
    const defendedPlayers = this.#activeDefendedPlayers(now)
    const nearbyThreat = selectThreat({
      entities,
      botPosition: this.bot.entity.position,
      detectionRange: this.config.detectionRange,
      defendedPlayers,
      defenseRange: this.config.defenseRange
    })
    const closeCreeper = selectThreat({
      entities: entities.filter(entity => entity.name === 'creeper'),
      botPosition: this.bot.entity.position,
      detectionRange: this.config.creeperDistance,
      defendedPlayers: [],
      defenseRange: this.config.defenseRange
    })
    const combatTarget = selectCombatTarget({
      mode: this.combatMode,
      entities,
      botPosition: this.bot.entity.position,
      detectionRange: this.config.detectionRange,
      immediateDangerRange: this.config.immediateDangerRange,
      defendedPlayers,
      defenseRange: this.config.defenseRange,
      selfDefenseActive: this.selfDefendUntil > now,
      orderedTargetId: this.orderedTargetId
    })

    if (!nearbyThreat && !combatTarget) {
      this.#clearThreat()
      return
    }

    const escapeThreat = nearbyThreat || combatTarget
    const lowHealth = this.reflexState === 'LOW_HEALTH'
      ? this.bot.health < this.config.safeHealth
      : this.bot.health <= this.config.lowHealth

    if (lowHealth && escapeThreat) {
      this.#beginSurvivalGoal('RETREAT_LOW_HEALTH', escapeThreat)
      this.movement.beginOverride(OVERRIDE_OWNER)
      this.#retreat(escapeThreat, 'LOW_HEALTH')
      return
    }

    if (closeCreeper) {
      this.#beginSurvivalGoal('AVOID_CREEPER', closeCreeper)
      this.movement.beginOverride(OVERRIDE_OWNER)
      this.#retreat(closeCreeper, 'CREEPER_RETREAT')
      return
    }

    if (this.combatMode === COMBAT_MODES.PASSIVE && nearbyThreat) {
      this.#beginSurvivalGoal('PASSIVE_AVOID', nearbyThreat)
      this.movement.beginOverride(OVERRIDE_OWNER)
      this.#retreat(nearbyThreat, 'PASSIVE_AVOID')
      return
    }

    if (!combatTarget) {
      this.#clearThreat()
      return
    }

    if (this.noPursuit || now < this.pursuitBlockedUntil) {
      this.#clearThreat()
      const generation = this.combatGeneration
      // Do not borrow SURVIVAL locomotion merely to hit an enemy in reach.
      const inReach = () => generation === this.combatGeneration &&
        this.bot.entities[combatTarget.id] &&
        this.bot.entity.position.distanceTo(combatTarget.position) <= (this.combat.config?.meleeRange ?? 3.1)
      if (inReach()) await this.combat.engage(combatTarget, inReach, { pursue: false })
      return
    }

    if (!this.pursuit) this.pursuit = { startedAt: now, origin: { ...this.bot.entity.position } }
    if (this.#pursuitExceeded(combatTarget, now)) {
      this.pursuitBlockedUntil = now + (this.config.pursuitCooldownMs ?? 10000)
      this.orderedTargetId = null
      this.orderUntil = 0
      this.logger.info('[COMBAT] Pursuit limit reached; returning to previous behavior')
      this.#clearThreat()
      return
    }

    this.movement.beginOverride(OVERRIDE_OWNER)
    this.#beginSurvivalGoal('DEFEND', combatTarget)
    this.#setReflexState('COMBAT', combatTarget)
    const generation = this.combatGeneration
    await this.combat.engage(combatTarget, () => generation === this.combatGeneration && this.#isAttackAuthorized(combatTarget))
  }

  #pursuitExceeded(target, now) {
    const origin = this.pursuit?.origin
    if (!origin) return false
    const position = this.bot.entity.position
    const limit = this.config.maxPursuitDistance ?? 6
    const fromOrigin = point => Math.hypot(point.x - origin.x, point.y - origin.y, point.z - origin.z)
    const username = this.movement.getBehaviorSummary?.().username || this.companionPlayer
    const player = this.bot.players[username]?.entity
    return now - this.pursuit.startedAt >= (this.config.maxPursuitMs ?? 8000) ||
      fromOrigin(position) > limit || fromOrigin(target.position) > limit ||
      Boolean(player && (player.position.distanceTo(position) > (this.config.playerLeash ?? 8) ||
        player.position.distanceTo(target.position) > (this.config.playerLeash ?? 8)))
  }

  #retreat(target, reason) {
    const changed = this.#setReflexState(reason, target)
    this.combat.disengage()

    const now = this.now()
    if (!changed && now - this.lastRetreatGoalAt < 750) return
    this.lastRetreatGoalAt = now

    const point = retreatPoint(
      this.bot.entity.position,
      target.position,
      this.config.retreatDistance
    )
    this.movement.setOverrideGoal(OVERRIDE_OWNER, new GoalNear(point.x, point.y, point.z, 1))
  }

  #setReflexState(mode, target) {
    if (this.reflexState === mode && this.targetId === target.id) return false
    this.reflexState = mode
    this.targetId = target.id

    if (mode === 'LOW_HEALTH') this.logger.warn(`Low health (${this.bot.health}); retreating from ${target.name}`)
    if (mode.startsWith('CREEPER')) this.logger.warn('Creeper nearby; maintaining distance')
    if (mode === 'PASSIVE_AVOID') this.logger.throttled('passive-avoid', 3000, 'info', `Avoiding ${target.name} in PASSIVE mode`)
    return true
  }

  #clearThreat() {
    this.pursuit = null
    if (this.reflexState === 'IDLE' && !this.survivalGoalId) return
    if (this.reflexState !== 'IDLE') this.logger.info('Threat cleared; resuming previous behavior')
    this.reflexState = 'IDLE'
    this.targetId = null
    this.lastRetreatGoalAt = 0
    this.combat.disengage()
    if (this.survivalGoalId) this.goalManager?.complete(this.survivalGoalId)
    this.survivalGoalId = null
    this.movement.endOverride(OVERRIDE_OWNER)
  }

  #onEntityHurt(entity) {
    const now = this.now()
    if (entity.id === this.bot.entity?.id) {
      this.selfDefendUntil = now + this.config.defenseMemoryMs
      this.logger.throttled('self-defense', 3000, 'info', 'AI_Companion was hurt; checking nearby threats')
      return
    }

    const username = Object.keys(this.bot.players).find(name => (
      name !== this.bot.username && this.bot.players[name]?.entity?.id === entity.id
    ))
    if (!username) return

    this.defendUntil.set(username, now + this.config.defenseMemoryMs)
    this.logger.throttled(`defend-${username}`, 3000, 'info', `${username} was hurt; checking nearby threats`)
  }

  #activeDefendedPlayers(now = this.now()) {
    const players = []

    for (const [username, until] of this.defendUntil) {
      if (until <= now) {
        this.defendUntil.delete(username)
        continue
      }

      const entity = this.bot.players[username]?.entity
      if (entity) players.push(entity)
    }

    return players
  }

  #isAttackAuthorized(target) {
    if (!this.bot.entity || !this.bot.entities[target.id]) return false

    const now = this.now()
    if (this.noPursuit || now < this.pursuitBlockedUntil || this.#pursuitExceeded(target, now)) return false
    const selected = selectCombatTarget({
      mode: this.combatMode,
      entities: Object.values(this.bot.entities),
      botPosition: this.bot.entity.position,
      detectionRange: this.config.detectionRange,
      immediateDangerRange: this.config.immediateDangerRange,
      defendedPlayers: this.#activeDefendedPlayers(now),
      defenseRange: this.config.defenseRange,
      selfDefenseActive: this.selfDefendUntil > now,
      orderedTargetId: this.orderUntil > now ? this.orderedTargetId : null
    })
    return selected?.id === target.id
  }

  #beginSurvivalGoal(type, target) {
    if (this.survivalGoalId && this.goalManager?.current?.id === this.survivalGoalId) return
    if (!this.goalManager) return

    const requested = this.goalManager.request({
      type,
      source: GOAL_SOURCES.SURVIVAL,
      payload: { targetId: target.id, target: target.name },
      resumable: false
    })
    if (requested.accepted) {
      this.survivalGoalId = requested.goal.id
      this.journal?.record('survival_goal', `${type}:${target.name}`)
    }
  }
}

module.exports = { SurvivalController }
