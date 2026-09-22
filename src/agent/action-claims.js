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

module.exports = { groundActionReply }
