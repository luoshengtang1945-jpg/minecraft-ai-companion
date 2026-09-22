const { EVALUATION } = require('./evaluator')

const EPISODE_OUTCOMES = Object.freeze({
  RUNNING: 'RUNNING',
  SUCCESS: 'SUCCESS',
  FAILURE: 'FAILURE',
  CANCELLED: 'CANCELLED'
})

class LearningEpisode {
  constructor({ id, goal, initialObservation, startedAt = Date.now() }) {
    this.id = id
    this.goal = goal
    this.initialObservation = initialObservation
    this.attempts = []
    this.outcome = EPISODE_OUTCOMES.RUNNING
    this.terminationReason = null
    this.reflection = null
    this.lessons = []
    this.startedAt = startedAt
    this.finishedAt = null
    this.durationMs = null
  }

  addAttempt({ observationBefore, action, observationAfter, actionResult, evaluation, reflection = null }) {
    if (this.outcome !== EPISODE_OUTCOMES.RUNNING) throw new Error('Cannot add an attempt to a finished episode')
    const attempt = {
      index: this.attempts.length + 1,
      observationBefore,
      action,
      observationAfter,
      actionResult,
      evaluation,
      reflection
    }
    this.attempts.push(attempt)
    return attempt
  }

  finish(outcome, reason, { reflection = null, lessons = [], finishedAt = Date.now() } = {}) {
    if (!Object.values(EPISODE_OUTCOMES).includes(outcome) || outcome === EPISODE_OUTCOMES.RUNNING) {
      throw new Error(`Invalid terminal episode outcome: ${outcome}`)
    }
    if (this.outcome !== EPISODE_OUTCOMES.RUNNING) return false
    this.outcome = outcome
    this.terminationReason = reason
    this.reflection = reflection
    this.lessons = lessons.filter(Boolean)
    this.finishedAt = finishedAt
    this.durationMs = Math.max(0, finishedAt - this.startedAt)
    return true
  }

  hasObjectiveSuccess() {
    return this.attempts.some(attempt => attempt.evaluation?.status === EVALUATION.SUCCESS)
  }

  toJSON() {
    return { ...this }
  }
}

module.exports = { LearningEpisode, EPISODE_OUTCOMES }
