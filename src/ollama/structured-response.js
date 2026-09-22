const { isOllamaPreempted, signalWithTimeout } = require('./request-scheduler')

const STRUCTURED_RESPONSE_STATUS = Object.freeze({
  VALID_RESPONSE: 'VALID_RESPONSE',
  EMPTY_RESPONSE: 'EMPTY_RESPONSE',
  ABORTED: 'ABORTED',
  INVALID_JSON: 'INVALID_JSON',
  SCHEMA_INVALID: 'SCHEMA_INVALID',
  OLLAMA_ERROR: 'OLLAMA_ERROR'
})

class StructuredResponseError extends Error {
  constructor(status, message, details = {}) {
    super(message)
    this.name = 'StructuredResponseError'
    this.status = status
    this.details = details
  }
}

function isStructuredResponseError(error) {
  return error instanceof StructuredResponseError
}

function safePreview(value, maxChars = 2000) {
  if (typeof value !== 'string') return null
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, maxChars)
}

function extractJsonCandidate(content) {
  const trimmed = content.trim()
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  if (fenced) return { text: fenced[1].trim(), fenced: true, surroundingText: false }
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    return { text: trimmed, fenced: false, surroundingText: false }
  }
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start >= 0 && end > start) {
    return { text: trimmed.slice(start, end + 1), fenced: false, surroundingText: true }
  }
  return { text: trimmed, fenced: false, surroundingText: Boolean(trimmed) }
}

function parseStructuredContent(content, validate) {
  if (typeof content !== 'string' || !content.trim()) {
    throw new StructuredResponseError(STRUCTURED_RESPONSE_STATUS.EMPTY_RESPONSE, 'Ollama returned empty message.content')
  }
  const candidate = extractJsonCandidate(content)
  let value
  try {
    value = JSON.parse(candidate.text)
  } catch (error) {
    throw new StructuredResponseError(STRUCTURED_RESPONSE_STATUS.INVALID_JSON, `Invalid JSON: ${error.message}`, {
      fenced: candidate.fenced,
      surroundingText: candidate.surroundingText
    })
  }
  try {
    return {
      value: validate(value),
      fenced: candidate.fenced,
      surroundingText: candidate.surroundingText
    }
  } catch (error) {
    throw new StructuredResponseError(STRUCTURED_RESPONSE_STATUS.SCHEMA_INVALID, `Schema validation failed: ${error.message}`)
  }
}

async function responseText(response) {
  if (typeof response.text === 'function') return await response.text()
  if (typeof response.json === 'function') return JSON.stringify(await response.json())
  return ''
}

async function wait(durationMs) {
  await new Promise(resolve => setTimeout(resolve, durationMs))
}

async function requestStructured({
  ollama,
  scheduler = null,
  kind,
  owner,
  label,
  system,
  payload,
  messages = null,
  temperature = 0,
  schema,
  validate,
  logger,
  fetchFn = fetch,
  retries = ollama.responseRetries ?? 2,
  backoffMs = ollama.retryBackoffMs ?? 250,
  debug = ollama.debug ?? false,
  rawMaxChars = ollama.debugRawMaxChars ?? 2000
}) {
  const runAttempt = async attempt => {
    const execute = async ({ signal }) => {
      const timed = signalWithTimeout(signal, ollama.timeoutMs)
      try {
        let response
        try {
          response = await fetchFn(ollama.url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: timed.signal,
            body: JSON.stringify({
              model: ollama.model,
              stream: false,
              // qwen3-vl is fast with thinking disabled, but Ollama 0.34.2 may route
              // the schema-constrained answer into message.thinking. The response
              // normalizer below accepts that channel only after full validation.
              think: ollama.think ?? false,
              format: schema,
              options: { temperature },
              messages: messages || [
                { role: 'system', content: system },
                { role: 'user', content: JSON.stringify(payload) }
              ]
            })
          })
        } catch (error) {
          if (signal.aborted) {
            throw new StructuredResponseError(STRUCTURED_RESPONSE_STATUS.ABORTED, 'Ollama request aborted')
          }
          if (timed.signal.aborted) {
            throw new StructuredResponseError(STRUCTURED_RESPONSE_STATUS.OLLAMA_ERROR, 'Ollama request timed out')
          }
          throw new StructuredResponseError(STRUCTURED_RESPONSE_STATUS.OLLAMA_ERROR, `Ollama request failed: ${error.message}`)
        }

        let text
        try {
          text = await responseText(response)
        } catch (error) {
          if (signal.aborted) {
            throw new StructuredResponseError(STRUCTURED_RESPONSE_STATUS.ABORTED, 'Ollama response read aborted')
          }
          if (timed.signal.aborted) {
            throw new StructuredResponseError(STRUCTURED_RESPONSE_STATUS.OLLAMA_ERROR, 'Ollama response read timed out')
          }
          throw new StructuredResponseError(STRUCTURED_RESPONSE_STATUS.OLLAMA_ERROR, `Could not read Ollama response: ${error.message}`)
        }
        if (!response.ok) {
          throw new StructuredResponseError(STRUCTURED_RESPONSE_STATUS.OLLAMA_ERROR, `Ollama HTTP ${response.status}`, {
            httpStatus: response.status,
            bodyPreview: safePreview(text, rawMaxChars)
          })
        }
        if (!text.trim()) {
          throw new StructuredResponseError(STRUCTURED_RESPONSE_STATUS.EMPTY_RESPONSE, 'Ollama HTTP response body was empty', {
            httpStatus: response.status,
            bodyBytes: 0
          })
        }

        let envelope
        try {
          envelope = JSON.parse(text)
        } catch (error) {
          throw new StructuredResponseError(STRUCTURED_RESPONSE_STATUS.INVALID_JSON, `Ollama response envelope was invalid JSON: ${error.message}`, {
            httpStatus: response.status,
            bodyBytes: Buffer.byteLength(text)
          })
        }
        const content = envelope.message?.content
        const thinking = envelope.message?.thinking
        const metadata = {
          httpStatus: response.status,
          bodyBytes: Buffer.byteLength(text),
          contentLength: typeof content === 'string' ? content.length : 0,
          thinkingLength: typeof thinking === 'string' ? thinking.length : 0,
          done: envelope.done ?? null,
          doneReason: envelope.done_reason ?? null,
          evalCount: envelope.eval_count ?? null
        }
        if (debug) {
          logger?.info(`[OLLAMA] ${label} HTTP ${response.status}; body=${metadata.bodyBytes}B content=${metadata.contentLength} thinking=${metadata.thinkingLength}`)
          logger?.info(`[OLLAMA] ${label} raw content`, safePreview(content, rawMaxChars))
          if (thinking) logger?.info(`[OLLAMA] ${label} raw thinking`, safePreview(thinking, rawMaxChars))
        }
        try {
          let parsed
          let outputChannel = 'content'
          if ((typeof content !== 'string' || !content.trim()) && typeof thinking === 'string' && thinking.trim()) {
            try {
              parsed = parseStructuredContent(thinking, validate)
              outputChannel = 'thinking_compatibility'
              if (typeof logger?.throttled === 'function') {
                logger.throttled(`ollama-thinking-compat:${label}`, 60000, 'warn', `[OLLAMA] ${label} accepted schema-valid output from thinking compatibility channel`)
              } else if (debug) {
                logger?.warn?.(`[OLLAMA] ${label} accepted schema-valid output from thinking compatibility channel`)
              }
            } catch (thinkingError) {
              if (thinkingError.status === STRUCTURED_RESPONSE_STATUS.SCHEMA_INVALID) throw thinkingError
              if (
                thinkingError.status === STRUCTURED_RESPONSE_STATUS.INVALID_JSON &&
                /^\s*(?:```|\{)/.test(thinking)
              ) throw thinkingError
              parsed = parseStructuredContent(content, validate)
            }
          } else {
            parsed = parseStructuredContent(content, validate)
          }
          return { ...parsed, metadata: { ...metadata, outputChannel } }
        } catch (error) {
          if (isStructuredResponseError(error)) error.details = { ...metadata, ...error.details }
          throw error
        }
      } finally {
        timed.cleanup()
      }
    }

    logger?.info(`[OLLAMA] ${label} request started${attempt ? ` (retry ${attempt}/${retries})` : ''}`)
    try {
      return scheduler
        ? await scheduler.schedule(kind, execute, { owner })
        : await execute({ signal: new AbortController().signal })
    } catch (error) {
      if (isOllamaPreempted(error)) {
        logger?.info(`[OLLAMA] ${label} preempted${error.preemptedBy ? ` by ${error.preemptedBy}` : ''}`)
      }
      throw error
    }
  }

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const result = await runAttempt(attempt)
      logger?.info(`[OLLAMA] ${label} valid structured response`)
      return result.value
    } catch (error) {
      if (isOllamaPreempted(error) || error.status === STRUCTURED_RESPONSE_STATUS.ABORTED) throw error
      const retryable = [STRUCTURED_RESPONSE_STATUS.EMPTY_RESPONSE, STRUCTURED_RESPONSE_STATUS.INVALID_JSON].includes(error.status)
      if (!retryable || attempt >= retries) throw error
      const description = error.status === STRUCTURED_RESPONSE_STATUS.EMPTY_RESPONSE ? 'empty response' : 'invalid JSON'
      logger?.warn?.(`[OLLAMA] ${label} ${description}; retry ${attempt + 1}/${retries}`)
      await wait(backoffMs * (attempt + 1))
    }
  }
  throw new StructuredResponseError(STRUCTURED_RESPONSE_STATUS.OLLAMA_ERROR, 'Unreachable structured-response state')
}

module.exports = {
  STRUCTURED_RESPONSE_STATUS,
  StructuredResponseError,
  isStructuredResponseError,
  parseStructuredContent,
  requestStructured,
  safePreview,
  extractJsonCandidate
}
