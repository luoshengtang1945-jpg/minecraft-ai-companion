const { createAutonomyPrompt } = require('./prompt')
const { parseAutonomousDecision } = require('./action-schema')

class AutonomyOllamaClient {
  constructor({ ollama, personality }) {
    this.ollama = ollama
    this.systemPrompt = createAutonomyPrompt(personality)
  }

  async decide(worldState) {
    const response = await fetch(this.ollama.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(this.ollama.timeoutMs),
      body: JSON.stringify({
        model: this.ollama.model,
        stream: false,
        messages: [
          { role: 'system', content: this.systemPrompt },
          { role: 'user', content: JSON.stringify(worldState) }
        ]
      })
    })

    if (!response.ok) throw new Error(`Ollama autonomy HTTP ${response.status}`)
    const data = await response.json()
    return parseAutonomousDecision(data.message?.content)
  }
}

module.exports = { AutonomyOllamaClient }
