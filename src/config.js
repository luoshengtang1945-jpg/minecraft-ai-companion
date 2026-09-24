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
    timeoutMs: numberFromEnv('OLLAMA_TIMEOUT_MS', 120000, { min: 1000 }),
    responseRetries: numberFromEnv('OLLAMA_RESPONSE_RETRIES', 2, { min: 0, max: 5 }),
    retryBackoffMs: numberFromEnv('OLLAMA_RETRY_BACKOFF_MS', 250, { min: 0, max: 5000 }),
    think: booleanFromEnv('OLLAMA_THINK', false),
    debug: booleanFromEnv('OLLAMA_DEBUG', false),
    debugRawMaxChars: numberFromEnv('OLLAMA_DEBUG_RAW_MAX_CHARS', 2000, { min: 100, max: 10000 })
  },
  survival: {
    initialCombatMode: combatModeFromEnv(),
    tickMs: numberFromEnv('SURVIVAL_TICK_MS', 150, { min: 50 }),
    detectionRange: numberFromEnv('HOSTILE_DETECTION_RANGE', 10, { min: 3 }),
    defenseRange: numberFromEnv('PLAYER_DEFENSE_RANGE', 8, { min: 2 }),
    immediateDangerRange: numberFromEnv('IMMEDIATE_DANGER_RANGE', 3.5, { min: 2, max: 8 }),
    defenseMemoryMs: numberFromEnv('DEFENSE_MEMORY_MS', 5000, { min: 500 }),
    attackOrderMs: numberFromEnv('ATTACK_ORDER_MS', 15000, { min: 1000 }),
    maxPursuitMs: numberFromEnv('COMBAT_MAX_PURSUIT_MS', 8000, { min: 1000, max: 30000 }),
    maxPursuitDistance: numberFromEnv('COMBAT_MAX_PURSUIT_DISTANCE', 6, { min: 2, max: 16 }),
    playerLeash: numberFromEnv('COMBAT_PLAYER_LEASH', 8, { min: 3, max: 24 }),
    pursuitCooldownMs: numberFromEnv('COMBAT_PURSUIT_COOLDOWN_MS', 10000, { min: 1000 }),
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
    moveTimeoutMs: numberFromEnv('AUTONOMY_MOVE_TIMEOUT_MS', 45000, { min: 10000, max: 120000 }),
    moveCooldownMs: numberFromEnv('AUTONOMY_MOVE_COOLDOWN_MS', 90000, { min: 0, max: 600000 }),
    followDurationMs: numberFromEnv('AUTONOMY_FOLLOW_DURATION_MS', 120000, { min: 30000, max: 600000 }),
    followCooldownMs: numberFromEnv('AUTONOMY_FOLLOW_COOLDOWN_MS', 180000, { min: 0, max: 1200000 }),
    taskLearningEnabled: booleanFromEnv('AUTONOMOUS_LEARNING_ENABLED', false),
    taskMaxEpisodes: numberFromEnv('AUTONOMOUS_LEARNING_MAX_EPISODES', 1, { min: 1, max: 5 }),
    taskMinHealth: numberFromEnv('AUTONOMOUS_LEARNING_MIN_HEALTH', 12, { min: 1, max: 20 }),
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
  companionship: {
    enabled: booleanFromEnv('AUTO_ACCOMPANY_ENABLED', false),
    delayMs: numberFromEnv('AUTO_ACCOMPANY_DELAY_MS', 3500, { min: 1000, max: 30000 }),
    range: numberFromEnv('AUTO_ACCOMPANY_RANGE', 16, { min: 3, max: 24 })
  },
  learning: {
    enabled: booleanFromEnv('LEARNING_ENABLED', false),
    startDelayMs: numberFromEnv('LEARNING_START_DELAY_MS', 5000, { min: 500 }),
    maxActions: numberFromEnv('LEARNING_MAX_ACTIONS', 20, { min: 1, max: 100 }),
    maxDurationMs: numberFromEnv('LEARNING_MAX_DURATION_MS', 180000, { min: 10000, max: 1800000 }),
    repeatedActionLimit: numberFromEnv('LEARNING_REPEAT_LIMIT', 3, { min: 2, max: 10 }),
    observationRange: numberFromEnv('LEARNING_OBSERVATION_RANGE', 8, { min: 3, max: 16 }),
    exploreRadius: numberFromEnv('LEARNING_EXPLORE_RADIUS', 16, { min: 8, max: 32 }),
    moveTimeoutMs: numberFromEnv('LEARNING_MOVE_TIMEOUT_MS', 20000, { min: 1000, max: 120000 }),
    observationSettleMs: numberFromEnv('LEARNING_OBSERVATION_SETTLE_MS', 300, { min: 0, max: 1500 }),
    memoryFile: path.resolve(process.cwd(), process.env.LEARNING_MEMORY_FILE || 'learning-memory/memory.json')
  },
  vision: {
    enabled: booleanFromEnv('VISION_ENABLED', false),
    bridgeHost: process.env.VISION_BRIDGE_HOST || '127.0.0.1',
    bridgePort: numberFromEnv('VISION_BRIDGE_PORT', 32145, { min: 1024, max: 65535 }),
    bridgeToken: process.env.VISION_BRIDGE_TOKEN || '',
    maxFrameBytes: numberFromEnv('VISION_MAX_FRAME_BYTES', 2000000, { min: 65536, max: 8000000 }),
    maxWidth: numberFromEnv('VISION_MAX_WIDTH', 1280, { min: 160, max: 3840 }),
    maxHeight: numberFromEnv('VISION_MAX_HEIGHT', 720, { min: 90, max: 2160 }),
    frameMaxAgeMs: numberFromEnv('VISION_FRAME_MAX_AGE_MS', 15000, { min: 1000, max: 120000 }),
    freshFrameMs: numberFromEnv('VISION_FRESH_FRAME_MS', 5000, { min: 500, max: 30000 }),
    backgroundIntervalMs: numberFromEnv('VISION_BACKGROUND_INTERVAL_MS', 45000, { min: 5000 }),
    backgroundCooldownMs: numberFromEnv('VISION_BACKGROUND_COOLDOWN_MS', 30000, { min: 5000 }),
    eventMinGapMs: numberFromEnv('VISION_EVENT_MIN_GAP_MS', 15000, { min: 1000 }),
    changeThreshold: numberFromEnv('VISION_CHANGE_THRESHOLD', 0.2, { min: 0.01, max: 1 }),
    visualTtlMs: numberFromEnv('VISION_OBSERVATION_TTL_MS', 30000, { min: 1000, max: 300000 }),
    debugSaveFrames: booleanFromEnv('VISION_DEBUG_SAVE_FRAMES', false),
    debugMaxFrames: numberFromEnv('VISION_DEBUG_MAX_FRAMES', 5, { min: 1, max: 50 }),
    debugDirectory: path.resolve(process.cwd(), process.env.VISION_DEBUG_DIRECTORY || 'vision-debug')
  },
  messages: {
    spawn: process.env.SPAWN_MESSAGE || ''
  }
}
