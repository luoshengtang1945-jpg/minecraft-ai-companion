const fs = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')

const EMPTY_MEMORY = Object.freeze({ version: 1, episodes: [], skills: [] })

function normalizeGoalPattern(goal) {
  return String(goal.pattern || goal.description || goal.id || '').toLowerCase().trim()
}

function tokens(value) {
  return new Set(String(value).toLowerCase().split(/[^a-z0-9_]+/).filter(token => token.length > 1))
}

function relevance(pattern, query) {
  const left = tokens(pattern)
  const right = tokens(query)
  if (!left.size || !right.size) return 0
  let common = 0
  for (const token of left) if (right.has(token)) common += 1
  return common / Math.max(left.size, right.size)
}

function actionShape(action) {
  const shape = { action: action.action }
  if (typeof action.target === 'string') shape.targetKind = action.target.split(':', 1)[0]
  if (Number.isFinite(action.distance)) shape.distance = action.distance
  if (Number.isFinite(action.durationMs)) shape.durationMs = action.durationMs
  if (Number.isInteger(action.slot)) shape.slot = action.slot
  return shape
}

function skillFromSuccessfulEpisode(episode, now = Date.now) {
  if (episode.outcome !== 'SUCCESS' || !episode.hasObjectiveSuccess?.()) return null
  // The episode retains every attempt. A reusable candidate contains only
  // attempts with objective-relevant progress, never failed detours.
  const contributingAttempts = episode.attempts.filter(attempt =>
    ['PARTIAL_PROGRESS', 'SUCCESS'].includes(attempt.evaluation?.status))
  const steps = contributingAttempts.map(attempt => attempt.action)
  const evidence = contributingAttempts.map(attempt => ({
    target: attempt.observationBefore?.targetState ? {
      name: attempt.observationBefore.targetState.name || null,
      type: attempt.observationBefore.targetState.type || null,
      ...(attempt.observationBefore.targetState.droppedItem?.name
        ? { droppedItem: attempt.observationBefore.targetState.droppedItem.name } : {})
    } : null,
    evaluation: attempt.evaluation?.status || null
  }))
  if (!steps.length) return null
  const targetBlocks = [...new Set(evidence.filter(entry => Number.isInteger(entry.target?.type))
    .map(entry => entry.target?.name).filter(Boolean))].slice(0, 12)
  const targetDrops = [...new Set(evidence.map(entry => entry.target?.droppedItem).filter(Boolean))].slice(0, 8)
  const initialInventory = Object.keys(episode.initialObservation.inventory || {}).sort()
  const fingerprint = crypto.createHash('sha256')
    .update(JSON.stringify({
      goal: normalizeGoalPattern(episode.goal),
      steps: steps.map((step, index) => ({ ...actionShape(step),
        targetName: evidence[index].target?.droppedItem || evidence[index].target?.name || null }))
    }))
    .digest('hex').slice(0, 12)
  return {
    id: `learned-${fingerprint}`,
    goalPattern: normalizeGoalPattern(episode.goal),
    preconditions: { targetBlocks, targetDrops, initialInventory },
    steps,
    evidence,
    confidence: 2 / 3,
    successes: 1,
    failures: 0,
    createdAt: new Date(now()).toISOString(),
    lastUsedAt: new Date(now()).toISOString(),
    sourceEpisodeId: episode.id
  }
}

class LearningMemoryStore {
  constructor({ filePath, now = Date.now, maxEpisodes = 100 }) {
    this.filePath = path.resolve(filePath)
    this.now = now
    this.maxEpisodes = maxEpisodes
    this.data = { ...EMPTY_MEMORY, episodes: [], skills: [] }
    this.saveQueue = Promise.resolve()
    this.saveSequence = 0
  }

  async load() {
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, 'utf8'))
      this.data = {
        version: 1,
        episodes: Array.isArray(parsed.episodes) ? parsed.episodes : [],
        skills: Array.isArray(parsed.skills) ? parsed.skills : []
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    return this.snapshot()
  }

  snapshot() {
    return JSON.parse(JSON.stringify(this.data))
  }

  async recordEpisode(episode) {
    const serialized = episode.toJSON ? episode.toJSON() : episode
    this.data.episodes.push(serialized)
    if (this.data.episodes.length > this.maxEpisodes) this.data.episodes.splice(0, this.data.episodes.length - this.maxEpisodes)

    let skill = null
    if (serialized.outcome === 'SUCCESS') {
      skill = skillFromSuccessfulEpisode(episode, this.now)
      if (skill) {
        const existing = this.data.skills.find(candidate => candidate.id === skill.id)
        if (existing) {
          existing.successes += 1
          existing.confidence = this.#confidence(existing)
          existing.lastUsedAt = new Date(this.now()).toISOString()
        } else {
          this.data.skills.push(skill)
        }
      }
    }
    await this.save()
    return skill
  }

  findRelevantSkills(goal, limit = 3) {
    const query = normalizeGoalPattern(goal)
    return this.data.skills
      .map(skill => ({ skill, score: relevance(skill.goalPattern, query) }))
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score || b.skill.confidence - a.skill.confidence)
      .slice(0, limit)
      .map(item => JSON.parse(JSON.stringify(item.skill)))
  }

  async updateSkillOutcome(skillId, succeeded) {
    const skill = this.data.skills.find(candidate => candidate.id === skillId)
    if (!skill) return false
    if (succeeded) skill.successes += 1
    else skill.failures += 1
    skill.confidence = this.#confidence(skill)
    skill.lastUsedAt = new Date(this.now()).toISOString()
    await this.save()
    return true
  }

  async save() {
    const content = `${JSON.stringify(this.data, null, 2)}\n`
    const sequence = ++this.saveSequence
    this.saveQueue = this.saveQueue.catch(() => {}).then(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true })
      const temporary = `${this.filePath}.${process.pid}.${sequence}.tmp`
      try {
        await fs.writeFile(temporary, content, 'utf8')
        await fs.rename(temporary, this.filePath)
      } finally {
        await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error })
      }
    })
    return this.saveQueue
  }

  #confidence(skill) {
    return (skill.successes + 1) / (skill.successes + skill.failures + 2)
  }
}

module.exports = {
  LearningMemoryStore,
  skillFromSuccessfulEpisode,
  normalizeGoalPattern,
  relevance,
  actionShape
}
