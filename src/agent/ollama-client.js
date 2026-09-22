const { SYSTEM_PROMPT } = require('./prompt')
const { validateDecision } = require('./decision')
const { requestStructured, CONVERSATION_SCHEMA } = require('../ollama')
const { isRepeatedReply, hasReversedFollowReply, REPLY_SCHEMA, validateReply } = require('./reply-variety')

class OllamaClient {
  constructor(config, scheduler = null, logger = null) {
    this.config = config
    this.scheduler = scheduler
    this.logger = logger
    this.history = []
    this.recentReplies = []
  }

  async decide(username, message, context = null) {
    const contextText = context ? `\n当前状态：${context}` : ''
    this.history.push({ role: 'user', content: `${username} 对你说：${message}` })
    this.#trimHistory()
    // Observations are current request data, not historical facts to repeat forever.
    const messages = this.history.map(entry => ({ ...entry }))
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
    if (!decision.reply.trim() || isRepeatedReply(decision.reply, this.recentReplies) || hasReversedFollowReply(decision.action, decision.reply)) {
      this.logger?.info?.('[CHAT] Empty, repeated or reversed FOLLOW reply; requesting one text-only revision')
      try {
        const revisionMessages = [
          { role: 'system', content: '你是Minecraft伙伴AI_Companion的回复编辑器。只输出JSON对象，唯一字段reply。保留原动作的含义，用不同措辞写一句简短自然的中文；不输出动作、不增加新事实。FOLLOW时玩家在前面，AI跟随玩家。' },
          { role: 'user', content: JSON.stringify({ player: username, message, context, actionAlreadyChosen: decision.action, recentReplies: this.recentReplies }) },
          { role: 'assistant', content: JSON.stringify({ reply: decision.reply }) },
          { role: 'user', content: `编辑检查：草稿不合格（空白、重复或方向反了）。已经说过的句子：${JSON.stringify(this.recentReplies)}。这次必须换一种不同的表达，不能再输出这些句子或只改标点。可以依据context真实距离或位置关系回应，不编造。FOLLOW时以“我”开头说明AI自己的跟随意愿，不指挥玩家移动。直接输出修订后的reply。` }
        ]
        const revision = await requestStructured({
          ollama: this.config, scheduler: this.scheduler, kind: 'PLAYER_CONVERSATION',
          owner: 'conversation', label: 'PLAYER_CONVERSATION reply revision',
          messages: revisionMessages,
          schema: decision.action === 'FOLLOW' ? { ...REPLY_SCHEMA, properties: { reply: { ...REPLY_SCHEMA.properties.reply, pattern: '^我' } } } : REPLY_SCHEMA,
          validate: value => {
            const reply = validateReply(value)
            if (decision.action === 'FOLLOW' && !reply.reply.startsWith('我')) throw new Error('FOLLOW revision must use the companion as first-person subject')
            return reply
          },
          retries: 0, temperature: 0.7, logger: this.logger
        })
        decision.reply = isRepeatedReply(revision.reply, this.recentReplies) || hasReversedFollowReply(decision.action, revision.reply) ? '' : revision.reply
      } catch {
        decision.reply = ''
        this.logger?.info?.('[CHAT] Reply revision unavailable; duplicate text withheld, original action retained')
      }
      if (!decision.reply) this.logger?.info?.('[CHAT] Duplicate reply withheld; no further retry')
    }
    if (decision.reply) this.recentReplies = [...this.recentReplies, decision.reply].slice(-6)
    this.history.push({ role: 'assistant', content: JSON.stringify(decision) })
    this.#trimHistory()
    return decision
  }

  #trimHistory() {
    if (this.history.length > 20) this.history.splice(0, this.history.length - 20)
  }
}

module.exports = { OllamaClient }
