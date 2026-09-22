const EVALUATION = Object.freeze({
  SUCCESS: 'SUCCESS',
  FAILURE: 'FAILURE',
  NO_PROGRESS: 'NO_PROGRESS',
  PARTIAL_PROGRESS: 'PARTIAL_PROGRESS'
})

function itemCount(observation, item) {
  return observation?.inventory?.[item] || 0
}

function objectiveSatisfied(goal, observation, initialObservation) {
  if (goal.objective?.type !== 'INVENTORY_AT_LEAST') return false
  const current = itemCount(observation, goal.objective.item)
  const initial = itemCount(initialObservation, goal.objective.item)
  return current >= goal.objective.count && (initial >= goal.objective.count || current > initial)
}

function targetChanged(before, after) {
  if (!before?.targetState && !after?.targetState) return false
  return JSON.stringify(before?.targetState || null) !== JSON.stringify(after?.targetState || null)
}

function evaluateAttempt({ goal, initialObservation, observationBefore, observationAfter, actionResult }) {
  if (objectiveSatisfied(goal, observationAfter, initialObservation)) {
    return { status: EVALUATION.SUCCESS, reason: 'Objective confirmed by observed inventory' }
  }
  if (!actionResult?.success) {
    return { status: EVALUATION.FAILURE, reason: actionResult?.reason || 'Primitive action failed' }
  }

  const item = goal.objective?.item
  const beforeCount = item ? itemCount(observationBefore, item) : 0
  const afterCount = item ? itemCount(observationAfter, item) : 0
  const targetItemDelta = item ? (observationAfter?.inventoryDelta?.[item] || afterCount - beforeCount) : 0
  if (actionResult.reason === 'SYMBOLIC_DISCOVERY') {
    const beforeRefs = new Set([...(observationBefore.nearbyBlocks || []), ...(observationBefore.nearbyEntities || [])].map(entry => entry.ref))
    const after = [...(observationAfter.nearbyBlocks || []), ...(observationAfter.nearbyEntities || [])]
    const confirmed = (actionResult.evidence || []).some(evidence => !beforeRefs.has(evidence.ref) && after.some(entry => entry.ref === evidence.ref && entry.name === evidence.name))
    if (confirmed) return { status: EVALUATION.PARTIAL_PROGRESS, reason: 'New watched symbolic evidence confirmed; replan intention' }
  }
  if (targetItemDelta > 0 || targetChanged(observationBefore, observationAfter)) {
    return { status: EVALUATION.PARTIAL_PROGRESS, reason: 'Observed state changed but objective is not complete' }
  }
  return { status: EVALUATION.NO_PROGRESS, reason: 'No objective-relevant change was observed' }
}

module.exports = { EVALUATION, objectiveSatisfied, evaluateAttempt }
