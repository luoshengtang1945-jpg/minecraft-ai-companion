const path = require('node:path')
const dotenv = require('dotenv')
const { LearningOllamaClient } = require('../src/learning')
const { createItemGoal, ITEM_NAME } = require('../src/learning/item-goal')
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
const item = process.argv.find(argument => argument.startsWith('--item='))?.slice('--item='.length) || 'oak_log'
const expectedAction = process.argv.find(argument => argument.startsWith('--expect='))?.slice('--expect='.length) || null
if (!ITEM_NAME.test(item)) throw new Error('item must be a Minecraft-style symbolic name')
if (process.argv.includes('--after-move') && process.argv.includes('--already-near')) {
  throw new Error('Choose only one synthetic movement outcome')
}
if ((process.argv.includes('--after-dig') || process.argv.includes('--after-item-move') ||
     process.argv.includes('--after-look-item')) &&
    (process.argv.includes('--after-move') || process.argv.includes('--already-near'))) {
  throw new Error('Choose only one synthetic movement outcome')
}
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
  goal: createItemGoal(item),
  observation: {
    position: { x: 0, y: 64, z: 0 },
    health: 20,
    inventory: {},
    inventoryDelta: {},
    nearbyBlocks: [
      { ref: 'block:3,64,0', name: item, distance: 3 },
      { ref: 'block:2,63,0', name: 'grass_block', distance: 2.2 }
    ],
    nearbyEntities: [],
    targetState: null,
    elapsedMs: 0
  },
  attempts: [],
  learnedSkills: []
}

if (process.argv.includes('--after-move')) {
  context.observation.position = { x: 2, y: 64, z: 0 }
  context.observation.nearbyBlocks[0].distance = 1
  context.observation.elapsedMs = 5000
  context.attempts.push({
    action: { action: 'MOVE_NEAR', target: 'block:3,64,0', distance: 3 },
    actionResult: { success: true, reason: 'REACHED_TARGET' },
    evaluation: { status: 'NO_PROGRESS', reason: 'OBJECTIVE_NOT_YET_MET' },
    reflection: {
      reflection: 'The position changed and the observed target is now closer, but inventory did not change.',
      lesson: 'Movement alone did not satisfy the item objective.',
      nextApproach: 'Try a materially different primitive with an observed target and check the inventory result.'
    }
  })
}

if (process.argv.includes('--already-near')) {
  context.observation.elapsedMs = 500
  context.attempts.push({
    action: { action: 'MOVE_NEAR', target: 'block:3,64,0', distance: 3 },
    actionResult: { success: true, reason: 'ALREADY_NEAR_TARGET' },
    evaluation: { status: 'NO_PROGRESS', reason: 'OBJECTIVE_NOT_YET_MET' },
    reflection: {
      reflection: 'The requested proximity was already satisfied; position and inventory did not change.',
      lesson: 'The same move request would not add new evidence.',
      nextApproach: 'Change the movement parameter or try another primitive that uses the observed target.'
    }
  })
}

if (process.argv.includes('--after-dig') || process.argv.includes('--after-item-move') ||
    process.argv.includes('--after-look-item')) {
  context.observation.elapsedMs = 5000
  context.observation.nearbyBlocks = [{ ref: 'block:2,63,0', name: 'grass_block', distance: 2.2 }]
  context.observation.nearbyEntities = [
    { ref: 'entity:7', name: 'item', type: 'other', position: { x: 3, y: 64, z: 0 },
      distance: 3, droppedItem: { name: item, count: 1 } }
  ]
  context.observation.targetState = { ref: 'block:3,64,0', exists: false }
  context.attempts.push({
    action: { action: 'DIG_BLOCK', target: 'block:3,64,0' },
    actionResult: { success: true, reason: 'DIG_COMPLETED' },
    evaluation: { status: 'PARTIAL_PROGRESS', reason: 'Target block changed; inventory objective not yet met' },
    reflection: null
  })
  if (process.argv.includes('--after-item-move') || process.argv.includes('--after-look-item')) {
    context.attempts.push({
      action: { action: 'MOVE_NEAR', target: 'entity:7', distance: 3 },
      actionResult: { success: true, reason: 'ALREADY_NEAR_TARGET' },
      evaluation: { status: 'NO_PROGRESS', reason: 'OBJECTIVE_NOT_YET_MET' },
      reflection: {
        reflection: 'The dropped item remains at the same distance; the requested proximity was already satisfied.',
        lesson: 'The previous move radius caused no position or inventory change.',
        nextApproach: 'Adjust the radius or choose another valid primitive based on the observed item.'
      }
    })
  }
  if (process.argv.includes('--after-look-item')) {
    context.attempts.push({
      action: { action: 'LOOK_AT', target: 'entity:7' },
      actionResult: { success: true, reason: 'LOOKED_AT_TARGET' },
      evaluation: { status: 'NO_PROGRESS', reason: 'OBJECTIVE_NOT_YET_MET' },
      reflection: {
        reflection: 'Looking changed orientation only; position and inventory stayed the same.',
        lesson: 'The dropped item is still observed at the same distance.',
        nextApproach: 'Use a different primitive that can change distance or inventory.'
      }
    })
  }
}

async function main() {
  const logger = createLogger()
  const client = new LearningOllamaClient({ ollama, logger })
  const startedAt = Date.now()
  for (let index = 1; index <= count; index += 1) {
    const decision = await client.decide(context)
    if (expectedAction && decision.action !== expectedAction) {
      throw new Error(`Expected ${expectedAction}, received ${decision.action} on decision ${index}/${count}`)
    }
    console.log(`[SMOKE] ${index}/${count} valid: ${JSON.stringify(decision)}`)
  }
  console.log(`[SMOKE] PASS ${count}/${count} structured learning decisions in ${Date.now() - startedAt}ms`)
}

main().catch(error => {
  console.error(`[SMOKE] FAIL ${error.status || error.name}: ${error.message}`)
  if (error.details) console.error('[SMOKE] metadata:', error.details)
  process.exitCode = 1
})
