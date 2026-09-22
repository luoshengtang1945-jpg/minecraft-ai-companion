const http = require('node:http')

function isLoopback(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function header(request, name) {
  const value = request.headers[name]
  return Array.isArray(value) ? value[0] : value
}

function hasUploadCapacity(inFlight, maximum) {
  return Number.isInteger(inFlight) && Number.isInteger(maximum) && inFlight < maximum
}

class VisionFrameServer {
  constructor({ host = '127.0.0.1', port, token = '', frameStore, logger, maxBytes, maxConcurrentUploads = 2, onFrame = null }) {
    if (!['127.0.0.1', '::1', 'localhost'].includes(host)) throw new Error('Vision bridge host must be loopback')
    this.host = host
    this.port = port
    this.token = token
    this.frameStore = frameStore
    this.logger = logger
    this.maxBytes = maxBytes
    this.maxConcurrentUploads = maxConcurrentUploads
    this.onFrame = onFrame
    this.inFlight = 0
    this.server = null
  }

  async start() {
    if (this.server) return
    this.server = http.createServer((request, response) => this.#handle(request, response))
    await new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(this.port, this.host, resolve)
    })
    this.logger?.info(`[VISION] local frame bridge listening on ${this.host}:${this.port}`)
  }

  async stop() {
    if (!this.server) return
    const server = this.server
    this.server = null
    await new Promise(resolve => server.close(resolve))
  }

  #reply(response, status, body) {
    response.writeHead(status, { 'Content-Type': 'application/json', Connection: 'close' })
    response.end(JSON.stringify(body))
  }

  #handle(request, response) {
    if (!isLoopback(request.socket.remoteAddress)) return this.#reply(response, 403, { error: 'LOOPBACK_ONLY' })
    if (request.method !== 'POST' || request.url !== '/v1/frames') return this.#reply(response, 404, { error: 'NOT_FOUND' })
    if (this.token && header(request, 'x-ai-companion-token') !== this.token) return this.#reply(response, 401, { error: 'UNAUTHORIZED' })
    if (header(request, 'content-type') !== 'image/png') return this.#reply(response, 415, { error: 'PNG_REQUIRED' })
    if (!hasUploadCapacity(this.inFlight, this.maxConcurrentUploads)) return this.#reply(response, 429, { error: 'BACKPRESSURE' })
    const declared = Number(header(request, 'content-length'))
    if (!Number.isFinite(declared) || declared < 1 || declared > this.maxBytes) return this.#reply(response, 413, { error: 'INVALID_SIZE' })

    this.inFlight += 1
    const chunks = []
    let bytes = 0
    let rejected = false
    request.on('data', chunk => {
      bytes += chunk.length
      if (bytes > this.maxBytes) {
        rejected = true
        request.destroy()
      } else chunks.push(chunk)
    })
    request.on('end', () => {
      this.inFlight -= 1
      if (rejected) return
      try {
        const camera = JSON.parse(header(request, 'x-ai-companion-camera') || 'null')
        const result = this.frameStore.accept(Buffer.concat(chunks), {
          id: header(request, 'x-ai-companion-frame-id'),
          capturedAt: header(request, 'x-ai-companion-captured-at'),
          perspective: header(request, 'x-ai-companion-perspective'),
          uiState: header(request, 'x-ai-companion-ui-state'),
          signature: header(request, 'x-ai-companion-signature'),
          dimension: header(request, 'x-ai-companion-dimension'),
          camera
        })
        if (!result.accepted) return this.#reply(response, 202, { accepted: false, reason: result.reason })
        this.logger?.throttled?.('vision-frame-received', 5000, 'info', '[VISION] frame received')
        this.onFrame?.(result.frame)
        this.#reply(response, 202, { accepted: true, frameId: result.frame.id })
      } catch (error) {
        this.#reply(response, 400, { error: 'MALFORMED_FRAME', message: error.message })
      }
    })
    request.on('error', () => { this.inFlight = Math.max(0, this.inFlight - 1) })
  }
}

module.exports = { VisionFrameServer, isLoopback, hasUploadCapacity }
