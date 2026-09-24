// Group recurring ambient observations without generating dialogue in code.
// The model still decides whether to speak and chooses every word.
function speechTopic(message) {
  const text = String(message || '').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase()
  if (/(?:雨停|雨不下|不下雨|没下雨|没有降水|天晴)/.test(text)) return 'WEATHER_CLEAR'
  if (/(?:下雨|雨天|降水|雷暴|打雷)/.test(text)) return 'WEATHER_RAIN'
  if (/(?:天黑|入夜|夜晚|夜里|夜深|夜了|晚上|半夜|黑了|黑夜)/.test(text)) return 'TIME_NIGHT'
  if (/(?:天亮|白天|早上|清晨|日出)/.test(text)) return 'TIME_DAY'
  if (/(?:晴天|晴朗|没下雨|不下雨|阳光)/.test(text)) return 'WEATHER_CLEAR'
  if (/(?:跟着你|跟在你|跟上你|跟你走|在你后面)/.test(text)) return 'FOLLOW_STATUS'
  if (/(?:在这等|停在这|不乱动|待在这里)/.test(text)) return 'WAIT_STATUS'
  return null
}

module.exports = { speechTopic }
