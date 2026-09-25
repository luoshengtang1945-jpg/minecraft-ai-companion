// A sentence may mention more than one ambient topic (for example rain at night).
// The model still decides whether to speak and chooses every word.
function speechTopics(message) {
  const text = String(message || '').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase()
  const topics = []
  if (/(?:雨停|雨不下|不下雨|没下雨|没有降水|天晴|晴天|晴朗|阳光)/.test(text)) topics.push('WEATHER_CLEAR')
  else if (/(?:下雨|雨天|降水|雷暴|打雷)/.test(text)) topics.push('WEATHER_RAIN')
  if (/(?:天黑|入夜|夜晚|夜里|夜深|夜色|夜了|晚上|半夜|黑了|黑夜)/.test(text)) topics.push('TIME_NIGHT')
  if (/(?:天亮|白天|早上|清晨|日出)/.test(text)) topics.push('TIME_DAY')
  if (/(?:跟着你|跟在你|跟上你|跟你走|在你后面)/.test(text)) topics.push('FOLLOW_STATUS')
  if (/(?:在这等|停在这|不乱动|待在这里)/.test(text)) topics.push('WAIT_STATUS')
  return topics
}

function speechTopic(message) {
  return speechTopics(message)[0] || null
}

module.exports = { speechTopic, speechTopics }
