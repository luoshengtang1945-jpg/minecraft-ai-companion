const { SYSTEM_PROMPT } = require('./prompt')
const { validateDecision } = require('./decision')
const { requestStructured, CONVERSATION_SCHEMA } = require('../ollama')
const { isRepeatedReply, hasReversedFollowReply, isStageDirectionReply, contradictsMovementAction, fallbackMovementReply, REPLY_SCHEMA, validateReply } = require('./reply-variety')
const { chatReplyIssue } = require('./reply-grounding')

function revisionInstruction(issue) {
  const base = '你是Minecraft伙伴的回复编辑器。只输出JSON对象，唯一字段reply。只改写一句自然简短的中文，不改变动作，不添加没有证据的景物、经历或已完成行动。'
  const specific = {
    MISSED_EMOTION: '玩家说自己无聊、孤单或难过。先用自己的话接住这种感受，再给至多一个真实可做的小建议；不要只反问玩家。',
    OVERLOADED_EMOTION_REPLY: '玩家说自己无聊、孤单或难过。不要列选择、用“或者”凑清单，也别给玩家布置挖矿、建造等你目前无法共同执行的活；先接住感受，只给一个你真能陪伴的小建议。',
    DODGED_PREFERENCE: '玩家问你想做什么或喜欢什么。直接用“我想…”或“我更喜欢…”表达一个小偏好；不要报当前跟随/等待状态，不编造游戏机制。',
    UNVERIFIED_SHARED_MEMORY: '你没有这段过去共同经历的可靠记录。明确说“我没有那段经历的可靠记录”或“我不记得”，不要描述那天的地点、材料或行动；可以请玩家讲讲。',
    UNSUPPORTED_WORK_PROPOSAL: '你目前不能可靠自主挖矿、砍树、建房、合成或找材料。回应玩家的话题，但不要邀请“一起挖/建/找材料”，也不要说自己会帮忙执行。',
    UNSUPPORTED_RESOURCE_HELP: '你目前不能可靠帮玩家找材料或资源。坦白能力边界；可以讨论做法，但不要承诺去找。',
    DODGED_BUILD_LIMIT: '玩家问你会不会建房。直接说明“我现在还不能可靠地建房”，不是只说缺工具或材料；可以聊想法，但不要说你会建。',
    UNSUPPORTED_MECHANIC_CLAIM: '玩家问你喜不喜欢某种天气。只表达天气偏好或感受，不谈种植、蘑菇、战斗、合成等游戏机制。',
    UNVERIFIED_SCENE: '原句编造了眼前景物。删除具体地形、生物和资源描述；没有新视觉证据时仅回应玩家原话。',
    UNSTARTED_MOVEMENT_CLAIM: 'CHAT没有启动移动。不要说“我带你去”或“我这就过去”；若想提议散步，只说建议，不假装已经出发。',
    UNVERIFIED_ATTACKER: '没有证据确认攻击者。不要猜谁打了谁；只说已知的受伤事实或你的感受。',
    UNSOLICITED_COMBAT: '玩家没有下令战斗。不要主动约玩家打怪或暗示你正在战斗；换成贴近当前话题的普通陪伴。',
    VISUAL_SELF_CONTRADICTION: '草稿已经说看到了方块，就不要再说“不确定是不是方块”。只对看不清的材质或身份保留不确定；不要增加新物体。'
  }
  return `${base}${specific[issue] || '删除无证据的断言，并保留玩家话题。'}`
}

function freshFallback(candidates, recentReplies) {
  return candidates.find(candidate => !isRepeatedReply(candidate, recentReplies)) || candidates[0]
}

function groundedFallback(issue, playerMessage, recentReplies = []) {
  if (issue === 'VISUAL_SELF_CONTRADICTION') return '我眼前有个方块，材质没看清。'
  if (/(?:还)?记得.{0,18}(?:我们|咱们|一起)|(?:do you remember|remember when).{0,35}(?:we|our)/i.test(playerMessage)) {
    return '这件事我没有可靠记录，不想假装记得。你跟我说说？'
  }
  if (/(?:能|会|可以).{0,8}(?:建|盖|造).{0,5}房|can you build.{0,12}house/i.test(playerMessage)) {
    return '我现在还不能可靠地建房，布局可以一起商量。'
  }
  if (/(?:喜欢|偏爱).{0,12}(?:雨|晴)|do you like.{0,12}(?:rain|sun)/i.test(playerMessage)) {
    return '我更喜欢晴天，雨声偶尔听听还不错。'
  }
  if (/你想(?:做|干|玩)|what do you want(?: to do)?|what would you like(?: to do)?/i.test(playerMessage)) {
    return '我倒想在附近逛逛，不过先陪你待会儿也挺好。'
  }
  if (issue === 'DODGED_PREFERENCE') return '我倒想在附近逛逛，不过先陪你待会儿也挺好。'
  if (issue === 'UNSUPPORTED_RESOURCE_HELP') return '建房我现在还不能可靠完成，找材料也不稳。想法倒可以商量。'
  if (issue === 'UNSUPPORTED_WORK_PROPOSAL' && /(?:能不能|会不会|可以|can you|do you know how)/i.test(playerMessage)) {
    return '这件事我现在还做不稳，不过可以跟你一起想想怎么弄。'
  }
  if (/无聊|好闷|bored/i.test(playerMessage)) {
    return freshFallback([
      '有点闷了啊。要不要在附近走两步？',
      '我在呢。咱们可以换个地方慢慢逛。',
      '先不用找事做，陪你聊两句也挺好。'
    ], recentReplies)
  }
  if (/孤单|寂寞|难过|心情不好|lonely|sad/i.test(playerMessage)) {
    return freshFallback([
      '我在呢，想说什么就慢慢说。',
      '嗯，我陪你待会儿，不急着做别的。',
      '听起来不太舒服。我在这儿陪你聊聊。'
    ], recentReplies)
  }
  return '我在呢。要不我们在附近随便走走？'
}

class OllamaClient {
  constructor(config, scheduler = null, logger = null) {
    this.config = config
    this.scheduler = scheduler
    this.logger = logger
    this.history = []
    this.recentReplies = []
  }

  async decide(username, message, context = null, { freshVisual = false } = {}) {
    const contextText = context ? `\n当前状态：${context}` : ''
    const utterance = { role: 'user', content: `${username} 对你说：${message}` }
    if (!freshVisual) {
      this.history.push(utterance)
      this.#trimHistory()
    }
    // Visual answers use only the current observed frame, never prior scene descriptions.
    const messages = freshVisual ? [{ ...utterance }] : this.history.map(entry => ({ ...entry }))
    messages[messages.length - 1].content += contextText

    const decision = await requestStructured({
      ollama: this.config,
      scheduler: this.scheduler,
      kind: 'PLAYER_CONVERSATION',
      owner: 'conversation',
      label: 'PLAYER_CONVERSATION decision',
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages],
      schema: CONVERSATION_SCHEMA,
      validate: validateDecision,
      temperature: 0.5,
      logger: this.logger
    })
    const groundingIssue = decision.action === 'CHAT' ? chatReplyIssue(decision.reply, { freshVisual, playerMessage: message }) : null
    if (groundingIssue) {
      const directCapabilityAnswer = ['UNSUPPORTED_RESOURCE_HELP', 'UNSUPPORTED_WORK_PROPOSAL', 'DODGED_BUILD_LIMIT'].includes(groundingIssue) &&
        /(?:能|会|可以).{0,8}(?:建|盖|造).{0,5}房|can you build.{0,12}house/i.test(message)
      this.logger?.info?.(`[CHAT] ${groundingIssue}; ${directCapabilityAnswer ? 'using known capability boundary' : 'requesting grounded text-only revision'}`)
      if (directCapabilityAnswer) {
        decision.reply = groundedFallback(groundingIssue, message, this.recentReplies)
      } else {
        try {
          const revision = await requestStructured({
            ollama: this.config, scheduler: this.scheduler, kind: 'PLAYER_CONVERSATION',
            owner: 'conversation', label: 'PLAYER_CONVERSATION capability revision',
            messages: [
              { role: 'system', content: revisionInstruction(groundingIssue) },
              { role: 'user', content: JSON.stringify({ player: username, message, rejectedDraft: decision.reply,
                ...(freshVisual ? { currentVisualContext: context } : {}) }) }
            ],
            schema: REPLY_SCHEMA,
            validate: value => {
              const reply = validateReply(value)
              const issue = chatReplyIssue(reply.reply, { freshVisual, playerMessage: message })
              if (issue) throw new Error(`Revision still contains ${issue}`)
              return reply
            },
            retries: 0, temperature: 0.6, logger: this.logger
          })
          decision.reply = revision.reply
        } catch (error) {
          this.logger?.info?.(`[CHAT] Grounding revision unavailable: ${String(error?.status || error?.code || 'UNKNOWN')}; ${String(error?.message || '').slice(0, 120)}`)
          decision.reply = groundedFallback(groundingIssue, message, this.recentReplies)
        }
      }
    }
    if (!decision.reply.trim() || isRepeatedReply(decision.reply, this.recentReplies) ||
        hasReversedFollowReply(decision.action, decision.reply) || isStageDirectionReply(decision.reply) ||
        contradictsMovementAction(decision.action, decision.reply)) {
      this.logger?.info?.('[CHAT] Empty, repeated, stage-direction or contradictory movement reply; requesting one text-only revision')
      try {
        const revisionMessages = [
          { role: 'system', content: '你是Minecraft伙伴AI_Companion的回复编辑器。只输出JSON对象，唯一字段reply。保留原动作的含义，用不同措辞写一句简短自然的中文；不要括号舞台说明、不输出动作、不增加新事实。FOLLOW时玩家在前面，AI跟随玩家；STOP时AI停下，不可说自己仍在跟随。' },
          { role: 'user', content: JSON.stringify({ player: username, message, context, actionAlreadyChosen: decision.action, recentReplies: this.recentReplies }) },
          { role: 'assistant', content: JSON.stringify({ reply: decision.reply }) },
          { role: 'user', content: `编辑检查：草稿不合格（空白、重复或方向反了）。已经说过的句子：${JSON.stringify(this.recentReplies)}。这次必须换一种不同的表达，不能再输出这些句子或只改标点。可以依据context真实距离或位置关系回应，不编造。FOLLOW时以“我”开头说明AI自己的跟随意愿，不指挥玩家移动。直接输出修订后的reply。` }
        ]
        const revision = await requestStructured({
          ollama: this.config, scheduler: this.scheduler, kind: 'PLAYER_CONVERSATION',
          owner: 'conversation', label: 'PLAYER_CONVERSATION reply revision',
          messages: revisionMessages,
          schema: REPLY_SCHEMA,
          validate: validateReply,
          retries: 0, temperature: 0.7, logger: this.logger
        })
        decision.reply = isRepeatedReply(revision.reply, this.recentReplies) ||
          hasReversedFollowReply(decision.action, revision.reply) || isStageDirectionReply(revision.reply) ||
          contradictsMovementAction(decision.action, revision.reply) ? '' : revision.reply
      } catch {
        decision.reply = ''
        this.logger?.info?.('[CHAT] Reply revision unavailable; duplicate text withheld, original action retained')
      }
      if (!decision.reply) {
        decision.reply = fallbackMovementReply(decision.action, this.recentReplies)
        this.logger?.info?.(`[CHAT] Reply revision unusable; ${decision.reply ? 'using short movement acknowledgement' : 'duplicate reply withheld'}`)
      }
    }
    if (decision.action === 'CHAT') {
      const finalIssue = chatReplyIssue(decision.reply, { freshVisual, playerMessage: message })
      if (finalIssue) {
        this.logger?.info?.(`[CHAT] Final grounding check rejected ${finalIssue}`)
        decision.reply = groundedFallback(finalIssue, message, this.recentReplies)
        if (chatReplyIssue(decision.reply, { freshVisual, playerMessage: message }) ||
            isRepeatedReply(decision.reply, this.recentReplies)) decision.reply = ''
      }
    }
    if (decision.reply) this.recentReplies = [...this.recentReplies, decision.reply].slice(-6)
    if (!freshVisual) {
      this.history.push({ role: 'assistant', content: JSON.stringify(decision) })
      this.#trimHistory()
    }
    return decision
  }

  #trimHistory() {
    if (this.history.length > 20) this.history.splice(0, this.history.length - 20)
  }
}

module.exports = { OllamaClient, groundedFallback }
