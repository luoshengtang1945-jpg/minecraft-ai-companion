const { requestStructured } = require('../ollama')
const { VISUAL_OBSERVATION_SCHEMA, validateVisualObservation } = require('./visual-observation')

const VISUAL_SYSTEM_PROMPT = `You are the visual perception component of a Minecraft companion.
Describe only what appears in the supplied Minecraft image. Do not plan gameplay and do not invent precise world coordinates.
Analyze this image independently. Never carry over objects or scenery from another frame. Keep summary to one sentence under 140 characters, without region tags, confidence numbers, or a list. If an object is too small or unclear to identify, omit it from the summary and give it low confidence if listed at all.
For a clearly visible block whose exact material is uncertain, describe its observable color and shape instead of guessing a Minecraft block name. Do not omit a prominent colored block merely because its material is uncertain.
Use regions (LEFT/CENTER/RIGHT/NEAR/MID/FAR/UNKNOWN), grounded confidence from 0 to 1, and explicit uncertainty.
Treat the hotbar, crosshair, first-person hand, chat, and other HUD elements as interface context, not world objects or proof that another player is visible. Be conservative when identifying mobs: name tags and blocky humanoid silhouettes may indicate a player or companion, and uncertain entity identity must be stated as uncertain rather than guessed.
The image perspective and dimension metadata are authoritative. HUMAN_CLIENT_CAMERA is the human client's shared view. COMPANION_CAMERA is an off-screen render from the companion's loaded remote player entity and may omit unloaded chunks; it is not proof of exact block coordinates or actions. A dark overworld image is not the Nether. Your confidence is not independent verification: small or distant animals, creatures, and structures should be marked uncertain unless visually unmistakable; never invent an animal's accessories.
Return only the requested JSON schema.`

class VisionOllamaClient {
  constructor({ ollama, scheduler, logger, fetchFn = null }) {
    this.ollama = ollama
    this.scheduler = scheduler
    this.logger = logger
    this.fetchFn = fetchFn
  }

  async observe(frame, { kind, owner = 'vision', trigger = 'BACKGROUND' }) {
    const metadata = {
      perspective: frame.perspective,
      width: frame.width,
      height: frame.height,
      cameraPoseAvailable: Boolean(frame.camera),
      dimension: frame.dimension,
      trigger
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
