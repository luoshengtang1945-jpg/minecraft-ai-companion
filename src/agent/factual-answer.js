// Closed factual questions use live symbolic state, not model guesses or old chat.
// Suggestions, hypothetical questions, and compound commands deliberately fall through.
function answerFactualQuestion(message, { bot, movement }) {
  const text = String(message).trim().replace(/[？?！!。]+$/g, '').replace(/\s+/g, '')
  let topic
  let reply
  if (/^(?:现在|目前|今天)?(?:天气(?:怎么样|如何)|(?:在)?下雨(?:了)?吗|是不是在下雨|有没有下雨)$/.test(text)) {
    topic = 'WEATHER'
    reply = typeof bot.isRaining !== 'boolean' ? '我还没拿到可靠的天气状态，暂时不能确定。'
      : !bot.isRaining ? '现在服务器天气没有降水。'
        : bot.thunderState > 0 ? '现在是雷暴天气。' : '现在是降水天气，具体是雨还是雪要看当地环境。'
  } else if (/^(?:现在|目前)?(?:是)?(?:白天还是晚上|白天还是夜晚|白天吗|晚上吗|天黑了吗|几点了)$/.test(text)) {
    topic = 'TIME'
    const time = bot.time?.timeOfDay
    if (!['overworld', 'minecraft:overworld'].includes(bot.game?.dimension)) reply = '这里还不能按主世界的昼夜判断，我不想瞎猜。'
    else if (!Number.isFinite(time) || time < 0 || time >= 24000) reply = '我还没拿到可靠的游戏时间。'
    else reply = time < 12000 ? '现在是白天。' : time < 13000 ? '现在接近入夜了。' : time < 23000 ? '现在是夜晚。' : '现在快天亮了。'
  } else if (/^(?:你)?(?:现在)?(?:睡着了吗|在睡觉吗|躺下了吗|起床了吗)$/.test(text)) {
    topic = 'SLEEP'
    reply = typeof bot.isSleeping !== 'boolean' ? '我还没确认到自己的睡眠状态。'
      : bot.isSleeping ? '服务器显示我还在床上。' : '我现在没有在睡觉。'
  } else if (/^你(?:现在)?(?:在干嘛|在干什么|在做什么|在做啥)$/.test(text)) {
    topic = 'BEHAVIOR'
    const behavior = movement.getBehaviorSummary?.()
    if (bot.isSleeping === true) reply = '我现在在床上。'
    else if (behavior?.locomotionOwner === 'SURVIVAL') reply = '我正在处理眼前的危险，先顾安全。'
    else if (behavior?.type === 'FOLLOW') reply = '我保持着跟随，至于有没有跟到身边，还得看实际距离。'
    else if (behavior?.type === 'COME') reply = '我正尝试到你身边，还不能说已经到了。'
    else if (behavior?.type === 'STOP' && behavior.source === 'PLAYER') reply = '我按你的指令在这等着。'
    else if (behavior?.type === 'STOP') reply = '我现在没有移动任务，在附近待着。'
    else reply = behavior?.type ? `当前动作记录是 ${behavior.type}，还不能把它说成已经完成。` : '我还没拿到明确的动作状态，暂时不能确定。'
  }
  return topic ? { topic, reply, source: 'LIVE_MINEFLAYER_STATE' } : null
}

module.exports = { answerFactualQuestion }
