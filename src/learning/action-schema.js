const ACTION_TYPES = Object.freeze([
  'OBSERVE',
  'LOOK_VISUALLY',
  'LOOK_AT',
  'MOVE_NEAR',
  'EXPLORE',
  'ATTACK_ENTITY',
  'DIG_BLOCK',
  'USE_ITEM',
  'WAIT',
  'SELECT_SLOT',
  'STOP',
  'SAY'
])

const ACTION_KEYS = Object.freeze({
  OBSERVE: [],
  LOOK_VISUALLY: [],
  LOOK_AT: ['target'],
  MOVE_NEAR: ['target', 'distance', 'watchFor'],
  EXPLORE: ['heading', 'distance', 'watchFor'],
  ATTACK_ENTITY: ['target'],
  DIG_BLOCK: ['target'],
  USE_ITEM: [],
  WAIT: ['durationMs'],
  SELECT_SLOT: ['slot'],
  STOP: [],
  SAY: ['message']
})

const TARGET_PATTERN = /^(block:-?\d+,-?\d+,-?\d+|entity:\d+)$/

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function assertExactKeys(value, allowed) {
  const keys = Object.keys(value)
  const expected = ['action', ...allowed]
  const unexpected = keys.filter(key => !expected.includes(key))
  if (unexpected.length) throw new Error(`Unexpected action fields: ${unexpected.join(', ')}`)
}

function validateTarget(target, kind = null) {
  if (typeof target !== 'string' || !TARGET_PATTERN.test(target)) {
    throw new Error('target must be an observed block:x,y,z or entity:id reference')
  }
  if (kind && !target.startsWith(`${kind}:`)) throw new Error(`target must reference a ${kind}`)
}

function validatePrimitiveAction(value) {
  if (!isPlainObject(value)) throw new Error('Primitive action must be a JSON object')
  if (!ACTION_TYPES.includes(value.action)) throw new Error(`Action is not allowlisted: ${String(value.action)}`)
  assertExactKeys(value, ACTION_KEYS[value.action])

  if (['LOOK_AT', 'MOVE_NEAR'].includes(value.action)) validateTarget(value.target)
  if (value.action === 'ATTACK_ENTITY') validateTarget(value.target, 'entity')
  if (value.action === 'DIG_BLOCK') validateTarget(value.target, 'block')

  if (value.action === 'MOVE_NEAR') {
    if (!Number.isFinite(value.distance) || value.distance < 1 || value.distance > 6) {
      throw new Error('MOVE_NEAR distance must be between 1 and 6')
    }
  }
  if (value.action === 'EXPLORE') {
    if (!Number.isInteger(value.heading) || value.heading < 0 || value.heading > 359) {
      throw new Error('EXPLORE heading must be an integer between 0 and 359')
    }
    if (!Number.isInteger(value.distance) || value.distance < 2 || value.distance > 32) {
      throw new Error('EXPLORE distance must be an integer between 2 and 32')
    }
  }
  if (value.watchFor !== undefined && (!Array.isArray(value.watchFor) || value.watchFor.length > 8 || value.watchFor.some(name => typeof name !== 'string' || !/^[a-z0-9_]{1,64}$/.test(name)))) {
    throw new Error('watchFor must contain at most 8 symbolic names')
  }
  if (value.action === 'WAIT') {
    if (!Number.isInteger(value.durationMs) || value.durationMs < 100 || value.durationMs > 10000) {
      throw new Error('WAIT durationMs must be an integer between 100 and 10000')
    }
  }
  if (value.action === 'SELECT_SLOT') {
    if (!Number.isInteger(value.slot) || value.slot < 0 || value.slot > 8) {
      throw new Error('SELECT_SLOT slot must be an integer between 0 and 8')
    }
  }
  if (value.action === 'SAY') {
    if (typeof value.message !== 'string' || !value.message.trim() || value.message.length > 160) {
      throw new Error('SAY message must contain 1 to 160 characters')
    }
  }

  return Object.freeze({ ...value })
}

function parseJsonObject(content) {
  if (typeof content !== 'string') throw new Error('Model response must be text containing one JSON object')
  let text = content.trim()
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  if (fenced) text = fenced[1].trim()
  const value = JSON.parse(text)
  if (!isPlainObject(value)) throw new Error('Model response must contain one JSON object')
  return value
}

function parsePrimitiveAction(content) {
  return validatePrimitiveAction(parseJsonObject(content))
}

function canonicalAction(action) {
  const valid = validatePrimitiveAction(action)
  return JSON.stringify(Object.keys(valid).sort().reduce((result, key) => {
    result[key] = valid[key]
    return result
  }, {}))
}

module.exports = {
  ACTION_TYPES,
  TARGET_PATTERN,
  validatePrimitiveAction,
  parsePrimitiveAction,
  parseJsonObject,
  canonicalAction
}
