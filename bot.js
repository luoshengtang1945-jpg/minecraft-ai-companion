const mineflayer = require('mineflayer')
const { pathfinder, Movements } = require('mineflayer-pathfinder')

const config = require('./src/config')
const { createLogger } = require('./src/logger')
const { CompanionSessionContext } = require('./src/companion/session-context')
const { sendSpawnGreeting } = require('./src/companion/spawn-greeting')
const { ArrivalController } = require('./src/companion/arrival-controller')
const { RestController } = require('./src/companion/rest-controller')
const { createAgent } = require('./src/agent')
const { MovementController } = require('./src/skills')
const { CombatController } = require('./src/combat')
const { SurvivalController } = require('./src/survival')
const { GoalManager } = require('./src/goals')
const {
  AutonomyController,
  AutonomyOllamaClient,
  AutonomousActionRegistry,
  SpeechController,
  WorldStateBuilder,
  EventJournal
} = require('./src/autonomy')
const { personality } = require('./src/personality')
const { PresenceController } = require('./src/presence')
const { OllamaRequestScheduler } = require('./src/ollama')
const {
  FrameStore,
  VisionFrameServer,
  MultimodalWorldModel,
  VisionOllamaClient,
  VisualPerceptionController
} = require('./src/vision')
const {
  LearningController,
  LearningObservationBuilder,
  PrimitiveActionExecutor,
  LearningMemoryStore,
  LearningOllamaClient
} = require('./src/learning')

const logger = createLogger()
const bot = mineflayer.createBot(config.minecraft)
const ollamaScheduler = new OllamaRequestScheduler()

bot.loadPlugin(pathfinder)

const goalManager = new GoalManager()
const journal = new EventJournal()
const visualWorldModel = new MultimodalWorldModel({ visualTtlMs: config.vision.visualTtlMs })
const visionFrames = new FrameStore({
  maxBytes: config.vision.maxFrameBytes,
  maxWidth: config.vision.maxWidth,
  maxHeight: config.vision.maxHeight,
  maxAgeMs: config.vision.frameMaxAgeMs
})
const visionClient = new VisionOllamaClient({ ollama: config.ollama, scheduler: ollamaScheduler, logger })
const vision = new VisualPerceptionController({
  frameStore: visionFrames,
  client: visionClient,
  worldModel: visualWorldModel,
  logger,
  config: config.vision
})
const visionBridge = new VisionFrameServer({
  host: config.vision.bridgeHost,
  port: config.vision.bridgePort,
  token: config.vision.bridgeToken,
  frameStore: visionFrames,
  logger,
  maxBytes: config.vision.maxFrameBytes,
  onFrame: frame => vision.onFrame(frame)
})
const movement = new MovementController(bot, { logger, goalManager })
const companionSession = new CompanionSessionContext({ bot, movement })
const combat = new CombatController(bot, { movement, logger, config: config.combat })
const survival = new SurvivalController(bot, {
  combat,
  movement,
  logger,
  config: config.survival,
  goalManager,
  journal
})
const speech = new SpeechController(bot, {
  session: companionSession,
  cooldownMs: config.autonomy.speechCooldownMs,
  dedupMs: config.autonomy.speechDedupMs,
  logger
})
const worldState = new WorldStateBuilder({
  session: companionSession,
  bot,
  movement,
  survival,
  goalManager,
  journal,
  config: config.autonomy
})
const autonomyClient = new AutonomyOllamaClient({ ollama: config.ollama, personality, scheduler: ollamaScheduler, logger })
const autonomousActions = new AutonomousActionRegistry({
  bot,
  movement,
  goalManager,
  speech,
  journal,
  logger,
  config: config.autonomy
})
const autonomy = new AutonomyController({
  bot,
  worldState,
  client: autonomyClient,
  actions: autonomousActions,
  movement,
  goalManager,
  journal,
  logger,
  config: config.autonomy
})
const learningObserver = new LearningObservationBuilder({
  bot,
  range: config.learning.observationRange,
  worldModel: visualWorldModel,
  recentEvents: () => journal.recent()
})
const learningMemory = new LearningMemoryStore({ filePath: config.learning.memoryFile })
const learningClient = new LearningOllamaClient({ ollama: config.ollama, scheduler: ollamaScheduler, logger })
const learningExecutor = new PrimitiveActionExecutor({
  bot,
  movement,
  observer: learningObserver,
  survival,
  speech,
  vision,
  moveTimeoutMs: config.learning.moveTimeoutMs
})
const learning = new LearningController({
  movement,
  goalManager,
  observer: learningObserver,
  executor: learningExecutor,
  client: learningClient,
  memory: learningMemory,
  autonomy,
  logger,
  config: config.learning
})
const presence = new PresenceController({
  bot,
  movement,
  logger,
  config: config.presence
})
const agent = createAgent({
  rest: new RestController({ bot, movement, survival, logger, session: companionSession }),
  session: companionSession,
  bot,
  movement,
  survival,
  autonomy,
  learning,
  vision,
  visualWorldModel,
  scheduler: ollamaScheduler,
  logger,
  config: config.ollama
})

const arrival = new ArrivalController({ bot, movement, logger, config: config.companionship })
bot.once('spawn', () => {
  movement.initialize(new Movements(bot))
  companionSession.start()
  survival.start()
  agent.start()
  autonomy.start()
  presence.start()
  arrival.start()
  if (config.vision.enabled) {
    void visionBridge.start().then(() => vision.start()).catch(error => logger.error('[VISION] bridge failed to start', error))
  }
  void learning.start().catch(error => logger.error('Learning Agent failed to start', error))

  logger.info('AI Companion joined Minecraft')
  logger.info('Movement and survival controllers started')
  sendSpawnGreeting({ bot, session: companionSession, override: config.messages.spawn })
})

bot.on('goal_reached', () => movement.handleGoalReached())

bot.on('path_update', result => {
  if (result.status === 'noPath') {
    logger.throttled('no-path', 5000, 'warn', 'No path to current goal')
  }
})

bot.on('kicked', reason => logger.error('Kicked from server', reason))
bot.on('error', error => logger.error('Mineflayer error', error))

bot.once('end', () => {
  arrival.stop()
  companionSession.stop()
  learning.stop()
  presence.stop()
  autonomy.stop()
  agent.stop()
  survival.stop()
  vision.stop()
  void visionBridge.stop()
  logger.info('Disconnected from Minecraft')
})
