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

const REPLY_SCHEMA = {
  type: 'object', properties: { reply: { type: 'string', minLength: 1, maxLength: 220 } },
  required: ['reply'], additionalProperties: false
}

function validateReply(value) {
  if (!value || Object.keys(value).length !== 1 || typeof value.reply !== 'string' ||
      !value.reply.trim() || value.reply.length > 220) throw new Error('Expected only a nonempty reply of at most 220 characters')
  return { reply: chatSafe(value.reply) }
}

module.exports = { isRepeatedReply, hasReversedFollowReply, REPLY_SCHEMA, validateReply }
