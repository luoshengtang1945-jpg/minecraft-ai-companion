const COMBAT_MODES = Object.freeze({
  PASSIVE: 'PASSIVE',
  DEFENSIVE: 'DEFENSIVE',
  AGGRESSIVE: 'AGGRESSIVE'
})

const COMBAT_MODE_VALUES = new Set(Object.values(COMBAT_MODES))

function isCombatMode(mode) {
  return COMBAT_MODE_VALUES.has(mode)
}

module.exports = { COMBAT_MODES, isCombatMode }
