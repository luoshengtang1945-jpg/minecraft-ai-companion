const CONVERSATION_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['CHAT', 'FOLLOW', 'COME', 'STOP', 'PASSIVE', 'DEFENSIVE', 'AGGRESSIVE', 'ATTACK'] },
    reply: { type: 'string', minLength: 1, maxLength: 220 }
  },
  required: ['action', 'reply'],
  additionalProperties: false
})

const AUTONOMY_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['IDLE', 'FOLLOW_PLAYER', 'WANDER_NEAR_PLAYER', 'LOOK_AT_PLAYER', 'COME_TO_PLAYER', 'EXPLORE_NEARBY', 'SAY', 'WAIT', 'TRY_OBTAIN_ITEM'] },
    message: { type: 'string' },
    reason: { type: 'string' },
    goalItem: { type: 'string', pattern: '^[a-z0-9_]{1,64}$' },
    durationMs: { type: 'number', minimum: 1000, maximum: 30000 }
  },
  required: ['action'],
  additionalProperties: false
})

function actionVariant(action, properties = {}, required = []) {
  return {
    type: 'object',
    properties: { action: { const: action }, ...properties },
    required: ['action', ...required],
    additionalProperties: false
  }
}

const target = { type: 'string', pattern: '^(block:-?[0-9]+,-?[0-9]+,-?[0-9]+|entity:[0-9]+)$' }
const watchFor = { type: 'array', maxItems: 8, items: { type: 'string', pattern: '^[a-z0-9_]{1,64}$' } }
const LEARNING_ACTION_SCHEMA = Object.freeze({
  oneOf: [
    actionVariant('OBSERVE'),
    actionVariant('LOOK_VISUALLY'),
    actionVariant('LOOK_AT', { target }, ['target']),
    actionVariant('MOVE_NEAR', { target, distance: { type: 'number', minimum: 1, maximum: 6 }, watchFor }, ['target', 'distance']),
    actionVariant('EXPLORE', {
      heading: { type: 'integer', minimum: 0, maximum: 359 },
      distance: { type: 'integer', minimum: 2, maximum: 32 }, watchFor
    }, ['heading', 'distance']),
    actionVariant('ATTACK_ENTITY', { target: { type: 'string', pattern: '^entity:[0-9]+$' } }, ['target']),
    actionVariant('DIG_BLOCK', { target: { type: 'string', pattern: '^block:-?[0-9]+,-?[0-9]+,-?[0-9]+$' } }, ['target']),
    actionVariant('USE_ITEM'),
    actionVariant('WAIT', { durationMs: { type: 'integer', minimum: 100, maximum: 10000 } }, ['durationMs']),
    actionVariant('SELECT_SLOT', { slot: { type: 'integer', minimum: 0, maximum: 8 } }, ['slot']),
    actionVariant('STOP'),
    actionVariant('SAY', { message: { type: 'string', minLength: 1, maxLength: 160 } }, ['message'])
  ]
})

const REFLECTION_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    reflection: { type: 'string', minLength: 1, maxLength: 500 },
    lesson: { type: 'string', minLength: 1, maxLength: 500 },
    nextApproach: { type: 'string', minLength: 1, maxLength: 500 }
  },
  required: ['reflection', 'lesson', 'nextApproach'],
  additionalProperties: false
})

module.exports = { CONVERSATION_SCHEMA, AUTONOMY_SCHEMA, LEARNING_ACTION_SCHEMA, REFLECTION_SCHEMA }
