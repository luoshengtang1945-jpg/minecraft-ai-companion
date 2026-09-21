const mineflayer = require('mineflayer')
const { pathfinder, Movements } = require('mineflayer-pathfinder')

const config = require('./src/config')
const { createLogger } = require('./src/logger')
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

const logger = createLogger()
const bot = mineflayer.createBot(config.minecraft)

bot.loadPlugin(pathfinder)

const goalManager = new GoalManager()
const journal = new EventJournal()
const movement = new MovementController(bot, { logger, goalManager })
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
  cooldownMs: config.autonomy.speechCooldownMs,
  dedupMs: config.autonomy.speechDedupMs,
  logger
})
const worldState = new WorldStateBuilder({
  bot,
  movement,
  survival,
  goalManager,
  journal,
  config: config.autonomy
})
const autonomyClient = new AutonomyOllamaClient({ ollama: config.ollama, personality })
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
const presence = new PresenceController({
  bot,
  movement,
  logger,
  config: config.presence
})
const agent = createAgent({ bot, movement, survival, autonomy, logger, config: config.ollama })

bot.once('spawn', () => {
  movement.initialize(new Movements(bot))
  survival.start()
  agent.start()
  autonomy.start()
  presence.start()

  logger.info('AI Companion joined Minecraft')
  logger.info('Movement and survival controllers started')
  bot.chat(config.messages.spawn)
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
  presence.stop()
  autonomy.stop()
  agent.stop()
  survival.stop()
  logger.info('Disconnected from Minecraft')
})
