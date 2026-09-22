const { requestStructured } = require('../ollama')
const { VISUAL_OBSERVATION_SCHEMA, validateVisualObservation } = require('./visual-observation')

const VISUAL_SYSTEM_PROMPT = `You are the visual perception component of a Minecraft companion.
Describe only what appears in the supplied Minecraft image. Do not plan gameplay and do not invent precise world coordinates.
Use regions (LEFT/CENTER/RIGHT/NEAR/MID/FAR/UNKNOWN), grounded confidence from 0 to 1, and explicit uncertainty.
Treat the hotbar, crosshair, first-person hand, chat, and other HUD elements as interface context, not world objects or proof that another player is visible. Be conservative when identifying mobs: name tags and blocky humanoid silhouettes may indicate a player or companion, and uncertain entity identity must be stated as uncertain rather than guessed.
The image perspective metadata is authoritative. HUMAN_CLIENT_CAMERA means this is a shared human-client view, not the Mineflayer bot's own eyes.
Return only the requested JSON schema.`

class VisionOllamaClient {
  constructor({ ollama, scheduler, logger, fetchFn = null }) {
    this.ollama = ollama
    this.scheduler = scheduler
    this.logger = logger
    this.fetchFn = fetchFn
  }

  async observe(frame, { kind, owner = 'vision', previousObservation = null, trigger = 'BACKGROUND' }) {
    const metadata = {
      perspective: frame.perspective,
      width: frame.width,
      height: frame.height,
      cameraPoseAvailable: Boolean(frame.camera),
      dimension: frame.dimension,
      trigger,
      previousObservation: previousObservation ? {
        sceneType: previousObservation.sceneType,
        summary: previousObservation.summary
      } : null
    }
    return await requestStructured({
      ollama: this.ollama,
      scheduler: this.scheduler,
      kind,
      owner,
      label: kind,
      messages: [
        { role: 'system', content: VISUAL_SYSTEM_PROMPT },
        { role: 'user', content: JSON.stringify(metadata), images: [frame.buffer.toString('base64')] }
      ],
      schema: VISUAL_OBSERVATION_SCHEMA,
      validate: validateVisualObservation,
      logger: this.logger,
      ...(this.fetchFn ? { fetchFn: this.fetchFn } : {})
    })
  }

  canStartBackground() {
    return !this.scheduler?.isBusy()
  }
}

module.exports = { VisionOllamaClient, VISUAL_SYSTEM_PROMPT }
