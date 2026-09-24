// Real local-model reflection/decision coherence probe. No Minecraft connection or action execution.
const { localOllamaConfig } = require('./local-ollama-config')
const { LearningOllamaClient } = require('../src/learning')
const { createItemGoal, ITEM_NAME } = require('../src/learning/item-goal')

const item = process.argv.find(argument => argument.startsWith('--item='))?.slice('--item='.length) || 'birch_log'
const count = Number(process.argv.find(argument => argument.startsWith('--count='))?.split('=')[1] || 3)
if (!ITEM_NAME.test(item)) throw new Error('item must be a Minecraft-style symbolic name')
if (!Number.isInteger(count) || count < 1 || count > 10) throw new Error('count must be 1..10')

const block = { ref: 'block:3,64,0', name: item, distance: 3, diggable: true }
const observation = (position, blocks, entities = []) => ({
  position, health: 20, food: 20, inventory: {}, inventoryDelta: {},
  nearbyBlocks: blocks, nearbyEntities: entities, targetState: null, elapsedMs: 500
})

async function main() {
  const client = new LearningOllamaClient({ ollama: localOllamaConfig() })
  const goal = createItemGoal(item)
  const before = observation({ x: 0, y: 64, z: 0 }, [block])
  const afterMove = observation({ x: 0, y: 64, z: 0 }, [block])
  const moved = { action: 'MOVE_NEAR', target: block.ref, distance: 3 }
  const noProgress = { status: 'NO_PROGRESS', reason: 'Position and inventory unchanged' }
  const dropped = { ref: 'entity:7', name: 'item', type: 'other', distance: 3,
    position: { x: 3, y: 64, z: 0 }, droppedItem: { name: item, count: 1 } }
  const afterDig = observation({ x: 0, y: 64, z: 0 }, [], [dropped])

  for (let trial = 1; trial <= count; trial += 1) {
    const reflection = await client.reflect({
      observationBefore: before, action: moved, actionResult: { success: true, reason: 'ALREADY_NEAR_TARGET' },
      observationAfter: afterMove, evaluation: noProgress
    })
    const attempts = [{ observationBefore: before, action: moved, observationAfter: afterMove,
      actionResult: { success: true, reason: 'ALREADY_NEAR_TARGET' }, evaluation: noProgress, reflection }]
    const nextAfterMove = await client.decide({ goal, observation: afterMove, attempts, learnedSkills: [] })
    const partial = { status: 'PARTIAL_PROGRESS', reason: 'Target block changed; inventory unchanged' }
    const nextAfterDig = await client.decide({ goal, observation: afterDig,
      attempts: [...attempts, { observationBefore: afterMove,
        action: { action: 'DIG_BLOCK', target: block.ref }, observationAfter: afterDig,
        actionResult: { success: true, reason: 'DIG_COMPLETED' }, evaluation: partial }], learnedSkills: [] })
    console.log(JSON.stringify({ trial, item, reflection, nextAfterMove, nextAfterDig }))
    if (nextAfterMove.action === moved.action && nextAfterMove.target === moved.target &&
        nextAfterMove.distance === moved.distance) throw new Error('Qwen repeated the exact no-progress move')
    if (nextAfterDig.target === block.ref) throw new Error('Qwen targeted the disappeared block')
  }
  console.log(`[SMOKE] PASS ${count}/${count} grounded reflection/decision chains; no Minecraft actions`)
}

main().catch(error => { console.error(`[SMOKE] FAIL: ${error.message}`); process.exitCode = 1 })
