const { chatSafe } = require('./decision')

function normalizedReply(text) {
  return chatSafe(String(text)).toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '')
}

function isRepeatedReply(reply, recentReplies) {
  const normalized = normalizedReply(reply)
  return normalized.length > 0 && recentReplies.some(previous => normalizedReply(previous) === normalized)
}

function hasReversedFollowReply(action, reply) {
  if (action !== 'FOLLOW') return false
  const text = reply.trim()
  return /别掉队|别走散|跟[紧上着]我|跟我走|我带路|你.{0,6}跟/.test(text) ||
    (/跟[紧上]/.test(text) && !/我|跟紧你|跟上你/.test(text))
}

function isStageDirectionReply(reply) {
  return /^[（(][^）)]{1,80}[）)]$/.test(String(reply).trim())
}

function contradictsMovementAction(action, reply) {
  const text = String(reply).trim()
  if (action === 'STOP') return /我(?:已经|已|刚|现在)?(?:跟上|跟着|跟随|追上|跟在你)/.test(text)
  if (action === 'FOLLOW' || action === 'COME') {
    return /我(?:已经|已|刚|现在|先)?(?:停下|停在|不动|在这等)/.test(text)
  }
  return false
}

const MOVEMENT_ACKNOWLEDGEMENTS = Object.freeze({
  FOLLOW: ['好，我跟着你。', '嗯，我走你后面。', '行，我跟在后头。', '好，我试着跟上。'],
  COME: ['好，我过来。', '嗯，我正往你那儿走。', '行，我试着过去。'],
  STOP: ['好，我先停下。', '嗯，我在这儿等着。', '行，我先不动。']
})

function fallbackMovementReply(action, recentReplies) {
  return MOVEMENT_ACKNOWLEDGEMENTS[action]?.find(reply => !isRepeatedReply(reply, recentReplies)) || ''
}

const REPLY_SCHEMA = {
  type: 'object', properties: { reply: { type: 'string', minLength: 1, maxLength: 220 } },
  required: ['reply'], additionalProperties: false
}

function validateReply(value) {
  if (!value || Object.keys(value).length !== 1 || typeof value.reply !== 'string' ||
      !value.reply.trim() || value.reply.length > 220) throw new Error('Expected only a nonempty reply of at most 220 characters')
  return { reply: chatSafe(value.reply) }
}

module.exports = { isRepeatedReply, hasReversedFollowReply, isStageDirectionReply, contradictsMovementAction, fallbackMovementReply, REPLY_SCHEMA, validateReply }
