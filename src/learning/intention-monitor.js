// Monitors evidence for a model-selected intention; contains no resource recipes.
class IntentionMonitor {
  constructor({ action, goal, initialObservation }) {
    this.goal = goal
    this.watched = new Set(action.watchFor || [])
    if (goal?.objective?.item) this.watched.add(goal.objective.item)
    this.seen = new Set(this.matches(initialObservation).map(item => item.ref))
    this.initialVisual = initialObservation.multimodal?.visual || null
  }

  matches(observation) {
    return [...(observation.nearbyBlocks || []), ...(observation.nearbyEntities || [])]
      .filter(item => this.watched.has(item.name))
  }

  check(observation) {
    const objective = this.goal?.objective
    if (objective?.type === 'INVENTORY_AT_LEAST' && (observation.inventory?.[objective.item] || 0) >= objective.count) {
      return { success: true, reason: 'OBJECTIVE_OBSERVED', replan: true }
    }
    const discovered = this.matches(observation).filter(item => !this.seen.has(item.ref))
    if (discovered.length) return { success: true, reason: 'SYMBOLIC_DISCOVERY', replan: true, evidence: discovered.slice(0, 8) }
    const visual = observation.multimodal?.visual
    if (this.initialVisual && visual && visual.frame.id !== this.initialVisual.frame.id &&
        visual.observation.sceneType !== this.initialVisual.observation.sceneType) {
      // A scene change warrants reassessment; it is not proof of contradiction.
      return { success: true, reason: 'VISUAL_CONTEXT_CHANGED', replan: true }
    }
    return null
  }
}

module.exports = { IntentionMonitor }
