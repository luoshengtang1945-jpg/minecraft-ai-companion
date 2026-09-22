const LOCOMOTION_OWNERS = Object.freeze({
  NONE: 'NONE',
  PRESENCE: 'PRESENCE',
  AUTONOMY: 'AUTONOMY',
  PLAYER_TASK: 'PLAYER_TASK',
  PLAYER: 'PLAYER',
  SURVIVAL: 'SURVIVAL'
})

const OWNER_PRIORITY = Object.freeze({
  NONE: 0,
  PRESENCE: 10,
  AUTONOMY: 20,
  PLAYER_TASK: 25,
  PLAYER: 30,
  SURVIVAL: 40
})

class LocomotionArbiter {
  constructor({ logger }) {
    this.logger = logger
    this.owner = LOCOMOTION_OWNERS.NONE
    this.reason = null
    this.autonomyEpoch = 0
  }

  acquire(owner, reason, { allowSame = false } = {}) {
    if (!(owner in OWNER_PRIORITY)) throw new Error(`Invalid locomotion owner: ${owner}`)
    if (OWNER_PRIORITY[owner] < OWNER_PRIORITY[this.owner]) return false
    if (owner === this.owner && !allowSame) return false

    if ([LOCOMOTION_OWNERS.PLAYER, LOCOMOTION_OWNERS.SURVIVAL].includes(owner) && owner !== this.owner) {
      this.autonomyEpoch += 1
    }
    this.#transition(owner, reason)
    return true
  }

  release(owner, nextOwner = LOCOMOTION_OWNERS.NONE, reason = null) {
    if (this.owner !== owner) return false
    this.#transition(nextOwner, reason)
    return true
  }

  invalidateAutonomy() {
    this.autonomyEpoch += 1
    return this.autonomyEpoch
  }

  getAutonomyEpoch() {
    return this.autonomyEpoch
  }

  isAutonomyEpoch(epoch) {
    return epoch === this.autonomyEpoch
  }

  canAcquire(owner) {
    return OWNER_PRIORITY[owner] >= OWNER_PRIORITY[this.owner]
  }

  #transition(owner, reason) {
    const previousOwner = this.owner
    const previousReason = this.reason
    this.owner = owner
    this.reason = reason || null
    if (previousOwner === owner && previousReason === this.reason) return

    const suffix = this.reason ? ` (${this.reason})` : ''
    this.logger.info(`[MOVE] ${previousOwner} -> ${owner}${suffix}`)
  }
}

module.exports = { LocomotionArbiter, LOCOMOTION_OWNERS, OWNER_PRIORITY }
