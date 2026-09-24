// Direct local-model check of autonomous decision parsing and outcome feedback.
// No Minecraft connection or movement is started by this script.
const path = require('node:path')
const dotenv = require('dotenv')
const { AutonomyOllamaClient } = require('../src/autonomy')
const { personality } = require('../src/personality')
const { createLogger } = require('../src/logger')

dotenv.config({ path: path.resolve(process.cwd(), '.env'), quiet: true })

const ollama = {
  url: process.env.OLLAMA_URL || 'http://localhost:11434/api/chat',
  model: process.env.OLLAMA_MODEL || 'qwen3-vl:8b',
  timeoutMs: Number(process.env.OLLAMA_TIMEOUT_MS || 120000),
  responseRetries: Number(process.env.OLLAMA_RESPONSE_RETRIES || 2),
  retryBackoffMs: Number(process.env.OLLAMA_RETRY_BACKOFF_MS || 250),
  think: process.env.OLLAMA_THINK === 'true',
  debug: false
}

const state = {
  autonomyTrigger: 'goal_finished',
  companion: { position: { x: 0, y: 64, z: 0 }, health: 20, food: 20 },
  player: { username: 'Player', position: { x: 4, y: 64, z: 0 }, distance: 4, moving: false, activity: 'standing' },
  world: { timeOfDay: 6000, day: 1, isDay: true, raining: false },
  combatMode: 'DEFENSIVE',
  behavior: { type: 'STOP', source: null, locomotionOwner: 'NONE' },
  companionSession: { speech: { eligible: false, quietSeconds: 0 }, recentDialogue: [] },
  nearbyEntities: { hostile: [], passive: [] },
  usefulBlocks: [], inventory: [], recentEvents: [], currentGoal: null,
  recentAutonomousOutcomes: [
    { action: 'EXPLORE_NEARBY', outcome: 'FAILED', reason: 'NO_PATH', at: Date.now() }
  ],
  freeIdleStreak: 2
}

const scenario = process.argv.find(argument => argument.startsWith('--scenario='))?.split('=')[1] || 'failed'
if (scenario === 'free') {
  state.autonomyTrigger = 'interval'
  state.recentAutonomousOutcomes = []
  state.freeIdleStreak = 2
  state.recentEvents = [
    { at: Date.now() - 60000, type: 'autonomy_decision', detail: 'IDLE:IDLE' },
    { at: Date.now() - 30000, type: 'autonomy_decision', detail: 'IDLE:IDLE' }
  ]
} else if (scenario === 'completed') {
  state.freeIdleStreak = 0
  state.autonomousMoveCooldownMs = 30000
  state.recentAutonomousOutcomes = [
    { action: 'WANDER_NEAR_PLAYER', outcome: 'COMPLETED', reason: 'GOAL_REACHED', at: Date.now() - 60000 }
  ]
} else if (scenario === 'task') {
  const item = process.argv.find(argument => argument.startsWith('--item='))?.split('=')[1] || null
  if (item && !/^[a-z0-9_]{1,64}$/.test(item)) throw new Error('--item must be a valid Minecraft item name')
  state.autonomyTrigger = 'interval'
  state.recentAutonomousOutcomes = []
  state.freeIdleStreak = 2
  state.usefulBlocks = item ? [`${item}x2`] : ['birch_logx2', 'oak_logx3']
  state.availableTaskItems = item ? [item] : ['birch_log', 'oak_log']
} else if (scenario !== 'failed') {
  throw new Error('scenario must be failed, free, completed, or task')
}

async function main() {
  const requested = Number(process.argv.find(argument => argument.startsWith('--count='))?.split('=')[1] || 1)
  if (!Number.isInteger(requested) || requested < 1 || requested > 20) throw new Error('--count must be an integer from 1 to 20')
  const client = new AutonomyOllamaClient({
    ollama, personality, logger: createLogger(), autonomousTasksEnabled: scenario === 'task'
  })
  const counts = {}
  for (let index = 0; index < requested; index += 1) {
    const decision = await client.decide(state)
    if (scenario === 'task' && decision.action === 'TRY_OBTAIN_ITEM' &&
        !state.availableTaskItems.includes(decision.goalItem)) {
      throw new Error(`Model proposed an unobserved item: ${decision.goalItem}`)
    }
    counts[decision.action] = (counts[decision.action] || 0) + 1
    console.log(`[SMOKE] Valid autonomy decision ${index + 1}/${requested} (${scenario}): ${JSON.stringify(decision)}`)
  }
  console.log(`[SMOKE] ${requested}/${requested} structured decisions valid; actions=${JSON.stringify(counts)}`)
}

main().catch(error => {
  console.error(`[SMOKE] FAIL ${error.status || error.name}: ${error.message}`)
  process.exitCode = 1
})
