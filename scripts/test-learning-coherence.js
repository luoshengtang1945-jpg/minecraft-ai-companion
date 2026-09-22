const path = require('node:path')
const dotenv = require('dotenv')
const { LearningOllamaClient } = require('../src/learning')

dotenv.config({ path: path.resolve(process.cwd(), '.env'), quiet: true })

function countOption() {
  const raw = process.argv.find(argument => argument.startsWith('--count='))?.split('=')[1]
  const count = raw === undefined ? 10 : Number(raw)
  if (!Number.isInteger(count) || count < 1) throw new Error('count must be a positive integer')
  return count
}

const ollama = {
  url: process.env.OLLAMA_URL || 'http://localhost:11434/api/chat',
  model: process.env.OLLAMA_MODEL || 'qwen3-vl:8b',
  timeoutMs: Number(process.env.OLLAMA_TIMEOUT_MS || 120000),
  responseRetries: Number(process.env.OLLAMA_RESPONSE_RETRIES || 2),
  retryBackoffMs: Number(process.env.OLLAMA_RETRY_BACKOFF_MS || 250),
  think: process.env.OLLAMA_THINK === 'true',
  debug: false
}

const unchangedObservation = {
  position: { x: 0, y: 64, z: 0 },
  health: 20,
  food: 20,
  inventory: {},
  inventoryDelta: {},
  nearbyBlocks: [
    { ref: 'block:0,63,0', name: 'stone', distance: 1 },
    { ref: 'block:1,64,0', name: 'dirt', distance: 1 }
  ],
  nearbyEntities: [],
  targetState: null,
  elapsedMs: 1000
}

const reflection = {
  reflection: 'The required item is not visible, and observing again returned the same local evidence.',
  lesson: 'Repeating OBSERVE in an unchanged area produced no new evidence.',
  nextApproach: 'Move into a less recently observed nearby region, then inspect the new observation.'
}

const attempts = [1, 2].map(index => ({
  index,
  observationBefore: unchangedObservation,
  action: { action: 'OBSERVE' },
  observationAfter: unchangedObservation,
  actionResult: { success: true, reason: 'OBSERVATION_CAPTURED' },
  evaluation: { status: 'NO_PROGRESS', reason: 'No objective-relevant change was observed' },
  reflection
}))

const context = {
  goal: {
    id: 'synthetic-coherence-check',
    pattern: 'obtain target_item',
    description: 'Obtain at least one target_item.',
    objective: { type: 'INVENTORY_AT_LEAST', item: 'target_item', count: 1 },
    source: 'AUTONOMOUS'
  },
  observation: unchangedObservation,
  attempts,
  learnedSkills: [],
  repetitionThreshold: 2,
  explorationState: {
    regionSize: 4,
    recentObservedRegions: [
      { region: '0,16,0', visits: 3, lastObservedStep: 3, position: { x: 0, y: 64, z: 0 } }
    ],
    recentExploredDestinations: [],
    recentBlockObservations: [
      { step: 3, region: '0,16,0', names: ['stone', 'dirt'], refs: ['block:0,63,0', 'block:1,64,0'] }
    ]
  }
}

async function main() {
  const count = countOption()
  const client = new LearningOllamaClient({ ollama })
  const choices = new Map()
  for (let trial = 1; trial <= count; trial += 1) {
    const decision = await client.decide(context)
    choices.set(decision.action, (choices.get(decision.action) || 0) + 1)
    console.log(`[COHERENCE] ${trial}/${count}: ${JSON.stringify(decision)}`)
  }
  const exploreCount = choices.get('EXPLORE') || 0
  console.log(`[COHERENCE] distribution: ${JSON.stringify(Object.fromEntries(choices))}`)
  if (exploreCount === 0) throw new Error('Model never selected EXPLORE after repeated no-progress observations')
  console.log(`[COHERENCE] PASS: EXPLORE selected ${exploreCount}/${count} trials`)
}

main().catch(error => {
  console.error(`[COHERENCE] FAIL ${error.status || error.name}: ${error.message}`)
  process.exitCode = 1
})
