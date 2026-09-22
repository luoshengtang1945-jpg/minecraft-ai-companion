const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { validatePrimitiveAction, EpisodeExplorationState, selectExplorationDestination } = require('../src/learning')
const { decisionPayload, learningFeedback } = require('../src/learning/prompt')

function attempt(action, index, reflection = null) {
  return {
    index,
    action,
    actionResult: { success: true, reason: 'OBSERVATION_CAPTURED' },
    evaluation: { status: 'NO_PROGRESS', reason: 'No objective-relevant change was observed' },
    reflection
  }
}

function vector(x, y, z) {
  return { x, y, z, offset(dx, dy, dz) { return vector(x + dx, y + dy, z + dz) } }
}

function safeBot(origin = vector(0, 64, 0)) {
  return {
    entity: { position: origin },
    blockAt(position) {
      if (position.y === 63) return { name: 'stone', boundingBox: 'block' }
      return { name: 'air', boundingBox: 'empty' }
    }
  }
}

test('latest reflection and suggested approach are explicit in the next decision payload', () => {
  const reflection = {
    reflection: 'The observation did not reveal a target.',
    lesson: 'Repeated observation found no new target.',
    nextApproach: 'Move into a different nearby area.'
  }
  const attempts = [attempt({ action: 'OBSERVE' }, 1, reflection)]
  const payload = decisionPayload({
    goal: { description: 'Obtain one target_item.' },
    observation: { nearbyBlocks: [] },
    attempts,
    learnedSkills: [],
    explorationState: { recentObservedRegions: [] }
  })

  assert.deepEqual(payload.learningFeedback.previousAction, { action: 'OBSERVE' })
  assert.equal(payload.learningFeedback.evaluation.status, 'NO_PROGRESS')
  assert.equal(payload.learningFeedback.reflection, reflection.reflection)
  assert.equal(payload.learningFeedback.lesson, reflection.lesson)
  assert.equal(payload.learningFeedback.suggestedNextApproach, reflection.nextApproach)
})

test('failed action signatures are counted and repeated no-progress is discouraged', () => {
  const attempts = [
    attempt({ action: 'OBSERVE' }, 1),
    attempt({ action: 'OBSERVE' }, 2)
  ]
  const feedback = learningFeedback(attempts, 2)
  assert.equal(feedback.recentFailedActionSignatures[0].count, 2)
  assert.deepEqual(feedback.discouragedActionSignatures, ['{"action":"OBSERVE"}'])
})

test('EXPLORE schema accepts only bounded heading and distance', () => {
  assert.deepEqual(validatePrimitiveAction({ action: 'EXPLORE', heading: 90, distance: 6 }), {
    action: 'EXPLORE', heading: 90, distance: 6
  })
  assert.throws(() => validatePrimitiveAction({ action: 'EXPLORE', heading: -1, distance: 6 }), /heading/)
  assert.equal(validatePrimitiveAction({ action: 'EXPLORE', heading: 90, distance: 24 }).distance, 24)
  assert.throws(() => validatePrimitiveAction({ action: 'EXPLORE', heading: 90, distance: 33 }), /distance/)
  assert.throws(() => validatePrimitiveAction({ action: 'EXPLORE', heading: 90, distance: 6, resource: 'anything' }), /Unexpected/)
})

test('exploration destination remains within the model-selected bound', () => {
  const bot = safeBot()
  const destination = selectExplorationDestination(bot, { heading: 90, distance: 8 })
  const distance = Math.hypot(destination.x - bot.entity.position.x, destination.z - bot.entity.position.z)
  assert.ok(distance >= 2)
  assert.ok(distance <= 8.1)
})

test('episode exploration tracks regions, destinations, and recent block observations', () => {
  const state = new EpisodeExplorationState({ regionSize: 4 })
  state.observe({
    position: { x: 0, y: 64, z: 0 },
    nearbyBlocks: [{ ref: 'block:1,63,0', name: 'stone' }]
  })
  state.recordExploration(
    { action: 'EXPLORE', heading: 90, distance: 6 },
    { success: true, reason: 'REACHED_TARGET', destination: { x: 6, y: 64, z: 0 } }
  )
  state.observe({
    position: { x: 6, y: 64, z: 0 },
    nearbyBlocks: [{ ref: 'block:6,63,1', name: 'sand' }]
  })
  const snapshot = state.snapshot()

  assert.equal(snapshot.recentObservedRegions.length, 2)
  assert.equal(snapshot.recentExploredDestinations[0].heading, 90)
  assert.deepEqual(snapshot.recentBlockObservations[0].names, ['sand'])
  assert.equal(state.novelty({ x: 6, y: 64, z: 0 }).visits, 1)
})

test('safe destination selection prefers a less observed region in the chosen heading', () => {
  const bot = safeBot()
  const state = new EpisodeExplorationState({ regionSize: 4 })
  state.observe({ position: { x: 8, y: 64, z: 0 }, nearbyBlocks: [] })
  const destination = selectExplorationDestination(bot, { heading: 90, distance: 8 }, state)
  assert.notEqual(state.regionKey(destination), state.regionKey({ x: 8, y: 64, z: 0 }))
})

test('episode exploration cannot select a destination beyond its overall radius', () => {
  const bot = safeBot(vector(15, 64, 0))
  const state = new EpisodeExplorationState({ maxRadius: 16 })
  state.observe({ position: { x: 0, y: 64, z: 0 }, nearbyBlocks: [] })
  const destination = selectExplorationDestination(bot, { heading: 90, distance: 8 }, state)
  assert.equal(destination, null)
})

test('generic exploration implementation contains no resource-specific search solution', () => {
  for (const file of ['exploration.js', 'exploration-state.js', 'intention-monitor.js']) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'learning', file), 'utf8')
    assert.doesNotMatch(source, /oak|tree|forest|log\b/i)
  }
})

test('intention monitor discovers objective evidence generically and requests visual reassessment', () => {
  const { IntentionMonitor } = require('../src/learning/intention-monitor')
  const initial = { nearbyBlocks: [], inventory: {}, multimodal: { visual: { frame: { id: 'one' }, observation: { sceneType: 'OPEN_TERRAIN' } } } }
  const monitor = new IntentionMonitor({ action: { action: 'EXPLORE' }, goal: { objective: { type: 'INVENTORY_AT_LEAST', item: 'synthetic_item', count: 1 } }, initialObservation: initial })
  assert.equal(monitor.check(initial), null)
  assert.equal(monitor.check({ ...initial, nearbyBlocks: [{ name: 'synthetic_item', ref: 'block:1,2,3' }] }).reason, 'SYMBOLIC_DISCOVERY')
  assert.equal(monitor.check({ ...initial, inventory: { synthetic_item: 1 } }).reason, 'OBJECTIVE_OBSERVED')
  assert.equal(monitor.check({ ...initial, multimodal: { visual: { frame: { id: 'two' }, observation: { sceneType: 'CAVE_LIKE' } } } }).reason, 'VISUAL_CONTEXT_CHANGED')
})
