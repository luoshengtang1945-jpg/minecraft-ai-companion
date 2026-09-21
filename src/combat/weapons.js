const WEAPONS = {
  netherite_sword: { score: 12.8, cooldownMs: 625 },
  diamond_sword: { score: 11.2, cooldownMs: 625 },
  iron_sword: { score: 9.6, cooldownMs: 625 },
  stone_sword: { score: 8, cooldownMs: 625 },
  golden_sword: { score: 6.4, cooldownMs: 625 },
  wooden_sword: { score: 6.4, cooldownMs: 625 },
  netherite_axe: { score: 10, cooldownMs: 1000 },
  diamond_axe: { score: 9, cooldownMs: 1000 },
  iron_axe: { score: 8.1, cooldownMs: 1110 },
  stone_axe: { score: 7.2, cooldownMs: 1250 },
  golden_axe: { score: 7, cooldownMs: 1000 },
  wooden_axe: { score: 5.6, cooldownMs: 1250 },
  mace: { score: 8, cooldownMs: 625 },
  trident: { score: 9, cooldownMs: 910 }
}

const UNARMED = { score: 1, cooldownMs: 650 }

function weaponStats(item) {
  return WEAPONS[item?.name] || UNARMED
}

function bestMeleeWeapon(items) {
  return items.reduce((best, item) => {
    if (!WEAPONS[item.name]) return best
    if (!best || weaponStats(item).score > weaponStats(best).score) return item
    return best
  }, null)
}

module.exports = { WEAPONS, UNARMED, weaponStats, bestMeleeWeapon }
