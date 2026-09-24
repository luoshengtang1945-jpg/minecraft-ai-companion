const { OllamaClient } = require('./ollama-client')
const { chatSafe } = require('./decision')
const { recognizeImmediateMovement } = require('./immediate-movement')
const { PLAYER_MESSAGE_TYPES, classifyPlayerMessage } = require('./goal-router')
const { requiresVisualContext, isVisualFollowUp, conversationVisualContext } = require('../vision')
const { recognizeRestRequest } = require('../companion/rest-controller')
const { groundActionReply, groundMovementReply } = require('./action-claims')
const { answerFactualQuestion } = require('./factual-answer')
const { checkWorldClaim } = require('./world-claims')

function isRedundantMovementDecision(action, username, behavior) {
  return behavior?.source === 'PLAYER' && behavior.locomotionOwner === 'PLAYER' &&
    behavior.type === action && ['FOLLOW', 'COME', 'STOP'].includes(action) &&
    (action === 'STOP' || behavior.username === username)
}

function isPlayerChatTranslation(translate) {
  // Mineflayer's legacy chat pattern also matches command feedback like
  // "[HHLYZ: Set the time to 1000]" and emits it as a `chat` event.
  return translate !== 'chat.type.admin'
}

function createAgent({ bot, movement, survival, autonomy = null, learning = null, vision = null, visualWorldModel = null, scheduler = null, session = null, rest = null, logger, config }) {
  const client = new OllamaClient(config, scheduler, logger)
  let started = false
  let queue = Promise.resolve()
  const recentVisualQuestion = new Map()
  const speak = message => {
    bot.chat(message)
    session?.recordSpeech(message)
  }
  const applyPlayerMovement = (action, username) => {
    if (learning?.isAutonomousTaskActive?.()) learning.cancel('PLAYER_MOVEMENT_COMMAND')
    rest?.cancel()
    survival.cancelPursuit?.()
    if (action === 'FOLLOW') return movement.follow(username)
    if (action === 'COME') return movement.come(username)
    if (action === 'STOP') return movement.stop()
  }

  const handleChat = async (username, message, context) => {
    try {
      let visualContext = null
      if (context.visualQuestion) {
        const result = await vision?.request?.({ priority: 'PLAYER', trigger: 'PLAYER_VISUAL_QUESTION', requireFresh: true })
        visualContext = conversationVisualContext(visualWorldModel, bot)
        if (result?.status !== 'UPDATED' || !visualContext || visualContext.frameId !== result.frameId) {
          logger.info(`[VISION] visual question has no fresh observation (${result?.reason || result?.status || 'NO_VISION'})`)
          speak('我现在没有可用的新画面，不能确定你指的是哪个东西。')
          return
        }
        logger.info(`[VISION] answering from ${visualContext.perspective} frame ${visualContext.frameId}`)
        if (visualContext.sceneType === 'UNKNOWN' && !visualContext.salientObjects.length &&
            !visualContext.structures.length && !visualContext.terrain.length) {
          speak('这张画面我没看清，不想瞎猜。')
          return
        }
      }
      logger.info(`Asking ${config.model} for an action`)
      const taskSummary = learning?.getTaskSummary?.()
      const taskText = taskSummary
        ? `最近学习任务：${taskSummary.goal}；实际状态 ${taskSummary.outcome}（只有RUNNING或PENDING表示仍在进行）；已尝试 ${taskSummary.attempts} 次；最近动作 ${taskSummary.lastAction || '无'}；最近评估 ${taskSummary.lastEvaluation || '无'}。`
        : null
      const visualText = visualContext
        ? `这是本次刚看到的画面（${visualContext.perspective}，${visualContext.ageMs}毫秒前）：${JSON.stringify(visualContext)}。视觉标签和置信度都来自模型猜测，并非游戏核实。直接用一两句口语回答；画面里醒目的物体要说出来，若只能看清外观就说颜色和形状，不猜具体材质。小型生物、远处物体或身份不确定时说没看清。别复述旧画面、别念物体清单或声称精确坐标。`
        : null
      const sessionText = !context.visualQuestion && session ? `短期陪伴上下文：${JSON.stringify(session.snapshot())}` : null
      const commandText = context.immediateAction ? `本条即时指令已交给身体控制层：${context.immediateAction}；执行者是AI，发话玩家是${username}。FOLLOW是AI跟随玩家，COME是AI走到玩家身边，STOP是AI停下。回复不代表动作已经完成。` : null
      const contextText = [commandText, sessionText, taskText, visualText].filter(Boolean).join('\n') || null
      const decision = await client.decide(username, message, contextText, { freshVisual: context.visualQuestion })
      if (!started) return
      logger.info(`Agent chose ${decision.action}`)

      const movementAction = ['FOLLOW', 'COME', 'STOP'].includes(decision.action)
      const staleMovement = movementAction && movement.getPlayerCommandEpoch() !== context.commandEpoch
      const redundantMovement = isRedundantMovementDecision(decision.action, username, movement.getBehaviorSummary?.())
      if (staleMovement || (context.immediateAction && movement.getPlayerCommandEpoch() !== context.commandEpoch)) {
        logger.info('[CHAT] Discarded superseded command acknowledgement')
        return
      }
      let movementResult = context.immediateResult
      if (movementAction && !context.immediateAction && !staleMovement && !redundantMovement) {
        movementResult = applyPlayerMovement(decision.action, username)
      }
      if (redundantMovement && !context.immediateAction) logger.info(`Keeping existing player behavior ${decision.action}; no path reset`)
      if (staleMovement) logger.info(`Discarded stale player movement decision ${decision.action}`)
      const allowCombatDecision = !context.immediateAction && movement.getPlayerCommandEpoch() === context.commandEpoch
      if (allowCombatDecision && decision.action === 'PASSIVE') survival.setCombatMode('PASSIVE')
      if (allowCombatDecision && decision.action === 'DEFENSIVE') survival.setCombatMode('DEFENSIVE')
      if (allowCombatDecision && decision.action === 'AGGRESSIVE') survival.setCombatMode('AGGRESSIVE')

      let responseText = decision.reply
      if (movementResult === false) responseText = '刚才的移动请求没有被执行，不能算完成。'
      else if (context.immediateAction || movementAction) {
        responseText = groundMovementReply(responseText, { action: context.immediateAction || decision.action, bot, movement })
      }
      if (!allowCombatDecision && ['ATTACK', 'PASSIVE', 'DEFENSIVE', 'AGGRESSIVE'].includes(decision.action)) {
        responseText = '好，我按你最新的移动指令来。'
      }
      if (allowCombatDecision && decision.action === 'ATTACK') {
        const result = survival.requestAttack(username)
        if (result.reason === 'PASSIVE') responseText = '我现在是被动模式，不会主动攻击。'
        if (result.reason === 'NO_TARGET') responseText = '我没看到可以攻击的目标。'
        if (result.accepted && /(?:打死|杀死|消灭|清理完|清掉).{0,5}(?:了|完成)/.test(responseText)) {
          responseText = '攻击指令已接受，还没确认打赢。'
        }
      }

      const worldClaim = checkWorldClaim(responseText, bot)
      if (!worldClaim.valid) logger.info(`[FACT] Replaced unsupported ${worldClaim.topic} claim using current state`)
      const reply = chatSafe(groundActionReply(worldClaim.valid ? responseText : worldClaim.correction, bot))
      if (reply) speak(reply)
    } catch (error) {
      logger.error('AI decision failed', error)
      speak('等下，我脑子刚卡了一下。')
    }
  }

  const onChat = (username, message, translate, originalMsg) => {
    if (!isPlayerChatTranslation(translate || originalMsg?.translate)) return
    if (username === bot.username) return
    const visualQuestion = requiresVisualContext(message) ||
      (isVisualFollowUp(message) && Date.now() - (recentVisualQuestion.get(username) || 0) < 90_000)
    if (visualQuestion) recentVisualQuestion.set(username, Date.now())
    else recentVisualQuestion.delete(username)
    session?.recordPlayer(username, message)

    logger.info(`[MC] ${username}: ${message}`)
    survival.observePlayer(username)
    autonomy?.observePlayer(username, message)
    const factual = answerFactualQuestion(message, { bot, movement })
    if (factual) {
      logger.info(`[FACT] ${factual.topic}: ${factual.source}`)
      speak(factual.reply)
      return
    }
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
    const immediateResult = immediateAction ? applyPlayerMovement(immediateAction, username) : undefined
    if (immediateAction && immediateResult === false) {
      const unseen = ['FOLLOW', 'COME'].includes(immediateAction) && !movement.getPlayer?.(username)
      speak(unseen ? '我暂时没看到你，靠近点再叫我。' : '这次没能动起来，我先待着。')
      return
    }

    const context = {
      visualQuestion,
      immediateAction,
      immediateResult,
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
      recentVisualQuestion.clear()
      rest?.stop()
      bot.removeListener('chat', onChat)
    }
  }
}

module.exports = { createAgent, isRedundantMovementDecision, isPlayerChatTranslation }
