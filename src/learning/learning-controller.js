const { GOAL_SOURCES, GOAL_STATES } = require('../goals')
const { LOCOMOTION_OWNERS } = require('../skills')
const { LearningEpisode, EPISODE_OUTCOMES } = require('./episode')
const { EpisodeBudget } = require('./budget')
const { EVALUATION, objectiveSatisfied, evaluateAttempt } = require('./evaluator')
const { actionShape } = require('./memory-store')
const { EpisodeExplorationState } = require('./exploration-state')
const { isOllamaPreempted, isStructuredResponseError } = require('../ollama')

const OAK_LOG_EXPERIMENT = Object.freeze({
  id: 'obtain-oak-log',
  pattern: 'obtain oak_log',
  description: 'Obtain at least one oak_log.',
  objective: { type: 'INVENTORY_AT_LEAST', item: 'oak_log', count: 1 },
  source: GOAL_SOURCES.AUTONOMOUS
})

function createOakLogGoal({ source = GOAL_SOURCES.AUTONOMOUS, requestedBy = null, request = null } = {}) {
  return {
    ...OAK_LOG_EXPERIMENT,
    objective: { ...OAK_LOG_EXPERIMENT.objective },
    source,
    requestedBy,
    request
  }
}

class LearningController {
  constructor({ movement, goalManager, observer, executor, client, memory, autonomy = null, logger, config, now = Date.now, sleep = null }) {
    this.movement = movement
    this.goalManager = goalManager
    this.observer = observer
    this.executor = executor
    this.client = client
    this.memory = memory
    this.autonomy = autonomy
    this.logger = logger
    this.config = config
    this.now = now
    this.sleep = sleep || (duration => new Promise(resolve => setTimeout(resolve, duration)))
    this.started = false
    this.timer = null
    this.episode = null
    this.generation = 0
    this.nextEpisodeId = 1
    this.runPromise = null
    this.memoryLoadPromise = null
    this.pendingPlayerTask = null
  }

  async start() {
    if (this.started || !this.config.enabled) return false
    this.started = true
    await this.#ensureMemoryLoaded()
    if (!this.started) return false
    this.timer = setTimeout(() => {
      this.timer = null
      void this.runExperiment().catch(error => this.logger.error('[LEARN] Experiment crashed', error))
    }, this.config.startDelayMs)
    this.logger.info(`Learning Agent enabled; controlled experiment begins in ${this.config.startDelayMs}ms`)
    return true
  }

  stop() {
    this.started = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    return this.cancel('LEARNING_STOPPED')
  }

  isActive() {
    return Boolean(this.episode && this.episode.outcome === EPISODE_OUTCOMES.RUNNING)
  }

  async runExperiment(goal = OAK_LOG_EXPERIMENT) {
    if (this.runPromise || this.isActive()) return this.runPromise
    this.runPromise = this.#run(goal).finally(() => { this.runPromise = null })
    return this.runPromise
  }

  startPlayerTask({ username, message, goal = null }) {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const playerGoal = goal || createOakLogGoal({
      source: GOAL_SOURCES.PLAYER_TASK,
      requestedBy: username,
      request: message
    })
    const previous = this.runPromise
    if (this.isActive()) this.cancel('PREEMPTED_BY_PLAYER_TASK')
    const pending = { goal: playerGoal, cancelled: false }
    this.pendingPlayerTask = pending
    this.movement.setLearningPending?.(true)
    this.autonomy?.setSuppressed(true, 'learning_episode')
    return Promise.resolve(previous)
      .catch(() => null)
      .then(() => this.#ensureMemoryLoaded())
      .then(async () => {
        while (
          this.pendingPlayerTask === pending &&
          !pending.cancelled &&
          [LOCOMOTION_OWNERS.PLAYER, LOCOMOTION_OWNERS.SURVIVAL].includes(this.movement.getLocomotionOwner())
        ) {
          await this.sleep(250)
        }
        if (this.pendingPlayerTask !== pending || pending.cancelled) return null
        this.pendingPlayerTask = null
        const running = this.runExperiment(playerGoal)
        this.movement.setLearningPending?.(false)
        return running
      })
      .finally(() => {
        if (this.pendingPlayerTask === pending) {
          this.pendingPlayerTask = null
          this.movement.setLearningPending?.(false)
          if (!this.isActive()) this.autonomy?.setSuppressed(false, 'learning_episode')
        }
      })
  }

  getTaskSummary() {
    if (this.pendingPlayerTask) {
      return {
        goal: this.pendingPlayerTask.goal.description,
        source: this.pendingPlayerTask.goal.source,
        attempts: 0,
        lastAction: null,
        lastEvaluation: null,
        outcome: 'PENDING'
      }
    }
    if (!this.episode) return null
    const last = this.episode.attempts.at(-1)
    return {
      goal: this.episode.goal.description,
      source: this.episode.goal.source,
      attempts: this.episode.attempts.length,
      lastAction: last?.action?.action || null,
      lastEvaluation: last?.evaluation?.status || null,
      outcome: this.episode.outcome
    }
  }

  cancel(reason = 'PLAYER_CANCELLED') {
    this.generation += 1
    let cancelled = false
    if (this.pendingPlayerTask) {
      this.pendingPlayerTask.cancelled = true
      this.pendingPlayerTask = null
      this.movement.setLearningPending?.(false)
      cancelled = true
    }
    const episode = this.episode
    if (!episode || episode.outcome !== EPISODE_OUTCOMES.RUNNING) {
      if (cancelled) this.autonomy?.setSuppressed(false, 'learning_episode')
      return cancelled
    }
    episode.finish(EPISODE_OUTCOMES.CANCELLED, reason, { finishedAt: this.now() })
    this.client.cancelPending?.()
    this.goalManager?.abandonSource(episode.goal.source || GOAL_SOURCES.AUTONOMOUS)
    this.#releaseEpisodeControl()
    this.episode = null
    void this.memory.recordEpisode(episode).catch(error => this.logger.error('Could not save cancelled learning episode', error))
    this.logger.info(`[LEARN] Episode cancelled (${reason})`)
    return true
  }

  async #run(goal) {
    const goalSource = goal.source || GOAL_SOURCES.AUTONOMOUS
    this.autonomy?.setSuppressed(true, 'learning_episode')
    if (!this.movement.beginLearningSession(goalSource)) {
      this.autonomy?.setSuppressed(false, 'learning_episode')
      this.logger.info('[LEARN] Experiment deferred because PLAYER or SURVIVAL owns locomotion')
      return null
    }

    this.goalManager?.abandonSource(GOAL_SOURCES.AUTONOMOUS)
    const requested = this.goalManager?.request({
      type: 'LEARNING_EPISODE',
      source: goalSource,
      payload: { goalId: goal.id },
      resumable: true,
      resumeWindowMs: this.config.maxDurationMs
    }) || { accepted: true, goal: null }
    if (!requested.accepted) {
      this.movement.endLearningSession()
      this.autonomy?.setSuppressed(false, 'learning_episode')
      return null
    }

    const token = ++this.generation
    const startedAt = this.now()
    const initialObservation = this.observer.capture({ startedAt })
    const explorationState = new EpisodeExplorationState({ maxRadius: this.config.exploreRadius ?? 16 })
    explorationState.observe(initialObservation)
    const episode = new LearningEpisode({
      id: `episode-${startedAt}-${this.nextEpisodeId++}`,
      goal,
      initialObservation,
      startedAt
    })
    this.episode = episode
    const budget = new EpisodeBudget({
      maxActions: this.config.maxActions,
      maxDurationMs: this.config.maxDurationMs,
      repeatedActionLimit: this.config.repeatedActionLimit,
      now: this.now
    })
    const learnedSkills = this.memory.findRelevantSkills(goal)
    let lastFeedbackLogIndex = 0
    this.logger.info(`[LEARN] Started ${episode.id}: ${goal.description}`)

    try {
      if (objectiveSatisfied(goal, initialObservation, initialObservation)) {
        episode.finish(EPISODE_OUTCOMES.SUCCESS, 'OBJECTIVE_ALREADY_SATISFIED', { finishedAt: this.now() })
        return await this.#finalize(episode, requested.goal, learnedSkills)
      }

      while (this.#isCurrent(token, episode)) {
        const budgetState = budget.check(episode)
        if (budgetState.exhausted) {
          episode.finish(EPISODE_OUTCOMES.FAILURE, budgetState.reason, { reflection: this.#episodeReflection(episode), lessons: this.#lessons(episode), finishedAt: this.now() })
          break
        }
        if (!await this.#waitForPriority(token, episode, budget)) break

        const observation = this.observer.capture({
          startedAt,
          goal,
          previousActionResult: episode.attempts.at(-1)?.actionResult || null,
          recentProgress: this.#recentProgress(episode)
        })
        const previousAttempt = episode.attempts.at(-1)
        if (previousAttempt && previousAttempt.index !== lastFeedbackLogIndex) {
          this.logger.info(`[LEARN] Previous: ${previousAttempt.action.action} -> ${previousAttempt.evaluation.status}`)
          if (previousAttempt.reflection?.lesson) {
            this.logger.info(`[LEARN] Lesson: ${this.#concise(previousAttempt.reflection.lesson)}`)
          }
          lastFeedbackLogIndex = previousAttempt.index
        }
        let action
        try {
          action = await this.client.decide({
            goal,
            observation,
            attempts: episode.attempts,
            learnedSkills,
            explorationState: explorationState.snapshot(),
            repetitionThreshold: Math.max(1, this.config.repeatedActionLimit - 1)
          })
        } catch (error) {
          if (isOllamaPreempted(error) && this.#isCurrent(token, episode)) {
            await this.sleep(0)
            continue
          }
          throw error
        }
        if (!this.#isCurrent(token, episode)) return episode
        if ([LOCOMOTION_OWNERS.SURVIVAL, LOCOMOTION_OWNERS.PLAYER].includes(this.movement.getLocomotionOwner())) continue
        const afterInferenceBudget = budget.check(episode)
        if (afterInferenceBudget.exhausted) {
          episode.finish(EPISODE_OUTCOMES.FAILURE, afterInferenceBudget.reason, { reflection: this.#episodeReflection(episode), lessons: this.#lessons(episode), finishedAt: this.now() })
          break
        }
        this.logger.info(`[LEARN] Next: ${this.#actionSummary(action)}`)

        const observationBefore = this.observer.capture({
          startedAt,
          target: action.target,
          goal,
          previousActionResult: episode.attempts.at(-1)?.actionResult || null,
          recentProgress: this.#recentProgress(episode)
        })
        let actionExceededTimeBudget = false
        const actionResult = await this.executor.execute(action, {
          explorationState,
          goal,
          isCancelled: () => {
            actionExceededTimeBudget = this.now() - episode.startedAt >= this.config.maxDurationMs
            return actionExceededTimeBudget || !this.#isCurrent(token, episode)
          }
        })
        if (!this.#isCurrent(token, episode)) return episode
        if (actionResult.yielded) {
          this.logger.info('[LEARN] Visual perception yielded to higher-priority model work; retrying without consuming an attempt')
          await this.sleep(0)
          continue
        }
        if (['EXPLORE', 'MOVE_NEAR'].includes(action.action)) {
          this.logger.info(`[LEARN] Intention ${action.action} ended: ${actionResult.reason}; returning evidence for replanning`)
        }
        const observationAfter = this.observer.capture({
          previousInventory: observationBefore.inventory,
          target: action.target,
          startedAt,
          actionResult,
          goal,
          previousActionResult: actionResult,
          recentProgress: this.#recentProgress(episode)
        })
        if (action.action === 'EXPLORE') explorationState.recordExploration(action, actionResult)
        explorationState.observe(observationAfter)
        const evaluation = evaluateAttempt({
          goal,
          initialObservation,
          observationBefore,
          observationAfter,
          actionResult
        })
        const attempt = episode.addAttempt({ observationBefore, action, observationAfter, actionResult, evaluation, reflection: null })
        if (actionExceededTimeBudget) {
          episode.finish(EPISODE_OUTCOMES.FAILURE, 'TIME_BUDGET_EXCEEDED', { reflection: this.#episodeReflection(episode), lessons: this.#lessons(episode), finishedAt: this.now() })
          break
        }
        if (
          [EVALUATION.FAILURE, EVALUATION.NO_PROGRESS].includes(evaluation.status) &&
          actionResult.reason !== 'PLAYER_PREEMPTED'
        ) {
          try {
            const reflection = await this.client.reflect({ observationBefore, action, observationAfter, evaluation })
            if (!this.#isCurrent(token, episode)) return episode
            attempt.reflection = reflection
          } catch (error) {
            if (!isOllamaPreempted(error)) throw error
          }
        }
        this.logger.info(`[LEARN] Attempt ${episode.attempts.length}: ${action.action} -> ${evaluation.status}`)

        if (evaluation.status === EVALUATION.SUCCESS) {
          episode.finish(EPISODE_OUTCOMES.SUCCESS, 'OBJECTIVE_CONFIRMED', { reflection: this.#episodeReflection(episode), lessons: this.#lessons(episode), finishedAt: this.now() })
          break
        }
        await this.sleep(0)
      }

      if (episode.outcome === EPISODE_OUTCOMES.RUNNING) {
        episode.finish(EPISODE_OUTCOMES.FAILURE, 'LEARNING_INTERRUPTED', { reflection: this.#episodeReflection(episode), lessons: this.#lessons(episode), finishedAt: this.now() })
      }
      return await this.#finalize(episode, requested.goal, learnedSkills)
    } catch (error) {
      if (episode.outcome === EPISODE_OUTCOMES.RUNNING) {
        const reason = isStructuredResponseError(error)
          ? `MODEL_RESPONSE_FAILURE:${error.status}`
          : `MODEL_OR_LOOP_ERROR: ${error.message}`
        episode.finish(EPISODE_OUTCOMES.FAILURE, reason, {
          reflection: this.#episodeReflection(episode),
          lessons: this.#lessons(episode),
          finishedAt: this.now()
        })
      }
      this.logger.error('[LEARN] Episode failed', error)
      return await this.#finalize(episode, requested.goal, learnedSkills)
    }
  }

  async #waitForPriority(token, episode, budget) {
    while (
      this.#isCurrent(token, episode) &&
      [LOCOMOTION_OWNERS.SURVIVAL, LOCOMOTION_OWNERS.PLAYER].includes(this.movement.getLocomotionOwner())
    ) {
      if (budget.check(episode).reason === 'TIME_BUDGET_EXCEEDED') {
        episode.finish(EPISODE_OUTCOMES.FAILURE, 'TIME_BUDGET_EXCEEDED', { reflection: this.#episodeReflection(episode), lessons: this.#lessons(episode), finishedAt: this.now() })
        return false
      }
      await this.sleep(250)
    }
    return this.#isCurrent(token, episode)
  }

  async #finalize(episode, goal, learnedSkills) {
    if (this.episode !== episode) return episode
    try {
      const usedSkill = this.#usedSkill(episode, learnedSkills)
      const learned = await this.memory.recordEpisode(episode)
      if (usedSkill && usedSkill.id !== learned?.id) {
        await this.memory.updateSkillOutcome(usedSkill.id, episode.outcome === EPISODE_OUTCOMES.SUCCESS)
      }
    } catch (error) {
      this.logger.error('[LEARN] Could not persist episode memory', error)
    }
    if (goal?.id && this.goalManager?.current?.id === goal.id) {
      this.goalManager.complete(goal.id, episode.outcome === EPISODE_OUTCOMES.SUCCESS ? GOAL_STATES.COMPLETED : GOAL_STATES.FAILED)
    } else {
      this.goalManager?.abandonSource(episode.goal.source || GOAL_SOURCES.AUTONOMOUS)
    }
    this.#releaseEpisodeControl()
    this.episode = null
    this.logger.info(`[LEARN] ${episode.id} ended ${episode.outcome}: ${episode.terminationReason}`)
    return episode
  }

  #releaseEpisodeControl() {
    this.movement.endLearningSession()
    this.autonomy?.setSuppressed(false, 'learning_episode')
  }

  #ensureMemoryLoaded() {
    if (!this.memoryLoadPromise) this.memoryLoadPromise = Promise.resolve(this.memory.load())
    return this.memoryLoadPromise
  }

  #isCurrent(token, episode) {
    return token === this.generation && this.episode === episode && episode.outcome === EPISODE_OUTCOMES.RUNNING
  }

  #lessons(episode) {
    return episode.attempts.map(attempt => attempt.reflection?.lesson).filter(Boolean)
  }

  #recentProgress(episode) {
    return episode.attempts.slice(-5).map(attempt => ({
      action: attempt.action.action,
      evaluation: attempt.evaluation.status,
      reason: attempt.evaluation.reason
    }))
  }

  #episodeReflection(episode) {
    return [...episode.attempts].reverse().find(attempt => attempt.reflection)?.reflection?.reflection || null
  }

  #usedSkill(episode, skills) {
    const actions = episode.attempts.map(attempt => JSON.stringify(actionShape(attempt.action)))
    return skills.find(skill => {
      const steps = skill.steps.map(step => JSON.stringify(actionShape(step)))
      if (!steps.length || steps.length > actions.length) return false
      return actions.some((_, start) => steps.every((step, index) => actions[start + index] === step))
    }) || null
  }

  #concise(text, maxLength = 140) {
    return String(text).replace(/\s+/g, ' ').trim().slice(0, maxLength)
  }

  #actionSummary(action) {
    if (action.action === 'LOOK_VISUALLY') return 'LOOK_VISUALLY (perception only; locomotion unchanged)'
    if (action.action === 'EXPLORE') return `EXPLORE heading=${action.heading} distance=${action.distance}`
    if (action.target) return `${action.action} target=${action.target}`
    return action.action
  }
}

module.exports = { LearningController, OAK_LOG_EXPERIMENT, createOakLogGoal }
