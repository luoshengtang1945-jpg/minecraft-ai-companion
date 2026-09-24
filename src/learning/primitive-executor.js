const { validatePrimitiveAction } = require('./action-schema')
const { distanceBetween, droppedItemSummary } = require('./observation')
const { selectExplorationDestination } = require('./exploration')
const { IntentionMonitor } = require('./intention-monitor')

function explorationMoveTimeoutMs(baseMs, distance) {
  return Math.max(baseMs, Math.min(60000, distance * 2500))
}

const IMMUTABLE_BLOCKS = new Set(['bedrock', 'barrier', 'end_portal', 'end_portal_frame'])

class PrimitiveActionExecutor {
  constructor({ bot, movement, observer, survival = null, speech = null, vision = null, moveTimeoutMs = 20000, now = Date.now, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout }) {
    this.bot = bot
    this.movement = movement
    this.observer = observer
    this.survival = survival
    this.speech = speech
    this.vision = vision
    this.moveTimeoutMs = moveTimeoutMs
    this.now = now
    this.setTimeoutFn = setTimeoutFn
    this.clearTimeoutFn = clearTimeoutFn
  }

  async execute(untrustedAction, { isCancelled = () => false, explorationState = null, goal = null } = {}) {
    let action
    try {
      action = validatePrimitiveAction(untrustedAction)
    } catch (error) {
      return { success: false, reason: `INVALID_ACTION: ${error.message}` }
    }
    if (isCancelled()) return { success: false, reason: 'CANCELLED' }

    try {
      if (action.action === 'OBSERVE') return { success: true, reason: 'OBSERVATION_CAPTURED' }
      if (action.action === 'LOOK_VISUALLY') {
        if (!this.vision) return { success: false, reason: 'VISUAL_PERCEPTION_UNAVAILABLE' }
        const result = await this.vision.request({ priority: 'TASK', trigger: 'LEARNING_LOOK_VISUALLY', requireFresh: true })
        if (result.status === 'UPDATED') return { success: true, reason: 'VISUAL_OBSERVATION_UPDATED', visualFrameId: result.frameId }
        if (result.status === 'PREEMPTED') return { success: false, reason: 'VISUAL_PERCEPTION_PREEMPTED', yielded: true }
        return { success: false, reason: `VISUAL_PERCEPTION_${result.reason || result.status}` }
      }
      if (action.action === 'WAIT') return await this.#wait(action.durationMs, isCancelled)
      if (action.action === 'STOP') {
        this.movement.stopLearningMotion()
        return { success: true, reason: 'LEARNING_MOTION_STOPPED' }
      }
      if (action.action === 'SAY') {
        if (this.speech && !this.speech.say(action.message.trim())) {
          return { success: false, reason: 'SPEECH_COOLDOWN_OR_DUPLICATE' }
        }
        if (!this.speech) this.bot.chat(action.message.trim())
        return { success: true, reason: 'MESSAGE_SENT' }
      }
      if (action.action === 'SELECT_SLOT') {
        this.bot.setQuickBarSlot(action.slot)
        return { success: true, reason: `SELECTED_SLOT_${action.slot}` }
      }
      if (action.action === 'USE_ITEM') {
        this.bot.activateItem()
        return { success: true, reason: 'HELD_ITEM_USED' }
      }
      const monitor = ['EXPLORE', 'MOVE_NEAR'].includes(action.action) && this.observer.capture
        ? new IntentionMonitor({ action, goal, initialObservation: this.observer.capture({ goal }) }) : null
      const monitoring = { monitor, explorationState, goal }
      if (action.action === 'EXPLORE') return await this.#explore(action, explorationState, isCancelled, monitoring)

      const target = this.observer.resolve(action.target)
      if (!target?.position) return { success: false, reason: 'TARGET_NOT_FOUND' }

      if (action.action === 'LOOK_AT') {
        await this.bot.lookAt(target.position, true)
        return { success: true, reason: 'LOOKED_AT_TARGET' }
      }
      if (action.action === 'MOVE_NEAR') {
        const effectiveDistance = action.target.startsWith('block:') ? Math.min(action.distance, 3.5) : action.distance
        const result = await this.#moveNear(target, effectiveDistance, isCancelled, monitoring)
        return effectiveDistance === action.distance ? result : {
          ...result, requestedDistance: action.distance, effectiveDistance
        }
      }
      if (action.action === 'ATTACK_ENTITY') return await this.#attack(target)
      if (action.action === 'DIG_BLOCK') return await this.#dig(target, isCancelled)
      return { success: false, reason: 'INVALID_ACTION' }
    } catch (error) {
      return { success: false, reason: error.message || 'ACTION_ERROR' }
    }
  }

  async #explore(action, explorationState, isCancelled, monitoring) {
    const destination = selectExplorationDestination(this.bot, action, explorationState)
    if (!destination) return { success: false, reason: 'NO_SAFE_EXPLORATION_DESTINATION' }
    const movementResult = await this.#moveNear({ position: destination }, 1, isCancelled,
      { ...monitoring, maxMoveMs: explorationMoveTimeoutMs(this.moveTimeoutMs, action.distance) })
    return {
      ...movementResult,
      destination: { x: destination.x, y: destination.y, z: destination.z },
      heading: action.heading,
      distance: action.distance
    }
  }

  async #moveNear(target, distance, isCancelled, { monitor = null, explorationState = null, goal = null, maxMoveMs = this.moveTimeoutMs } = {}) {
    if (!this.bot.entity?.position) return { success: false, reason: 'BOT_POSITION_UNAVAILABLE' }
    const droppedItem = droppedItemSummary(target)
    const pathDistance = droppedItem ? Math.max(0.5, distance - 0.5) : distance
    if (!this.movement.startLearningMovement(target.position, pathDistance)) {
      return { success: false, reason: 'LOCOMOTION_NOT_AVAILABLE' }
    }
    if (distanceBetween(this.bot.entity.position, target.position) <= distance) {
      this.movement.finishLearningMovement()
      return { success: true, reason: 'ALREADY_NEAR_TARGET' }
    }

    return await new Promise(resolve => {
      let settled = false
      let remainingMs = maxMoveMs
      let lastCheckedAt = this.now()
      let nextObservationAt = lastCheckedAt + 750
      let tightenedItemPath = false
      const commandEpoch = this.movement.getPlayerCommandEpoch?.()
      const finish = result => {
        if (settled) return
        settled = true
        this.clearTimeoutFn(cancelPoll)
        this.bot.removeListener('goal_reached', onReached)
        this.bot.removeListener('path_update', onPathUpdate)
        this.movement.finishLearningMovement()
        resolve(result)
      }
      const onReached = () => {
        if (!this.movement.isLearningLocomotionOwner()) return
        const actualDistance = distanceBetween(this.bot.entity?.position, target.position)
        if (actualDistance <= distance + (droppedItem ? 0.1 : 0.75)) {
          finish({ success: true, reason: 'REACHED_TARGET' })
        } else if (droppedItem && !tightenedItemPath) {
          tightenedItemPath = true
          if (!this.movement.startLearningMovement(target.position, 0)) {
            finish({ success: false, reason: 'COULD_NOT_TIGHTEN_ITEM_APPROACH' })
          }
        } else if (droppedItem) {
          finish({ success: false, reason: 'ITEM_STILL_OUT_OF_REACH' })
        }
      }
      const onPathUpdate = result => {
        if (this.movement.isLearningLocomotionOwner() && result?.status === 'noPath') {
          finish({ success: false, reason: 'NO_PATH' })
        }
      }
      const checkCancelled = () => {
        if (isCancelled()) return finish({ success: false, reason: 'CANCELLED' })
        if (this.movement.getLocomotionOwner() === 'PLAYER' || (commandEpoch !== undefined && this.movement.getPlayerCommandEpoch?.() !== commandEpoch)) {
          return finish({ success: false, reason: 'PLAYER_PREEMPTED' })
        }
        const now = this.now()
        if (this.movement.getLocomotionOwner() !== 'SURVIVAL') remainingMs -= now - lastCheckedAt
        lastCheckedAt = now
        if (remainingMs <= 0) return finish({ success: false, reason: 'MOVE_TIMEOUT' })
        if (monitor && now >= nextObservationAt && this.movement.isLearningLocomotionOwner()) {
          nextObservationAt = now + 750
          try {
            const observation = this.observer.capture({ goal })
            explorationState?.observe(observation)
            const event = monitor.check(observation)
            if (event) return finish(event)
          } catch (error) {
            return finish({ success: false, reason: `OBSERVATION_FAILED: ${error.message}` })
          }
        }
        cancelPoll = this.setTimeoutFn(checkCancelled, 100)
      }
      let cancelPoll = this.setTimeoutFn(checkCancelled, 100)
      this.bot.on('goal_reached', onReached)
      this.bot.on('path_update', onPathUpdate)
    })
  }

  async #attack(target) {
    const combatMode = this.survival?.getCombatMode?.()
    if (combatMode === 'PASSIVE') return { success: false, reason: 'PASSIVE_COMBAT_MODE' }
    if (combatMode && combatMode !== 'AGGRESSIVE') {
      return { success: false, reason: 'ATTACK_NOT_AUTHORIZED_IN_DEFENSIVE_MODE' }
    }
    if (target.type !== 'hostile') return { success: false, reason: 'ATTACK_TARGET_NOT_HOSTILE' }
    if (distanceBetween(this.bot.entity?.position, target.position) > 4.5) return { success: false, reason: 'TARGET_OUT_OF_REACH' }
    this.bot.attack(target)
    return { success: true, reason: 'ATTACK_SENT' }
  }

  async #dig(block, isCancelled) {
    if (IMMUTABLE_BLOCKS.has(block.name)) return { success: false, reason: 'BLOCK_NOT_ALLOWED' }
    if (distanceBetween(this.bot.entity?.position, block.position) > 5) return { success: false, reason: 'TARGET_OUT_OF_REACH' }
    const position = this.bot.entity?.position
    if (position && Math.floor(position.x) === block.position.x && Math.floor(position.z) === block.position.z && block.position.y < position.y) {
      return { success: false, reason: 'WILL_NOT_DIG_SUPPORTING_BLOCK' }
    }
    if (typeof this.bot.canDigBlock === 'function' && !this.bot.canDigBlock(block)) {
      return { success: false, reason: 'BLOCK_NOT_DIGGABLE' }
    }
    return await new Promise(resolve => {
      let settled = false
      const finish = result => {
        if (settled) return
        settled = true
        this.clearTimeoutFn(cancelPoll)
        resolve(result)
      }
      const checkCancelled = () => {
        if (isCancelled()) {
          try {
            const stopping = this.bot.stopDigging?.()
            if (stopping?.catch) void stopping.catch(() => {})
          } catch {}
          return finish({ success: false, reason: 'CANCELLED' })
        }
        cancelPoll = this.setTimeoutFn(checkCancelled, 100)
      }
      let cancelPoll = this.setTimeoutFn(checkCancelled, 100)
      Promise.resolve(this.bot.dig(block))
        .then(() => finish({ success: true, reason: 'DIG_COMPLETED' }))
        .catch(error => finish({ success: false, reason: error.message || 'DIG_FAILED' }))
    })
  }

  async #wait(durationMs, isCancelled) {
    return await new Promise(resolve => {
      let remaining = durationMs
      const step = () => {
        if (isCancelled()) return resolve({ success: false, reason: 'CANCELLED' })
        if (remaining <= 0) return resolve({ success: true, reason: 'WAIT_COMPLETED' })
        const delay = Math.min(100, remaining)
        remaining -= delay
        this.setTimeoutFn(step, delay)
      }
      step()
    })
  }
}

module.exports = { PrimitiveActionExecutor, IMMUTABLE_BLOCKS, explorationMoveTimeoutMs }
