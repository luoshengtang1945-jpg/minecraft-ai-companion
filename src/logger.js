function createLogger(output = console) {
  const lastLog = new Map()

  return {
    info(message, details) {
      details === undefined ? output.log(`[INFO] ${message}`) : output.log(`[INFO] ${message}`, details)
    },
    warn(message, details) {
      details === undefined ? output.warn(`[WARN] ${message}`) : output.warn(`[WARN] ${message}`, details)
    },
    error(message, error) {
      const details = error instanceof Error ? error.message : error
      details === undefined ? output.error(`[ERROR] ${message}`) : output.error(`[ERROR] ${message}:`, details)
    },
    throttled(key, intervalMs, level, message, details) {
      const now = Date.now()
      if (now - (lastLog.get(key) || 0) < intervalMs) return
      lastLog.set(key, now)
      this[level](message, details)
    }
  }
}

module.exports = { createLogger }
