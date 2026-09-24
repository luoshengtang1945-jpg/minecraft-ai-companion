// Read-only diagnostic: send one saved companion frame to the configured model.
const fs = require('node:fs/promises')
const path = require('node:path')
const dotenv = require('dotenv')
const { VisionOllamaClient } = require('../src/vision/ollama-client')
const { guardVisualObservation } = require('../src/vision/observation-guard')

dotenv.config({ path: path.resolve(process.cwd(), '.env'), quiet: true })

async function main() {
  const pngPath = process.argv[2]
  if (!pngPath || path.extname(pngPath).toLowerCase() !== '.png') throw new Error('Usage: node scripts/diagnose-vision-frame.js <saved-frame.png>')
  const json = JSON.parse(await fs.readFile(pngPath.slice(0, -4) + '.json', 'utf8'))
  const frame = { ...json.frame, buffer: await fs.readFile(pngPath) }
  const client = new VisionOllamaClient({ ollama: {
    url: process.env.OLLAMA_URL || 'http://localhost:11434/api/chat',
    model: process.env.OLLAMA_MODEL || 'qwen3-vl:8b',
    timeoutMs: Number(process.env.OLLAMA_TIMEOUT_MS || 120000),
    responseRetries: 0,
    think: false
  } })
  const observation = await client.observe(frame, { kind: 'PLAYER_VISUAL_PERCEPTION', trigger: 'DIAGNOSTIC' })
  const guarded = guardVisualObservation(observation, frame)
  console.log(JSON.stringify({ frameId: frame.id, dimension: frame.dimension, model: process.env.OLLAMA_MODEL || 'qwen3-vl:8b',
    rawScene: observation.sceneType, rawSummary: observation.summary, rawObjects: observation.salientObjects,
    rejected: guarded.rejected, acceptedScene: guarded.observation.sceneType,
    acceptedObjects: guarded.observation.salientObjects }, null, 2))
}

main().catch(error => { console.error(error.message); process.exitCode = 1 })
