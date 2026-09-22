const { validatePrimitiveAction } = require('./action-schema')
const { LEARNING_SYSTEM_PROMPT, REFLECTION_SYSTEM_PROMPT, decisionPayload } = require('./prompt')
const { requestStructured, LEARNING_ACTION_SCHEMA, REFLECTION_SCHEMA } = require('../ollama')

function validateReflection(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Reflection must be a JSON object')
  const keys = ['reflection', 'lesson', 'nextApproach']
  if (Object.keys(value).some(key => !keys.includes(key))) throw new Error('Unexpected reflection fields')
  for (const key of keys) {
    if (typeof value[key] !== 'string' || !value[key].trim() || value[key].length > 500) {
      throw new Error(`Reflection ${key} must contain 1 to 500 characters`)
    }
  }
  return value
}

class LearningOllamaClient {
  constructor({ ollama, scheduler = null, logger = null, fetchFn = null }) {
    this.ollama = ollama
    this.scheduler = scheduler
    this.logger = logger
    this.fetchFn = fetchFn
    this.inferenceRunning = false
  }

  async decide(context) {
    // Controlled episodes need task reasoning priority even when auto-started.
    const kind = 'PLAYER_TASK_DECISION'
    return this.#infer(kind, 'LEARNING decision', LEARNING_SYSTEM_PROMPT, decisionPayload(context), LEARNING_ACTION_SCHEMA, validatePrimitiveAction)
  }

  async reflect(attempt) {
    return this.#infer('LEARNING_REFLECTION', 'LEARNING reflection', REFLECTION_SYSTEM_PROMPT, attempt, REFLECTION_SCHEMA, validateReflection)
  }

  cancelPending() {
    return this.scheduler?.cancelOwner('learning') || 0
  }

  async #infer(kind, label, system, payload, schema, validate) {
    if (this.inferenceRunning) throw new Error('Learning inference already running')
    this.inferenceRunning = true
    try {
      return await requestStructured({
        ollama: this.ollama,
        scheduler: this.scheduler,
        kind,
        owner: 'learning',
        label,
        system,
        payload,
        schema,
        validate,
        logger: this.logger,
        ...(this.fetchFn ? { fetchFn: this.fetchFn } : {})
      })
    } finally {
      this.inferenceRunning = false
    }
  }
}

module.exports = { LearningOllamaClient, validateReflection }
