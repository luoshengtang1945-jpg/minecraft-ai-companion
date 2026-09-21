const { SYSTEM_PROMPT } = require('./prompt')
const { parseDecision } = require('./decision')

class OllamaClient {
  constructor(config) {
    this.config = config
    this.history = []
  }

  async decide(username, message) {
    this.history.push({ role: 'user', content: `${username} 对你说：${message}` })
    this.#trimHistory()

    const response = await fetch(this.config.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(this.config.timeoutMs),
      body: JSON.stringify({
        model: this.config.model,
        stream: false,
        messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...this.history]
      })
    })

    if (!response.ok) throw new Error(`Ollama HTTP ${response.status}`)

    const data = await response.json()
    const decision = parseDecision(data.message?.content)
    this.history.push({ role: 'assistant', content: JSON.stringify(decision) })
    this.#trimHistory()
    return decision
  }

  #trimHistory() {
    if (this.history.length > 20) this.history.splice(0, this.history.length - 20)
  }
}

module.exports = { OllamaClient }
