const test = require('node:test')
const assert = require('node:assert/strict')
const { bestMeleeWeapon, weaponStats } = require('../src/combat/weapons')

test('bestMeleeWeapon ignores tools and selects the highest melee DPS', () => {
  const items = [
    { name: 'diamond_pickaxe' },
    { name: 'iron_axe' },
    { name: 'diamond_sword' }
  ]

  assert.equal(bestMeleeWeapon(items).name, 'diamond_sword')
})

test('weapon timing is slower for axes than swords', () => {
  assert.ok(weaponStats({ name: 'diamond_axe' }).cooldownMs > weaponStats({ name: 'diamond_sword' }).cooldownMs)
})

test('bestMeleeWeapon returns null without a supported weapon', () => {
  assert.equal(bestMeleeWeapon([{ name: 'dirt' }]), null)
})
