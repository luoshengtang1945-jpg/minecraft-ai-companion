const { EventEmitter } = require('node:events')

const GOAL_SOURCES = Object.freeze({
  AUTONOMOUS: 'AUTONOMOUS',
  PLAYER_TASK: 'PLAYER_TASK',
  PLAYER: 'PLAYER',
  SURVIVAL: 'SURVIVAL'
})

const GOAL_PRIORITIES = Object.freeze({
  AUTONOMOUS: 10,
  PLAYER_TASK: 30,
  PLAYER: 50,
  SURVIVAL: 100
})

const GOAL_STATES = Object.freeze({
  ACTIVE: 'ACTIVE',
  PENDING: 'PENDING',
  INTERRUPTED: 'INTERRUPTED',
  COMPLETED: 'COMPLETED',
  ABANDONED: 'ABANDONED',
  FAILED: 'FAILED'
})

class GoalManager extends EventEmitter {
  constructor({ now = Date.now } = {}) {
    super()
    this.now = now
    this.current = null
    this.suspended = []
    this.pendingPlayer = null
    this.history = []
    this.nextId = 1
  }

  request({ type, source, priority, payload = {}, resumable = true, resumeWindowMs = 60000 }) {
    if (!Object.values(GOAL_SOURCES).includes(source)) throw new Error(`Invalid goal source: ${source}`)

    const goal = {
      id: this.nextId++,
      type,
      source,
      priority: priority ?? GOAL_PRIORITIES[source],
      payload,
      resumable,
      resumeUntil: this.now() + resumeWindowMs,
      status: GOAL_STATES.ACTIVE,
      createdAt: this.now(),
      startedAt: this.now(),
      finishedAt: null
    }

    if (this.current && goal.priority < this.current.priority) {
      if (this.current.source === GOAL_SOURCES.SURVIVAL && source === GOAL_SOURCES.PLAYER) {
        this.#abandonSuspendedAutonomy()
        if (this.pendingPlayer) this.#finish(this.pendingPlayer, GOAL_STATES.ABANDONED)
        goal.status = GOAL_STATES.PENDING
        goal.startedAt = null
        this.pendingPlayer = goal
        this.#emitChange('deferred', goal)
        return { accepted: true, deferred: true, goal }
      }
      return { accepted: false, deferred: false, goal: null }
    }

    if (this.current) this.#preemptCurrent(goal)
    this.current = goal
    this.#emitChange('started', goal)
    return { accepted: true, deferred: false, goal }
  }

  complete(goalId, status = GOAL_STATES.COMPLETED) {
    if (!this.current || this.current.id !== goalId) return false
    this.#finish(this.current, status)
    this.current = null
    this.#resumeNext()
    return true
  }

  abandonSource(source) {
    if (this.current?.source === source) this.complete(this.current.id, GOAL_STATES.ABANDONED)
    this.suspended = this.suspended.filter(goal => {
      if (goal.source !== source) return true
      this.#finish(goal, GOAL_STATES.ABANDONED)
      return false
    })
  }

  snapshot() {
    if (!this.current) return null
    const { id, type, source, priority, status, payload, startedAt } = this.current
    return { id, type, source, priority, status, payload, startedAt }
  }

  #preemptCurrent(incoming) {
    const previous = this.current
    if (
      previous.resumable &&
      (incoming.source === GOAL_SOURCES.SURVIVAL ||
        (incoming.source === GOAL_SOURCES.PLAYER && previous.source === GOAL_SOURCES.PLAYER_TASK))
    ) {
      previous.status = GOAL_STATES.INTERRUPTED
      this.suspended.push(previous)
      this.#emitChange('interrupted', previous)
    } else {
      this.#finish(previous, GOAL_STATES.ABANDONED)
    }
    this.current = null
  }

  #resumeNext() {
    if (this.pendingPlayer) {
      const pending = this.pendingPlayer
      this.pendingPlayer = null
      pending.status = GOAL_STATES.ACTIVE
      pending.startedAt = this.now()
      this.current = pending
      this.#emitChange('resumed', pending)
      return
    }

    while (this.suspended.length) {
      const goal = this.suspended.pop()
      if (!goal.resumable || goal.resumeUntil < this.now()) {
        this.#finish(goal, GOAL_STATES.ABANDONED)
        continue
      }
      goal.status = GOAL_STATES.ACTIVE
      goal.startedAt = this.now()
      this.current = goal
      this.#emitChange('resumed', goal)
      return
    }
  }

  #abandonSuspendedAutonomy() {
    this.suspended = this.suspended.filter(goal => {
      if (goal.source !== GOAL_SOURCES.AUTONOMOUS) return true
      this.#finish(goal, GOAL_STATES.ABANDONED)
      return false
    })
  }

  #finish(goal, status) {
    goal.status = status
    goal.finishedAt = this.now()
    this.history.push(goal)
    if (this.history.length > 50) this.history.shift()
    this.#emitChange(status.toLowerCase(), goal)
  }

  #emitChange(event, goal) {
    this.emit('changed', { event, goal: { ...goal }, current: this.snapshot() })
  }
}

module.exports = { GoalManager, GOAL_SOURCES, GOAL_PRIORITIES, GOAL_STATES }
