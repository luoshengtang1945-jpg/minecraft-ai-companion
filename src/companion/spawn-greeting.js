const defaults = require('../../config/spawn-greetings.json')
const { chatSafe } = require('../agent/decision')

function selectSpawnGreeting({ override = '', greetings = defaults, random = Math.random } = {}) {
  if (typeof override === 'string' && override.trim()) return chatSafe(override)
  const choices = Array.isArray(greetings)
    ? greetings.filter(text => typeof text === 'string' && text.trim()).map(text => chatSafe(text))
    : []
  if (!choices.length) return '嗨，我来了。'
  const sample = random()
  const index = Number.isFinite(sample) ? Math.max(0, Math.min(choices.length - 1, Math.floor(sample * choices.length))) : 0
  return choices[index]
}

function sendSpawnGreeting({ bot, session, ...options }) {
  const message = selectSpawnGreeting(options)
  bot.chat(message)
  // Greeting counts as speech so autonomy can see it and leave a conversation gap.
  session?.recordSpeech(message)
  return message
}

module.exports = { selectSpawnGreeting, sendSpawnGreeting }
