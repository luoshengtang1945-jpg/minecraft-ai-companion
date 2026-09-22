const { OllamaClient } = require('./ollama-client')
const { chatSafe } = require('./decision')
const { recognizeImmediateMovement } = require('./immediate-movement')
const { PLAYER_MESSAGE_TYPES, classifyPlayerMessage } = require('./goal-router')
const { requiresVisualContext, conversationVisualContext } = require('../vision')
const { recognizeRestRequest } = require('../companion/rest-controller')
const { groundActionReply } = require('./action-claims')

function isRedundantMovementDecision(action, username, behavior) {
  return behavior?.source === 'PLAYER' && behavior.locomotionOwner === 'PLAYER' &&
    behavior.type === action && ['FOLLOW', 'COME', 'STOP'].includes(action) &&
    (action === 'STOP' || behavior.username === username)
}

function createAgent({ bot, movement, survival, autonomy = null, learning = null, vision = null, visualWorldModel = null, scheduler = null, session = null, rest = null, logger, config }) {
  const client = new OllamaClient(config, scheduler, logger)
  let started = false
  let queue = Promise.resolve()
  const speak = message => {
    bot.chat(message)
    session?.recordSpeech(message)
  }
  const applyPlayerMovement = (action, username) => {
    rest?.cancel()
    survival.cancelPursuit?.()
    if (action === 'FOLLOW') movement.follow(username)
    if (action === 'COME') movement.come(username)
    if (action === 'STOP') movement.stop()
  }

  const handleChat = async (username, message, context) => {
    try {
      let visualContext = null
      if (requiresVisualContext(message)) {
        const result = await vision?.request?.({ priority: 'PLAYER', trigger: 'PLAYER_VISUAL_QUESTION', requireFresh: true })
        visualContext = conversationVisualContext(visualWorldModel)
        if (!visualContext || (result && !['UPDATED', 'SKIPPED'].includes(result.status))) {
          speak('我现在没有可用的新画面，不能确定你指的是哪个东西。')
          return
        }
      }
      logger.info(`Asking ${config.model} for an action`)
      const taskSummary = learning?.getTaskSummary?.()
      const taskText = taskSummary
        ? `正在执行学习任务：${taskSummary.goal}；已尝试 ${taskSummary.attempts} 次；最近动作 ${taskSummary.lastAction || '无'}；最近评估 ${taskSummary.lastEvaluation || '无'}。`
        : null
      const visualText = visualContext
        ? `视觉上下文（${visualContext.source}，视角=${visualContext.perspective}，约${visualContext.ageMs}毫秒前）：${JSON.stringify(visualContext)}。只可据此谨慎回答，不得声称精确坐标；如视角是 HUMAN_CLIENT_CAMERA，要说明这是共享的玩家客户端画面。`
        : null
      const sessionText = session ? `短期陪伴上下文：${JSON.stringify(session.snapshot())}` : null
      const commandText = context.immediateAction ? `本条即时指令已交给身体控制层：${context.immediateAction}；执行者是AI，发话玩家是${username}。FOLLOW是AI跟随玩家，COME是AI走到玩家身边，STOP是AI停下。回复不代表动作已经完成。` : null
      const contextText = [commandText, sessionText, taskText, visualText].filter(Boolean).join('\n') || null
      const decision = await client.decide(username, message, contextText)
      logger.info(`Agent chose ${decision.action}`)

      const movementAction = ['FOLLOW', 'COME', 'STOP'].includes(decision.action)
      const staleMovement = movementAction && movement.getPlayerCommandEpoch() !== context.commandEpoch
      const redundantMovement = isRedundantMovementDecision(decision.action, username, movement.getBehaviorSummary?.())
      if (movementAction && !context.immediateAction && !staleMovement && !redundantMovement) {
        applyPlayerMovement(decision.action, username)
      }
      if (redundantMovement && !context.immediateAction) logger.info(`Keeping existing player behavior ${decision.action}; no path reset`)
      if (staleMovement) logger.info(`Discarded stale player movement decision ${decision.action}`)
      const allowCombatDecision = !context.immediateAction && movement.getPlayerCommandEpoch() === context.commandEpoch
      if (allowCombatDecision && decision.action === 'PASSIVE') survival.setCombatMode('PASSIVE')
      if (allowCombatDecision && decision.action === 'DEFENSIVE') survival.setCombatMode('DEFENSIVE')
      if (allowCombatDecision && decision.action === 'AGGRESSIVE') survival.setCombatMode('AGGRESSIVE')

      let responseText = decision.reply
      if (!allowCombatDecision && ['ATTACK', 'PASSIVE', 'DEFENSIVE', 'AGGRESSIVE'].includes(decision.action)) {
        responseText = '好，我按你最新的移动指令来。'
      }
      if (allowCombatDecision && decision.action === 'ATTACK') {
        const result = survival.requestAttack(username)
        if (result.reason === 'PASSIVE') responseText = '我现在是被动模式，不会主动攻击。'
        if (result.reason === 'NO_TARGET') responseText = '我没看到可以攻击的目标。'
      }

      const reply = chatSafe(groundActionReply(responseText, bot))
      if (reply) speak(reply)
    } catch (error) {
      logger.error('AI decision failed', error)
      speak('等下，我脑子刚卡了一下。')
    }
  }

  const onChat = (username, message) => {
    if (username === bot.username) return
    session?.recordPlayer(username, message)

    logger.info(`[MC] ${username}: ${message}`)
    survival.observePlayer(username)
    autonomy?.observePlayer(username, message)
    const restAction = recognizeRestRequest(message)
    if (restAction && rest) {
      void rest.request(restAction).catch(error => { logger.error('[REST] Request failed', error); speak('这次没能完成床的操作。') })
      return
    }
    if (/(设置.{0,4}重生点|点.{0,3}床|右键.{0,3}床)/.test(message)) {
      speak('单独设置重生点或点击床还没接入；你可以带我靠近空床，晚上叫我睡觉。')
      return
    }

    const route = classifyPlayerMessage(username, message)
    if (route.type === PLAYER_MESSAGE_TYPES.TASK_GOAL) {
      speak('行，我试试。')
      void learning?.startPlayerTask({ username, message, goal: route.goal })
        .catch(error => logger.error('Player learning task failed', error))
      return
    }
    if (route.type === PLAYER_MESSAGE_TYPES.CANCEL_TASK) {
      speak(learning?.cancel('PLAYER_CANCELLED') ? '好，不弄了。' : '我现在没在做任务。')
      return
    }

    const immediateAction = route.immediateAction || recognizeImmediateMovement(message)
    if (immediateAction) applyPlayerMovement(immediateAction, username)

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
      rest?.start()
      bot.on('chat', onChat)
    },
    stop() {
      if (!started) return
      started = false
      rest?.stop()
      bot.removeListener('chat', onChat)
    }
  }
}

module.exports = { createAgent, isRedundantMovementDecision }
