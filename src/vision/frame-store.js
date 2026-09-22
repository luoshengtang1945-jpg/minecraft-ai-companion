const crypto = require('node:crypto')

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const PERSPECTIVES = new Set(['HUMAN_CLIENT_CAMERA', 'COMPANION_CAMERA', 'DEFINED_PERCEPTION_CAMERA'])

function parsePngDimensions(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24 || !buffer.subarray(0, 8).equals(PNG_MAGIC)) throw new Error('Frame must be a valid PNG')
  if (buffer.toString('ascii', 12, 16) !== 'IHDR') throw new Error('PNG is missing IHDR')
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

function normalizeSignature(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{16,512}$/i.test(value)) return null
  return value.toLowerCase()
}

function signatureDistance(a, b) {
  if (!a || !b || a.length !== b.length) return 1
  let changed = 0
  for (let index = 0; index < a.length; index += 2) {
    changed += Math.abs(parseInt(a.slice(index, index + 2), 16) - parseInt(b.slice(index, index + 2), 16)) / 255
  }
  return changed / (a.length / 2)
}

class FrameStore {
  constructor({ maxBytes = 2_000_000, maxWidth = 1920, maxHeight = 1080, maxAgeMs = 15000, now = Date.now } = {}) {
    this.maxBytes = maxBytes
    this.maxWidth = maxWidth
    this.maxHeight = maxHeight
    this.maxAgeMs = maxAgeMs
    this.now = now
    this.latest = null
    this.dropped = 0
    this.received = 0
  }

  accept(buffer, metadata = {}) {
    this.received += 1
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('Frame body is empty')
    if (buffer.length > this.maxBytes) throw new Error(`Frame exceeds ${this.maxBytes} bytes`)
    const dimensions = parsePngDimensions(buffer)
    if (dimensions.width < 1 || dimensions.height < 1 || dimensions.width > this.maxWidth || dimensions.height > this.maxHeight) {
      throw new Error(`Frame dimensions exceed ${this.maxWidth}x${this.maxHeight}`)
    }
    if (!PERSPECTIVES.has(metadata.perspective)) throw new Error('Frame perspective is invalid')
    const uiState = metadata.uiState || 'OTHER_SCREEN'
    if (!['GAMEPLAY', 'MENU', 'CHAT', 'INVENTORY', 'OTHER_SCREEN'].includes(uiState)) throw new Error('Invalid frame UI state')
    const capturedAt = Number(metadata.capturedAt)
    if (!Number.isFinite(capturedAt) || capturedAt > this.now() + 5000) throw new Error('Frame capturedAt is invalid')
    if (this.now() - capturedAt > this.maxAgeMs) { this.dropped += 1; return { accepted: false, reason: 'STALE_FRAME' } }
    if (this.latest && capturedAt <= this.latest.capturedAt) { this.dropped += 1; return { accepted: false, reason: 'SUPERSEDED_FRAME' } }
    if (this.latest) this.dropped += 1
    this.latest = Object.freeze({
      id: String(metadata.id || crypto.randomUUID()).slice(0, 100),
      capturedAt,
      receivedAt: this.now(),
      perspective: metadata.perspective,
      uiState,
      width: dimensions.width,
      height: dimensions.height,
      signature: normalizeSignature(metadata.signature),
      camera: isFiniteCamera(metadata.camera) ? Object.freeze({ ...metadata.camera }) : null,
      dimension: typeof metadata.dimension === 'string' ? metadata.dimension.slice(0, 100) : null,
      buffer
    })
    return { accepted: true, frame: this.latest, replaced: this.dropped > 0 }
  }

  getLatest({ maxAgeMs = this.maxAgeMs } = {}) {
    if (!this.latest || this.now() - this.latest.capturedAt > maxAgeMs) return null
    return this.latest
  }
}

function isFiniteCamera(camera) {
  if (!camera || typeof camera !== 'object') return false
  return ['x', 'y', 'z', 'yaw', 'pitch'].every(key => Number.isFinite(camera[key]))
}

module.exports = { FrameStore, parsePngDimensions, signatureDistance, PERSPECTIVES }
