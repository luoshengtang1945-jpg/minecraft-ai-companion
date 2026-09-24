// Narrow deterministic guard for the bed-operation hallucinations seen in live tests.
function groundActionReply(reply, bot) {
  if (bot.isSleeping && /我(?:已经|刚刚|刚|也)?(?:起来|起床|醒来)|已经起床/.test(reply)) {
    return '服务器显示我还在床上，还没确认起床。'
  }
  if (/(?:床|重生点).{0,6}(?:点好了|设好了|设置好了|设置成功)|(?:点|设置).{0,4}(?:床|重生点).{0,4}(?:好了|完成)/.test(reply)) {
    return '我没有执行设置重生点或点床的操作，不能说已经完成。'
  }
  if (!bot.isSleeping && /我(?:已经|刚刚|刚|也)?(?:躺床上了|躺下了|睡下了|睡着了|在床上睡)/.test(reply)) {
    return '我现在还没睡下。靠近空床后，你可以叫我试着睡觉。'
  }
  return reply
}

function groundMovementReply(reply, { action, bot, movement }) {
  const behavior = movement.getBehaviorSummary?.()
  if (!behavior) return reply
  if (behavior.locomotionOwner === 'SURVIVAL') return '我先处理眼前的危险，你的移动指令已经保留。'
  if (!['FOLLOW', 'COME'].includes(action) || !/(?:已经|已|刚)?(?:到你身边了|到你旁边了|到达了|跟上你了|跟上来了)/.test(reply)) return reply
  const target = bot.players?.[behavior.username]?.entity?.position
  const origin = bot.entity?.position
  const distance = origin && target ? Math.hypot(origin.x - target.x, origin.y - target.y, origin.z - target.z) : Infinity
  if (distance <= 3) return reply
  return action === 'FOLLOW' ? '我已开始跟随，还没确认跟到你身边。' : '我正在尝试过来，还没确认到你身边。'
}

module.exports = { groundActionReply, groundMovementReply }
