const OLLAMA_REQUEST_PRIORITIES = Object.freeze({
  PLAYER_VISUAL_PERCEPTION: 700,
  PLAYER_CONVERSATION: 600,
  PLAYER_TASK_DECISION: 500,
  TASK_VISUAL_PERCEPTION: 400,
  LEARNING_REFLECTION: 300,
  BACKGROUND_VISUAL_PERCEPTION: 200,
  AUTONOMY: 100
})

class OllamaRequestPreemptedError extends Error {
  constructor(message = 'Ollama request was preempted by higher-priority work', { preemptedBy = null } = {}) {
    super(message)
    this.name = 'OllamaRequestPreemptedError'
    this.preemptedBy = preemptedBy
  }
}

function isOllamaPreempted(error) {
  return error instanceof OllamaRequestPreemptedError
}

function signalWithTimeout(parentSignal, timeoutMs) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new Error('Ollama request timed out')), timeoutMs)
  const abortFromParent = () => controller.abort(parentSignal.reason)
  if (parentSignal?.aborted) abortFromParent()
  else parentSignal?.addEventListener('abort', abortFromParent, { once: true })
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timeout)
      parentSignal?.removeEventListener('abort', abortFromParent)
    }
  }
}

class OllamaRequestScheduler {
  constructor({ priorities = OLLAMA_REQUEST_PRIORITIES } = {}) {
    this.priorities = priorities
    this.queue = []
    this.current = null
    this.sequence = 0
  }

  schedule(kind, execute, { owner = kind } = {}) {
    const priority = this.priorities[kind]
    if (!Number.isFinite(priority)) return Promise.reject(new Error(`Unknown Ollama request kind: ${kind}`))
    if (typeof execute !== 'function') return Promise.reject(new Error('Ollama request executor must be a function'))

    const promise = new Promise((resolve, reject) => {
      const job = {
        id: ++this.sequence,
        kind,
        owner,
        priority,
        execute,
        resolve,
        reject,
        controller: new AbortController(),
        preempted: false,
        preemptedBy: null,
        cancelled: false
      }
      this.queue.push(job)
      this.#sortQueue()
      if (this.current && priority > this.current.priority) {
        this.current.preempted = true
        this.current.preemptedBy = kind
        this.current.controller.abort(new OllamaRequestPreemptedError(undefined, { preemptedBy: kind }))
      }
      this.#pump()
    })
    return promise
  }

  cancelOwner(owner) {
    let cancelled = 0
    this.queue = this.queue.filter(job => {
      if (job.owner !== owner) return true
      job.cancelled = true
      job.reject(new OllamaRequestPreemptedError('Ollama request was cancelled'))
      cancelled += 1
      return false
    })
    if (this.current?.owner === owner) {
      this.current.cancelled = true
      this.current.controller.abort(new OllamaRequestPreemptedError('Ollama request was cancelled'))
      cancelled += 1
    }
    return cancelled
  }

  isBusy() {
    return Boolean(this.current || this.queue.length)
  }

  snapshot() {
    return {
      current: this.current ? { kind: this.current.kind, owner: this.current.owner, priority: this.current.priority } : null,
      queued: this.queue.map(job => ({ kind: job.kind, owner: job.owner, priority: job.priority }))
    }
  }

  #sortQueue() {
    this.queue.sort((a, b) => b.priority - a.priority || a.id - b.id)
  }

  #pump() {
    if (this.current || !this.queue.length) return
    const job = this.queue.shift()
    this.current = job
    Promise.resolve()
      .then(() => job.execute({ signal: job.controller.signal }))
      .then(result => {
        if (job.preempted || job.cancelled) job.reject(new OllamaRequestPreemptedError(undefined, { preemptedBy: job.preemptedBy }))
        else job.resolve(result)
      })
      .catch(error => {
        if (job.preempted || job.cancelled) job.reject(new OllamaRequestPreemptedError(undefined, { preemptedBy: job.preemptedBy }))
        else job.reject(error)
      })
      .finally(() => {
        if (this.current === job) this.current = null
        this.#pump()
      })
  }
}

module.exports = {
  OllamaRequestScheduler,
  OLLAMA_REQUEST_PRIORITIES,
  OllamaRequestPreemptedError,
  isOllamaPreempted,
  signalWithTimeout
}
