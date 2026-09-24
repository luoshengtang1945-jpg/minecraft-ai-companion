const { answerFactualQuestion } = require('./factual-answer')

// Conservative checks for explicit PRESENT-TENSE claims only. Preferences,
// hypotheticals and historical statements are not weather observations.
function checkWorldClaim(text, bot) {
  const patterns = [
    { regex: /(?:现在|目前|这会儿)(?:天气)?(?:是|正在|在)?(?:下雨|降水)/, topic: 'WEATHER', valid: () => bot.isRaining === true },
    { regex: /(?:现在|目前|这会儿)(?:天气)?(?:是|正在|在)?雷暴/, topic: 'WEATHER', valid: () => bot.isRaining === true && bot.thunderState > 0 },
    { regex: /(?:现在|目前|这会儿)(?:是|正在|在)?下雪/, topic: 'WEATHER', valid: () => false },
    { regex: /(?:现在|目前|这会儿)(?:天气)?(?:是|很)?(?:晴天|晴朗|没有降水|没下雨)/, topic: 'WEATHER', valid: () => bot.isRaining === false },
    { regex: /(?:现在|目前|这会儿)(?:是)?白天/, topic: 'TIME', valid: () => day() },
    { regex: /(?:现在|目前|这会儿)(?:是)?阳光明媚/, topic: 'TIME', valid: () => day() && bot.isRaining === false },
    { regex: /(?:现在|目前|这会儿)(?:是)?(?:晚上|夜晚|天黑了)/, topic: 'TIME', valid: () => night() }
  ]
  const time = bot.time?.timeOfDay
  const known = ['overworld', 'minecraft:overworld'].includes(bot.game?.dimension) && Number.isFinite(time) && time >= 0 && time < 24000
  const day = () => known && time < 12000
  const night = () => known && time >= 13000 && time < 23000
  const clauses = text.split(/[，。！？；\n]/).filter(clause => !/如果|假如|要是|假设|比如|例如/.test(clause))
  for (const pattern of patterns) {
    if (clauses.some(clause => pattern.regex.test(clause)) && !pattern.valid()) {
      const answer = answerFactualQuestion(pattern.topic === 'TIME' ? '现在白天还是晚上' : '天气怎么样', { bot, movement: {} })
      return { valid: false, topic: pattern.topic, correction: answer.reply }
    }
  }
  return { valid: true }
}

module.exports = { checkWorldClaim }
