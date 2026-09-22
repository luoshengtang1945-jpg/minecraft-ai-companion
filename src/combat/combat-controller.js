const { goals } = require('mineflayer-pathfinder')
const { GoalFollow } = goals
const { bestMeleeWeapon, weaponStats } = require('./weapons')

const OVERRIDE_OWNER = 'survival'

class CombatController {
  constructor(bot, { movement, logger, config }) {
    this.bot = bot
    this.movement = movement
    this.logger = logger
    this.config = config
    this.targetId = null
    this.lastAttackAt = 0
    this.lastEquipCheckAt = 0
    this.pursuing = false
  }

  async engage(target, isAuthorized = () => true, { pursue = true } = {}) {
    if (!isAuthorized()) return
    const changedTarget = this.targetId !== target.id
    const changedPursuit = this.pursuing !== pursue
    this.pursuing = pursue
    if (changedTarget) {
      this.targetId = target.id
      this.lastAttackAt = 0
      this.logger.info(`Engaging ${target.name}`)
    }

    const distance = this.bot.entity.position.distanceTo(target.position)
    if ((changedTarget || changedPursuit) && pursue) {
      this.movement.setOverrideGoal(
        OVERRIDE_OWNER,
        new GoalFollow(target, this.config.approachRange),
        true
      )
    }

    await this.#equipBestWeapon()
    if (!isAuthorized()) return
    if (this.bot.entity.position.distanceTo(target.position) > this.config.meleeRange) return

    if (pursue) await this.bot.lookAt(
      target.position.offset(0, Math.max((target.height || 1.8) * 0.75, 1), 0),
      true
    )

    const cooldownMs = weaponStats(this.bot.heldItem).cooldownMs
    const now = Date.now()
    if (!isAuthorized()) return
    if (now - this.lastAttackAt < cooldownMs) return

    this.lastAttackAt = now
    this.bot.attack(target)
    this.logger.throttled(
      `attack-${target.id}`,
      2000,
      'info',
      `Attacking ${target.name} at ${distance.toFixed(1)} blocks`
    )
  }

  disengage() {
    if (this.targetId !== null) this.logger.info('Combat target cleared')
    this.targetId = null
    this.pursuing = false
    this.lastAttackAt = 0
  }

  async #equipBestWeapon() {
    const now = Date.now()
    if (now - this.lastEquipCheckAt < 2000) return
    this.lastEquipCheckAt = now

    const weapon = bestMeleeWeapon(this.bot.inventory.items())
    if (!weapon || this.bot.heldItem?.type === weapon.type) return

    await this.bot.equip(weapon, 'hand')
    this.logger.info(`Equipped ${weapon.name}`)
  }
}

module.exports = { CombatController, OVERRIDE_OWNER }
