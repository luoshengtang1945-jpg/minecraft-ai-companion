const ACTIONS = new Set([
  'CHAT',
  'FOLLOW',
  'COME',
  'STOP',
  'PASSIVE',
  'DEFENSIVE',
  'AGGRESSIVE',
  'ATTACK'
])

function parseDecision(content) {
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('Ollama returned an empty decision')
  }

  const cleaned = content.replace(/```json/gi, '').replace(/```/g, '').trim()
  return validateDecision(JSON.parse(cleaned))
}

function validateDecision(decision) {
  if (!decision || typeof decision !== 'object' || !ACTIONS.has(decision.action)) {
    throw new Error(`Invalid agent action: ${decision?.action}`)
  }
  const keys = Object.keys(decision)
  if (keys.some(key => !['action', 'reply'].includes(key))) throw new Error('Unexpected agent decision fields')
  if (typeof decision.reply !== 'string') throw new Error('Agent reply must be a string')

  return {
    action: decision.action,
    reply: decision.reply
  }
}

function chatSafe(text, maxLength = 220) {
  return text.replace(/\s+/g, ' ').trim().slice(0, maxLength)
}

module.exports = { ACTIONS, parseDecision, validateDecision, chatSafe }
