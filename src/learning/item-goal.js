const { GOAL_SOURCES } = require('../goals')

const ITEM_NAME = /^[a-z0-9_]{1,64}$/

function createItemGoal(item, { source = GOAL_SOURCES.AUTONOMOUS } = {}) {
  if (typeof item !== 'string' || !ITEM_NAME.test(item)) throw new Error('Invalid item goal')
  if (![GOAL_SOURCES.AUTONOMOUS, GOAL_SOURCES.PLAYER_TASK].includes(source)) {
    throw new Error('Invalid learning goal source')
  }
  return {
    id: `obtain-${item}`,
    pattern: `obtain ${item}`,
    description: `Obtain at least one ${item}.`,
    objective: { type: 'INVENTORY_AT_LEAST', item, count: 1 },
    source
  }
}

module.exports = { ITEM_NAME, createItemGoal }
