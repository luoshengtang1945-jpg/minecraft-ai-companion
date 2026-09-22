const path = require('node:path')
const dotenv = require('dotenv')
const { LearningOllamaClient } = require('../src/learning')
const { createLogger } = require('../src/logger')

dotenv.config({ path: path.resolve(process.cwd(), '.env'), quiet: true })

function numberOption(name, fallback) {
  const prefix = `--${name}=`
  const raw = process.argv.find(argument => argument.startsWith(prefix))?.slice(prefix.length)
  const value = raw === undefined ? fallback : Number(raw)
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`)
  return value
}

const count = numberOption('count', 1)
const ollama = {
  url: process.env.OLLAMA_URL || 'http://localhost:11434/api/chat',
  model: process.env.OLLAMA_MODEL || 'qwen3-vl:8b',
  timeoutMs: Number(process.env.OLLAMA_TIMEOUT_MS || 120000),
  responseRetries: Number(process.env.OLLAMA_RESPONSE_RETRIES || 2),
  retryBackoffMs: Number(process.env.OLLAMA_RETRY_BACKOFF_MS || 250),
  think: process.env.OLLAMA_THINK === 'true',
  debug: process.env.OLLAMA_DEBUG === 'true',
  debugRawMaxChars: Number(process.env.OLLAMA_DEBUG_RAW_MAX_CHARS || 2000)
}

const context = {
  goal: {
    id: 'obtain-oak-log',
    pattern: 'obtain oak_log',
    description: 'Obtain at least one oak_log.',
    objective: { type: 'INVENTORY_AT_LEAST', item: 'oak_log', count: 1 },
    source: 'AUTONOMOUS'
  },
  observation: {
    position: { x: 0, y: 64, z: 0 },
    health: 20,
    inventory: {},
    inventoryDelta: {},
    nearbyBlocks: [
      { ref: 'block:3,64,0', name: 'oak_log', distance: 3 },
      { ref: 'block:2,63,0', name: 'grass_block', distance: 2.2 }
    ],
    nearbyEntities: [],
    targetState: null,
    elapsedMs: 0
  },
  attempts: [],
  learnedSkills: []
}

async function main() {
  const logger = createLogger()
  const client = new LearningOllamaClient({ ollama, logger })
  const startedAt = Date.now()
  for (let index = 1; index <= count; index += 1) {
    const decision = await client.decide(context)
    console.log(`[SMOKE] ${index}/${count} valid: ${JSON.stringify(decision)}`)
  }
  console.log(`[SMOKE] PASS ${count}/${count} structured learning decisions in ${Date.now() - startedAt}ms`)
}

main().catch(error => {
  console.error(`[SMOKE] FAIL ${error.status || error.name}: ${error.message}`)
  if (error.details) console.error('[SMOKE] metadata:', error.details)
  process.exitCode = 1
})
