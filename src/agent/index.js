const { OllamaClient } = require('./ollama-client')
const { chatSafe } = require('./decision')
const { recognizeImmediateMovement } = require('./immediate-movement')

function createAgent({ bot, movement, survival, autonomy = null, logger, config }) {
  const client = new OllamaClient(config)
  let started = false
  let queue = Promise.resolve()

  const handleChat = async (username, message, context) => {
    try {
      logger.info(`Asking ${config.model} for an action`)
      const decision = await client.decide(username, message)
      logger.info(`Agent chose ${decision.action}`)

      const movementAction = ['FOLLOW', 'COME', 'STOP'].includes(decision.action)
      const staleMovement = movementAction && movement.getPlayerCommandEpoch() !== context.commandEpoch
      if (movementAction && !context.immediateAction && !staleMovement) {
        if (decision.action === 'FOLLOW') movement.follow(username)
        if (decision.action === 'COME') movement.come(username)
        if (decision.action === 'STOP') movement.stop()
      }
      if (staleMovement) logger.info(`Discarded stale player movement decision ${decision.action}`)
      if (decision.action === 'PASSIVE') survival.setCombatMode('PASSIVE')
      if (decision.action === 'DEFENSIVE') survival.setCombatMode('DEFENSIVE')
      if (decision.action === 'AGGRESSIVE') survival.setCombatMode('AGGRESSIVE')

      let responseText = decision.reply
      if (decision.action === 'ATTACK') {
        const result = survival.requestAttack(username)
        if (result.reason === 'PASSIVE') responseText = '我现在是被动模式，不会主动攻击。'
        if (result.reason === 'NO_TARGET') responseText = '我没看到可以攻击的目标。'
      }

      const reply = chatSafe(responseText)
      if (reply) bot.chat(reply)
    } catch (error) {
      logger.error('AI decision failed', error)
      bot.chat('等下，我脑子刚卡了一下。')
    }
  }

  const onChat = (username, message) => {
    if (username === bot.username) return

    logger.info(`[MC] ${username}: ${message}`)
    survival.observePlayer(username)
    autonomy?.observePlayer(username, message)

    const immediateAction = recognizeImmediateMovement(message)
    if (immediateAction === 'FOLLOW') movement.follow(username)
    if (immediateAction === 'COME') movement.come(username)
    if (immediateAction === 'STOP') movement.stop()

    const context = {
      immediateAction,
      commandEpoch: movement.getPlayerCommandEpoch()
    }
    queue = queue.then(() => handleChat(username, message, context))
  }

  return {
    start() {
      if (started) return
      started = true
      bot.on('chat', onChat)
    },
    stop() {
      if (!started) return
      started = false
      bot.removeListener('chat', onChat)
    }
  }
}

module.exports = { createAgent }
