const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const {
  parseStructuredContent,
  STRUCTURED_RESPONSE_STATUS
} = require('../src/ollama')

function percentile(values, fraction) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]
}

function summarize(values) {
  const finite = values.filter(Number.isFinite)
  if (!finite.length) return { count: 0, average: null, median: null, p95: null, min: null, max: null }
  return {
    count: finite.length,
    average: finite.reduce((sum, value) => sum + value, 0) / finite.length,
    median: percentile(finite, 0.5),
    p95: percentile(finite, 0.95),
    min: Math.min(...finite),
    max: Math.max(...finite)
  }
}

function rate(count, total) {
  return total ? count / total : null
}

function safeJsonParse(text) {
  try { return { value: JSON.parse(text), error: null } } catch (error) { return { value: null, error } }
}

function classifyChannel(content, thinking, validate) {
  const contentText = typeof content === 'string' ? content : ''
  const thinkingText = typeof thinking === 'string' ? thinking : ''
  if (contentText.trim()) {
    try {
      return { valid: true, channel: 'content', value: parseStructuredContent(contentText, validate).value, status: 'VALID_RESPONSE' }
    } catch (error) {
      return { valid: false, channel: 'content', value: null, status: error.status || 'INVALID_JSON', error: error.message }
    }
  }
  if (thinkingText.trim()) {
    try {
      return { valid: true, channel: 'thinking_compatibility', value: parseStructuredContent(thinkingText, validate).value, status: 'VALID_RESPONSE' }
    } catch (error) {
      return {
        valid: false,
        channel: 'thinking',
        value: null,
        status: error.status === STRUCTURED_RESPONSE_STATUS.SCHEMA_INVALID ? 'SCHEMA_INVALID' : 'EMPTY_RESPONSE',
        error: error.message
      }
    }
  }
  return { valid: false, channel: 'none', value: null, status: 'EMPTY_RESPONSE', error: 'Both model channels were empty' }
}

class BenchmarkOllama {
  constructor({ url, timeoutMs = 180000 }) {
    this.url = url
    this.timeoutMs = timeoutMs
    this.realCalls = 0
  }

  async structured({ condition, system, payload = null, messages = null, schema, validate, retries = 0, seed = 0 }) {
    const attempts = []
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const result = await this.#request({ condition, system, payload, messages, schema, seed: seed + attempt })
      const classified = result.httpOk && result.envelope
        ? classifyChannel(result.envelope.message?.content, result.envelope.message?.thinking, validate)
        : {
            valid: false,
            channel: 'none',
            value: null,
            status: result.httpOk ? 'INVALID_JSON' : 'OLLAMA_ERROR',
            error: result.error || `HTTP ${result.httpStatus}`
          }
      attempts.push({ ...result, ...classified })
      if (classified.valid) break
      if (!['EMPTY_RESPONSE', 'INVALID_JSON'].includes(classified.status)) break
    }
    const final = attempts.at(-1)
    return {
      valid: Boolean(final?.valid),
      value: final?.value || null,
      status: final?.status || 'OLLAMA_ERROR',
      channel: final?.channel || 'none',
      retriesRequired: Math.max(0, attempts.length - 1),
      totalWallMs: attempts.reduce((sum, item) => sum + item.wallMs, 0),
      attempts
    }
  }

  async #request({ condition, system, payload, messages, schema, seed }) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
    const started = performance.now()
    this.realCalls += 1
    try {
      const response = await fetch(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          model: condition.model,
          stream: false,
          think: condition.think,
          format: schema,
          keep_alive: '15m',
          options: { temperature: 0, seed },
          messages: messages || [
            { role: 'system', content: system },
            { role: 'user', content: JSON.stringify(payload) }
          ]
        })
      })
      const text = await response.text()
      const parsed = safeJsonParse(text)
      const envelope = parsed.value
      return {
        httpOk: response.ok,
        httpStatus: response.status,
        bodyBytes: Buffer.byteLength(text),
        wallMs: performance.now() - started,
        envelope,
        error: parsed.error?.message || null,
        contentLength: typeof envelope?.message?.content === 'string' ? envelope.message.content.length : 0,
        thinkingLength: typeof envelope?.message?.thinking === 'string' ? envelope.message.thinking.length : 0,
        doneReason: envelope?.done_reason || null,
        loadMs: Number.isFinite(envelope?.load_duration) ? envelope.load_duration / 1e6 : null,
        promptTokens: envelope?.prompt_eval_count ?? null,
        promptEvalMs: Number.isFinite(envelope?.prompt_eval_duration) ? envelope.prompt_eval_duration / 1e6 : null,
        outputTokens: envelope?.eval_count ?? null,
        evalMs: Number.isFinite(envelope?.eval_duration) ? envelope.eval_duration / 1e6 : null,
        promptTokensPerSecond: envelope?.prompt_eval_count && envelope?.prompt_eval_duration
          ? envelope.prompt_eval_count / (envelope.prompt_eval_duration / 1e9)
          : null,
        outputTokensPerSecond: envelope?.eval_count && envelope?.eval_duration
          ? envelope.eval_count / (envelope.eval_duration / 1e9)
          : null
      }
    } catch (error) {
      return {
        httpOk: false,
        httpStatus: null,
        bodyBytes: 0,
        wallMs: performance.now() - started,
        envelope: null,
        error: error.name === 'AbortError' ? 'TIMEOUT' : error.message,
        contentLength: 0,
        thinkingLength: 0,
        doneReason: null,
        loadMs: null,
        promptTokens: null,
        promptEvalMs: null,
        outputTokens: null,
        evalMs: null,
        promptTokensPerSecond: null,
        outputTokensPerSecond: null
      }
    } finally {
      clearTimeout(timeout)
    }
  }

  async runningModels() {
    try {
      const response = await fetch(this.url.replace(/\/api\/chat$/, '/api/ps'))
      return await response.json()
    } catch {
      return null
    }
  }
}

function resourceSnapshot() {
  let gpu = null
  try {
    const executable = process.platform === 'win32'
      ? path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'nvidia-smi.exe')
      : 'nvidia-smi'
    const output = execFileSync(executable, [
      '--query-gpu=name,memory.total,memory.used,utilization.gpu,utilization.memory',
      '--format=csv,noheader,nounits'
    ], { encoding: 'utf8' }).trim()
    const [name, totalMiB, usedMiB, gpuUtilizationPercent, memoryUtilizationPercent] = output.split(',').map(value => value.trim())
    gpu = {
      name,
      totalMiB: Number(totalMiB),
      usedMiB: Number(usedMiB),
      gpuUtilizationPercent: Number(gpuUtilizationPercent),
      memoryUtilizationPercent: Number(memoryUtilizationPercent)
    }
  } catch {}
  return {
    capturedAt: new Date().toISOString(),
    gpu,
    systemMemory: {
      totalBytes: os.totalmem(),
      usedBytes: os.totalmem() - os.freemem(),
      freeBytes: os.freemem()
    }
  }
}

function flattenAttempts(results) {
  return results.flatMap(result => result.attempts || [])
}

function inferenceSummary(results) {
  const attempts = flattenAttempts(results)
  return {
    realHttpCalls: attempts.length,
    wallMs: summarize(results.map(result => result.totalWallMs)),
    attemptWallMs: summarize(attempts.map(attempt => attempt.wallMs)),
    loadMs: summarize(attempts.map(attempt => attempt.loadMs)),
    promptTokensPerSecond: summarize(attempts.map(attempt => attempt.promptTokensPerSecond)),
    outputTokensPerSecond: summarize(attempts.map(attempt => attempt.outputTokensPerSecond))
  }
}

module.exports = {
  BenchmarkOllama,
  summarize,
  percentile,
  rate,
  resourceSnapshot,
  inferenceSummary,
  flattenAttempts
}
