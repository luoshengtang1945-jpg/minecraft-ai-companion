const path = require('node:path')
const dotenv = require('dotenv')

dotenv.config({ path: path.resolve(process.cwd(), '.env'), quiet: true })

function localOllamaConfig() {
  return {
    url: process.env.OLLAMA_URL || 'http://localhost:11434/api/chat',
    model: process.env.OLLAMA_MODEL || 'qwen3-vl:8b',
    timeoutMs: Number(process.env.OLLAMA_TIMEOUT_MS || 120000),
    responseRetries: Number(process.env.OLLAMA_RESPONSE_RETRIES || 2),
    retryBackoffMs: Number(process.env.OLLAMA_RETRY_BACKOFF_MS || 250),
    think: process.env.OLLAMA_THINK === 'true',
    debug: false
  }
}

module.exports = { localOllamaConfig }
