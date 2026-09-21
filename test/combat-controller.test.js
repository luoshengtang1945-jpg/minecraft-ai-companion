const test = require('node:test')
const assert = require('node:assert/strict')
const { CombatController } = require('../src/combat/combat-controller')

test('combat rechecks authorization after asynchronous weapon equip', async () => {
  let authorized = true
  let attacks = 0
  const weapon = { name: 'diamond_sword', type: 1 }
  const bot = {
    entity: { position: { distanceTo: () => 2 } },
    heldItem: null,
    inventory: { items: () => [weapon] },
    async equip() {
      this.heldItem = weapon
      authorized = false
    },
    async lookAt() {},
    attack() { attacks += 1 }
  }
  const movement = { setOverrideGoal() {} }
  const logger = { info() {}, throttled() {} }
  const combat = new CombatController(bot, {
    movement,
    logger,
    config: { meleeRange: 3.1, approachRange: 2.4 }
  })
  const target = {
    id: 4,
    name: 'zombie',
    height: 1.8,
    position: { offset: () => ({}) }
  }

  await combat.engage(target, () => authorized)
  assert.equal(attacks, 0)
})
