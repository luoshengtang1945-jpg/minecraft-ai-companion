const AUTONOMOUS_ACTIONS = new Set([
  'IDLE',
  'FOLLOW_PLAYER',
  'WANDER_NEAR_PLAYER',
  'LOOK_AT_PLAYER',
  'COME_TO_PLAYER',
  'EXPLORE_NEARBY',
  'SAY',
  'WAIT'
])

function validateAutonomousDecision(value) {
  if (!value || typeof value !== 'object' || !AUTONOMOUS_ACTIONS.has(value.action)) {
    throw new Error(`Invalid autonomous action: ${value?.action}`)
  }

  return {
    action: value.action,
    message: typeof value.message === 'string' ? value.message : '',
    reason: typeof value.reason === 'string' ? value.reason.slice(0, 160) : '',
    durationMs: Number.isFinite(value.durationMs)
      ? Math.max(1000, Math.min(value.durationMs, 30000))
      : 5000
  }
}

function parseAutonomousDecision(content) {
  if (typeof content !== 'string' || !content.trim()) throw new Error('Ollama returned an empty autonomous decision')
  const cleaned = content.replace(/```json/gi, '').replace(/```/g, '').trim()
  return validateAutonomousDecision(JSON.parse(cleaned))
}

module.exports = { AUTONOMOUS_ACTIONS, validateAutonomousDecision, parseAutonomousDecision }
