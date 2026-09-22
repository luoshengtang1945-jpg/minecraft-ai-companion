const { canonicalAction } = require('./action-schema')
const { EVALUATION } = require('./evaluator')

class EpisodeBudget {
  constructor({ maxActions, maxDurationMs, repeatedActionLimit, now = Date.now }) {
    this.maxActions = maxActions
    this.maxDurationMs = maxDurationMs
    this.repeatedActionLimit = repeatedActionLimit
    this.now = now
  }

  check(episode) {
    if (episode.attempts.length >= this.maxActions) return { exhausted: true, reason: 'ACTION_BUDGET_EXCEEDED' }
    if (this.now() - episode.startedAt >= this.maxDurationMs) return { exhausted: true, reason: 'TIME_BUDGET_EXCEEDED' }
    if (this.#repeatedFailures(episode) >= this.repeatedActionLimit) {
      return { exhausted: true, reason: 'REPEATED_ACTION_LIMIT' }
    }
    return { exhausted: false, reason: null }
  }

  #repeatedFailures(episode) {
    let key = null
    let count = 0
    for (let index = episode.attempts.length - 1; index >= 0; index -= 1) {
      const attempt = episode.attempts[index]
      if (![EVALUATION.FAILURE, EVALUATION.NO_PROGRESS].includes(attempt.evaluation?.status)) break
      const current = canonicalAction(attempt.action)
      if (key === null) key = current
      if (current !== key) break
      count += 1
    }
    return count
  }
}

module.exports = { EpisodeBudget }
