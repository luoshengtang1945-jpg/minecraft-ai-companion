const VISUAL_SOURCES = Object.freeze({
  OBSERVED: 'OBSERVED_VISUALLY',
  SYMBOLIC: 'CONFIRMED_SYMBOLICALLY',
  INFERRED: 'INFERRED',
  UNKNOWN: 'UNKNOWN'
})

const SCENE_TYPES = Object.freeze([
  'OPEN_TERRAIN', 'WOODED_AREA', 'CAVE_LIKE', 'VILLAGE_OR_BUILDINGS',
  'INTERIOR', 'WATER', 'NETHER', 'END', 'UNKNOWN'
])
const REGIONS = Object.freeze(['LEFT', 'CENTER', 'RIGHT', 'NEAR', 'MID', 'FAR', 'UNKNOWN'])

const visualItemSchema = {
  type: 'object',
  properties: {
    label: { type: 'string', minLength: 1, maxLength: 80 },
    region: { type: 'string', enum: REGIONS },
    confidence: { type: 'number', minimum: 0, maximum: 1 }
  },
  required: ['label', 'region', 'confidence'],
  additionalProperties: false
}

const VISUAL_OBSERVATION_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    sceneType: { type: 'string', enum: SCENE_TYPES },
    summary: { type: 'string', minLength: 1, maxLength: 300 },
    salientObjects: { type: 'array', maxItems: 10, items: visualItemSchema },
    structures: { type: 'array', maxItems: 8, items: visualItemSchema },
    terrain: { type: 'array', maxItems: 8, items: visualItemSchema },
    hazards: { type: 'array', maxItems: 8, items: visualItemSchema },
    playerActivity: {
      type: 'object',
      properties: {
        visible: { type: 'boolean' },
        description: { type: 'string', maxLength: 160 },
        confidence: { type: 'number', minimum: 0, maximum: 1 }
      },
      required: ['visible', 'description', 'confidence'],
      additionalProperties: false
    },
    uncertainty: { type: 'array', maxItems: 8, items: { type: 'string', minLength: 1, maxLength: 160 } },
    notableChanges: { type: 'array', maxItems: 8, items: { type: 'string', minLength: 1, maxLength: 160 } }
  },
  required: ['sceneType', 'summary', 'salientObjects', 'structures', 'terrain', 'hazards', 'playerActivity', 'uncertainty', 'notableChanges'],
  additionalProperties: false
})

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function cleanText(value, name, maxLength, { allowEmpty = false } = {}) {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim()) || value.length > maxLength) {
    throw new Error(`${name} must be ${allowEmpty ? '0' : '1'} to ${maxLength} characters`)
  }
  return value.trim()
}

function validateItems(value, name, maxItems) {
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`${name} must contain at most ${maxItems} items`)
  return value.map((item, index) => {
    if (!isPlainObject(item) || Object.keys(item).some(key => !['label', 'region', 'confidence'].includes(key))) {
      throw new Error(`${name}[${index}] contains invalid fields`)
    }
    if (!REGIONS.includes(item.region)) throw new Error(`${name}[${index}].region is invalid`)
    if (!Number.isFinite(item.confidence) || item.confidence < 0 || item.confidence > 1) throw new Error(`${name}[${index}].confidence is invalid`)
    return Object.freeze({ label: cleanText(item.label, `${name}[${index}].label`, 80), region: item.region, confidence: item.confidence })
  })
}

function validateVisualObservation(value) {
  if (!isPlainObject(value)) throw new Error('Visual observation must be an object')
  const allowed = ['sceneType', 'summary', 'salientObjects', 'structures', 'terrain', 'hazards', 'playerActivity', 'uncertainty', 'notableChanges']
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error('Visual observation contains unexpected fields')
  if (!SCENE_TYPES.includes(value.sceneType)) throw new Error('sceneType is invalid')
  if (!isPlainObject(value.playerActivity) || Object.keys(value.playerActivity).some(key => !['visible', 'description', 'confidence'].includes(key))) {
    throw new Error('playerActivity is invalid')
  }
  if (typeof value.playerActivity.visible !== 'boolean') throw new Error('playerActivity.visible must be boolean')
  if (!Number.isFinite(value.playerActivity.confidence) || value.playerActivity.confidence < 0 || value.playerActivity.confidence > 1) {
    throw new Error('playerActivity.confidence is invalid')
  }
  const strings = (items, name) => {
    if (!Array.isArray(items) || items.length > 8) throw new Error(`${name} must contain at most 8 items`)
    return items.map((item, index) => cleanText(item, `${name}[${index}]`, 160))
  }
  return Object.freeze({
    sceneType: value.sceneType,
    summary: cleanText(value.summary, 'summary', 300),
    salientObjects: validateItems(value.salientObjects, 'salientObjects', 10),
    structures: validateItems(value.structures, 'structures', 8),
    terrain: validateItems(value.terrain, 'terrain', 8),
    hazards: validateItems(value.hazards, 'hazards', 8),
    playerActivity: Object.freeze({
      visible: value.playerActivity.visible,
      description: cleanText(value.playerActivity.description, 'playerActivity.description', 160, { allowEmpty: true }),
      confidence: value.playerActivity.confidence
    }),
    uncertainty: strings(value.uncertainty, 'uncertainty'),
    notableChanges: strings(value.notableChanges, 'notableChanges')
  })
}

module.exports = { VISUAL_SOURCES, SCENE_TYPES, REGIONS, VISUAL_OBSERVATION_SCHEMA, validateVisualObservation }
