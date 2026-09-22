const minecraftData = require('minecraft-data')

// Mineflayer 4.39's bed plugin uses legacy numeric actionId=2. New protocols
// instead map leave_bed to 0; use the negotiated protocol's symbolic mapping.
function sendWakeRequest(bot) {
  const packet = bot.version && minecraftData(bot.version)?.protocol?.play?.toServer?.types?.packet_entity_action
  const actionType = packet?.[1]?.find(field => field.name === 'actionId')?.type
  if (Array.isArray(actionType) && actionType[0] === 'mapper') {
    if (!Object.values(actionType[1].mappings).includes('leave_bed')) throw new Error('Protocol has no known leave_bed action')
    bot._client.write('entity_action', { entityId: bot.entity.id, actionId: 'leave_bed', jumpBoost: 0 })
    return
  }
  return bot.wake()
}

module.exports = { sendWakeRequest }
