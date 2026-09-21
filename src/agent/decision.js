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
  const decision = JSON.parse(cleaned)

  if (!decision || typeof decision !== 'object' || !ACTIONS.has(decision.action)) {
    throw new Error(`Invalid agent action: ${decision?.action}`)
  }

  return {
    action: decision.action,
    reply: typeof decision.reply === 'string' ? decision.reply : ''
  }
}

function chatSafe(text, maxLength = 220) {
  return text.replace(/\s+/g, ' ').trim().slice(0, maxLength)
}

module.exports = { ACTIONS, parseDecision, chatSafe }
