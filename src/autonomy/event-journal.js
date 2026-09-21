class EventJournal {
  constructor({ limit = 30, now = Date.now } = {}) {
    this.limit = limit
    this.now = now
    this.events = []
  }

  record(type, detail = '') {
    this.events.push({ at: this.now(), type, detail: String(detail).slice(0, 160) })
    if (this.events.length > this.limit) this.events.splice(0, this.events.length - this.limit)
  }

  recent(count = 8) {
    return this.events.slice(-count)
  }
}

module.exports = { EventJournal }
