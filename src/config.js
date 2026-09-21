const path = require('node:path')
const dotenv = require('dotenv')

dotenv.config({ path: path.resolve(process.cwd(), '.env'), quiet: true })

function numberFromEnv(name, fallback, { min = -Infinity, max = Infinity } = {}) {
  const raw = process.env[name]
  const value = raw === undefined || raw === '' ? fallback : Number(raw)

  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be a number between ${min} and ${max}`)
  }

  return value
}

function requiredPort() {
  if (!process.env.MC_PORT) {
    throw new Error('MC_PORT is required. Copy .env.example to .env and set the LAN server port.')
  }

  return numberFromEnv('MC_PORT', undefined, { min: 1, max: 65535 })
}

function combatModeFromEnv() {
  const mode = (process.env.COMBAT_MODE || 'DEFENSIVE').toUpperCase()
  if (!['PASSIVE', 'DEFENSIVE', 'AGGRESSIVE'].includes(mode)) {
    throw new Error('COMBAT_MODE must be PASSIVE, DEFENSIVE, or AGGRESSIVE')
  }
  return mode
}

function booleanFromEnv(name, fallback) {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  if (['true', '1', 'yes', 'on'].includes(raw.toLowerCase())) return true
  if (['false', '0', 'no', 'off'].includes(raw.toLowerCase())) return false
  throw new Error(`${name} must be true or false`)
}

module.exports = {
  minecraft: {
    host: process.env.MC_HOST || 'localhost',
    port: requiredPort(),
    username: process.env.MC_USERNAME || 'AI_Companion',
    auth: process.env.MC_AUTH || 'offline',
    version: process.env.MC_VERSION || '1.21.11'
  },
  ollama: {
    url: process.env.OLLAMA_URL || 'http://localhost:11434/api/chat',
    model: process.env.OLLAMA_MODEL || 'qwen3-vl:8b',
    timeoutMs: numberFromEnv('OLLAMA_TIMEOUT_MS', 120000, { min: 1000 })
  },
  survival: {
    initialCombatMode: combatModeFromEnv(),
    tickMs: numberFromEnv('SURVIVAL_TICK_MS', 150, { min: 50 }),
    detectionRange: numberFromEnv('HOSTILE_DETECTION_RANGE', 10, { min: 3 }),
    defenseRange: numberFromEnv('PLAYER_DEFENSE_RANGE', 8, { min: 2 }),
    immediateDangerRange: numberFromEnv('IMMEDIATE_DANGER_RANGE', 3.5, { min: 2, max: 8 }),
    defenseMemoryMs: numberFromEnv('DEFENSE_MEMORY_MS', 5000, { min: 500 }),
    attackOrderMs: numberFromEnv('ATTACK_ORDER_MS', 15000, { min: 1000 }),
    lowHealth: numberFromEnv('LOW_HEALTH_THRESHOLD', 8, { min: 1, max: 20 }),
    safeHealth: numberFromEnv('SAFE_HEALTH_THRESHOLD', 12, { min: 1, max: 20 }),
    retreatDistance: numberFromEnv('RETREAT_DISTANCE', 8, { min: 3 }),
    creeperDistance: numberFromEnv('CREEPER_SAFE_DISTANCE', 6, { min: 3 })
  },
  combat: {
    meleeRange: numberFromEnv('MELEE_RANGE', 3.1, { min: 2, max: 4 }),
    approachRange: numberFromEnv('MELEE_APPROACH_DISTANCE', 2.4, { min: 1, max: 3.5 })
  },
  autonomy: {
    enabled: booleanFromEnv('AUTONOMY_ENABLED', true),
    intervalMs: numberFromEnv('AUTONOMY_INTERVAL_MS', 30000, { min: 5000 }),
    eventMinGapMs: numberFromEnv('AUTONOMY_EVENT_MIN_GAP_MS', 10000, { min: 1000 }),
    speechCooldownMs: numberFromEnv('AUTONOMY_SPEECH_COOLDOWN_MS', 60000, { min: 5000 }),
    speechDedupMs: numberFromEnv('AUTONOMY_SPEECH_DEDUP_MS', 300000, { min: 10000 }),
    maxPlayerDistance: numberFromEnv('AUTONOMY_MAX_PLAYER_DISTANCE', 16, { min: 6, max: 32 }),
    wanderRadius: numberFromEnv('AUTONOMY_WANDER_RADIUS', 6, { min: 3, max: 12 }),
    exploreRadius: numberFromEnv('AUTONOMY_EXPLORE_RADIUS', 12, { min: 6, max: 24 }),
    summaryRange: numberFromEnv('AUTONOMY_SUMMARY_RANGE', 12, { min: 6, max: 32 }),
    resourceScanRange: numberFromEnv('AUTONOMY_RESOURCE_SCAN_RANGE', 10, { min: 4, max: 24 })
  },
  presence: {
    enabled: booleanFromEnv('PRESENCE_ENABLED', true),
    initialMinMs: numberFromEnv('PRESENCE_INITIAL_MIN_MS', 1200, { min: 250 }),
    initialMaxMs: numberFromEnv('PRESENCE_INITIAL_MAX_MS', 3000, { min: 500 }),
    intervalMinMs: numberFromEnv('PRESENCE_INTERVAL_MIN_MS', 10000, { min: 3000 }),
    intervalMaxMs: numberFromEnv('PRESENCE_INTERVAL_MAX_MS', 22000, { min: 5000 }),
    walkTimeoutMs: numberFromEnv('PRESENCE_WALK_TIMEOUT_MS', 8000, { min: 2000 }),
    maxPlayerDistance: numberFromEnv('AUTONOMY_MAX_PLAYER_DISTANCE', 16, { min: 6, max: 32 })
  },
  messages: {
    spawn: process.env.SPAWN_MESSAGE || '我回来了，这次我会保护好自己。'
  }
}
