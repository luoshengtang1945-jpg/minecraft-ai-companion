// Candidates come from actual nearby symbolic observations, not recipes or drops.
const NON_RESOURCE_BLOCKS = new Set(['chest', 'crafting_table', 'furnace'])

function availableTaskItems(state, bot, limit = 8) {
  const inventory = new Set((bot.inventory?.items?.() || []).filter(item => item.count > 0).map(item => item.name))
  const items = []
  for (const summary of state.usefulBlocks || []) {
    const match = /^([a-z0-9_]{1,64})x\d+$/.exec(summary)
    if (!match) continue
    const name = match[1]
    if (NON_RESOURCE_BLOCKS.has(name) || inventory.has(name) ||
        !Object.hasOwn(bot.registry?.itemsByName || {}, name)) continue
    if (!items.includes(name)) items.push(name)
    if (items.length >= limit) break
  }
  return items
}

module.exports = { availableTaskItems, NON_RESOURCE_BLOCKS }
