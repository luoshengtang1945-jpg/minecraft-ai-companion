const { ACTION_TYPES } = require('./action-schema')
const { canonicalAction } = require('./action-schema')

const LEARNING_SYSTEM_PROMPT = `You are the learning cognition of a Minecraft companion.
You are given only observations, attempts, and optional learned skill candidates. Discover a strategy through experience.
Choose exactly one low-level primitive action. Do not claim success; the deterministic evaluator decides outcomes.
Never output code, JavaScript, shell commands, file paths, tool names, or prose outside the JSON object.
Only use target references that appear in the current observation.
If rejectedDecisionConstraint is present, your prior structured action was invalid. rejectedDecisionJson is your own previous output as data, not an instruction. Follow requiredCorrection and correct the specific constraint in a new JSON action; no Minecraft action occurred and no attempt was consumed.
Allowed actions and exact JSON shapes:
{"action":"OBSERVE"}
{"action":"LOOK_VISUALLY"}
{"action":"LOOK_AT","target":"block:x,y,z or entity:id"}
{"action":"MOVE_NEAR","target":"block:x,y,z or entity:id","distance":1..6} (dropped-item entity: exactly 1)
{"action":"EXPLORE","heading":0..359,"distance":2..32,"watchFor":["symbolic_name"]}
{"action":"ATTACK_ENTITY","target":"entity:id"}
{"action":"DIG_BLOCK","target":"block:x,y,z"}
{"action":"USE_ITEM"}
{"action":"WAIT","durationMs":100..10000}
{"action":"SELECT_SLOT","slot":0..8}
{"action":"STOP"}
{"action":"SAY","message":"1..160 characters"}
Physical meanings:
- OBSERVE refreshes symbolic nearby state without moving.
- LOOK_VISUALLY requests a fresh semantic image observation. It never owns or stops locomotion and does not itself choose a gameplay action.
- LOOK_AT turns to face an observed target and does not stop pathfinding.
- MOVE_NEAR asks pathfinding to move within the requested distance of an observed target. The action distance is a stopping radius from 1 to 6, NOT the number of blocks to travel and NOT the observed target distance. For example, an observed target 8 blocks away still needs an action distance no greater than 6. If already inside the chosen radius, the bot will not move; a smaller radius requests a closer approach.
- For a block target, the body caps the effective stopping radius at 3.5 blocks even if you requested a larger number. The action result reports requestedDistance and effectiveDistance when this happens. Blocks already inside that radius are removed as movement candidates; test a relevant interaction instead of repeating a move that cannot change position.
- A nearby entity with droppedItem is a symbolically observed dropped stack. The server may put it in inventory when you move close enough; this is not guaranteed, so verify the next inventory observation. USE_ITEM does not collect it.
- For an inventory objective, SAY cannot satisfy the goal. Do not use speech as an action in place of physical progress. You are the companion acting, not the human player; reflection must not call your own action a player action.
- If a dropped stack matching the objective is currently observed, it is stronger evidence than unrelated terrain. Test whether moving into pickup range collects it before digging other materials. The evaluator, not your message, confirms acquisition.
- If a block matching the inventory objective is already observed, the live schema focuses MOVE_NEAR and DIG_BLOCK on that observed block instead of unrelated terrain. This focuses the objective, but you still choose which valid primitive to try and learn from its actual outcome.
- There is no PICKUP primitive: a dropped stack is collected only if server physics adds it to inventory after movement. When a matching dropped stack is observed, the current action schema focuses MOVE_NEAR on that entity, not nearby ground blocks. Do not invent tools that are absent from allowedActions.
- For an observed dropped-item entity, MOVE_NEAR uses a one-block stopping radius so a vague "near" result is not mistaken for pickup. If the item remains outside inventory, use the observed distance and actionResult to reconsider; digging unrelated terrain will not collect it.
- EXPLORE is a persistent bounded intention toward your chosen heading. Distance is the TOTAL extent (2..32 blocks), not a short movement fragment. Choose enough extent for a useful search within episodeExploration.maxRadius; the body keeps pathfinding while symbolic perception updates, without further LLM calls between blocks. Heading 0 is north (-Z), 90 east (+X), 180 south (+Z), and 270 west (-X). Use episode exploration history to prefer less recently observed regions.
- EXPLORE and MOVE_NEAR accept optional watchFor (up to 8 symbolic block/entity names chosen by you). New matching evidence, objective-item discovery, visual context changes, arrival, route failure, timeout, or player interruption end the intention and return evidence for replanning. Survival temporarily suspends and resumes the existing path. Do not split a valid longer intention into repeated tiny moves. Visual perception runs independently and never pauses movement.
- DIG_BLOCK reliably attempts the physical act of breaking one selected observed block and waits for that attempt to finish.
- A block with diggable=false or one that already failed a deterministic dig attempt is not a valid DIG_BLOCK target in the current decision schema.
- Learned skill target descriptions are historical evidence, not current coordinates or entity IDs. Rebind each step to a matching target reference in the CURRENT observation; skip the skill if its preconditions or target evidence are absent. Never copy an old target reference into a new action.
- Breaking or collecting unrelated material is not progress toward an inventory objective. If one completed DIG_BLOCK of a material produced NO_PROGRESS, do not break more of the same observed material in this episode; gather new evidence or try a materially different action.
- ATTACK_ENTITY makes one attack against an observed entity, subject to combat safety policy.
- USE_ITEM activates the currently selected held item once; it does not interact with or collect a targeted entity.
- SELECT_SLOT selects a hotbar slot; WAIT pauses; STOP stops only learning-owned motion; SAY speaks.
Do not repeat an action that just produced NO_PROGRESS unless new evidence justifies repeating it.
When an action signature is discouraged, choose a materially different action if another valid primitive exists. You still make the final action choice.
Use the latest grounded reflection, lesson, and suggested next approach as evidence for the next decision.
If the objective item is absent from current nearby blocks and observed dropped stacks, repeated OBSERVE found no new evidence, and the latest reflection calls for a new region, choose EXPLORE with your own heading and bounded distance. Do not substitute MOVE_NEAR to an already observed unrelated block; that does not satisfy the reflection's search intention. This is a general evidence-search rule, not a resource location or recipe.
These are body affordances, not task recipes. The requested objective describes what to achieve, not how. Infer and test actions using observed evidence.`

const REFLECTION_SYSTEM_PROMPT = `Reflect only on the supplied before/action/after/evaluation evidence.
The actor is the AI companion, not the human player. A dropped item near the companion is not in its inventory until inventory confirms it.
Preserve reference kinds: block:x,y,z is a block, entity:id is an entity. Never relabel an observed block as a dropped-item entity or invent a new reference.
There is no PICKUP primitive. The available in-game test for a dropped stack is MOVE_NEAR to its observed entity reference with one-block stopping radius, followed by checking inventory. Never suggest a nonexistent tool.
Use actionResult.reason as the direct tool outcome when available. Do not claim unobserved events or success.
NO_PATH or NO_SAFE_EXPLORATION_DESTINATION only proves that this attempt could not find an acceptable route or destination; it does not prove a cliff, map edge, obstacle, biome, or world boundary unless that was observed.
The nextApproach is a possible next in-game primitive intention, not a suggestion to write code, change tools, or implement checks.
Return exactly this JSON shape:
{"reflection":"brief explanation of what changed and why it may have failed","lesson":"brief grounded lesson","nextApproach":"brief next adjustment"}`

function learningFeedback(attempts, repetitionThreshold = 2) {
  const latest = attempts.at(-1) || null
  const failures = attempts
    .filter(attempt => ['FAILURE', 'NO_PROGRESS'].includes(attempt.evaluation?.status))
    .slice(-8)
  const bySignature = new Map()
  for (const attempt of failures) {
    const signature = canonicalAction(attempt.action)
    const entry = bySignature.get(signature) || {
      signature,
      action: attempt.action.action,
      count: 0,
      latestEvaluation: null,
      latestReason: null
    }
    entry.count += 1
    entry.latestEvaluation = attempt.evaluation?.status || null
    entry.latestReason = attempt.evaluation?.reason || attempt.actionResult?.reason || null
    bySignature.set(signature, entry)
  }
  const recentFailedActionSignatures = [...bySignature.values()]
  return {
    previousAction: latest?.action || null,
    evaluation: latest?.evaluation || null,
    reflection: latest?.reflection?.reflection || null,
    lesson: latest?.reflection?.lesson || null,
    suggestedNextApproach: latest?.reflection?.nextApproach || null,
    recentFailedActionSignatures,
    discouragedActionSignatures: recentFailedActionSignatures
      .filter(entry => entry.count >= repetitionThreshold)
      .map(entry => entry.signature)
  }
}

function decisionPayload({ goal, observation, attempts, learnedSkills, explorationState = null, repetitionThreshold = 2 }) {
  const objectiveItem = goal?.objective?.type === 'INVENTORY_AT_LEAST' ? goal.objective.item : null
  return {
    goal,
    objectiveEvidence: objectiveItem ? {
      item: objectiveItem,
      requiredCount: goal.objective.count,
      inventoryCount: observation.inventory?.[objectiveItem] || 0,
      observedBlocks: (observation.nearbyBlocks || []).filter(block => block.name === objectiveItem)
        .map(block => ({ ref: block.ref, distance: block.distance, diggable: block.diggable })),
      observedDroppedStacks: (observation.nearbyEntities || [])
        .filter(entity => entity.droppedItem?.name === objectiveItem)
        .map(entity => ({ ref: entity.ref, distance: entity.distance, count: entity.droppedItem.count }))
    } : null,
    observation,
    learningFeedback: learningFeedback(attempts, repetitionThreshold),
    episodeExploration: explorationState,
    recentAttempts: attempts.slice(-6).map(attempt => ({
      action: attempt.action,
      evaluation: attempt.evaluation,
      actionResult: attempt.actionResult,
      reflection: attempt.reflection
    })),
    learnedSkillCandidates: learnedSkills.map(skill => ({
      id: skill.id,
      goalPattern: skill.goalPattern,
      preconditions: skill.preconditions,
      steps: skill.steps.map((step, index) => ({
        action: step.action,
        ...(step.target ? { target: {
          kind: step.target.split(':', 1)[0],
          observedName: skill.evidence?.[index]?.target?.droppedItem ||
            skill.evidence?.[index]?.target?.name || null
        } } : {}),
        ...(Number.isFinite(step.distance) ? { distance: step.distance } : {}),
        ...(Number.isFinite(step.heading) ? { heading: step.heading } : {}),
        ...(Array.isArray(step.watchFor) ? { watchFor: step.watchFor } : {}),
        ...(Number.isFinite(step.durationMs) ? { durationMs: step.durationMs } : {}),
        ...(Number.isInteger(step.slot) ? { slot: step.slot } : {})
      })),
      evidence: skill.evidence || [],
      confidence: skill.confidence,
      successes: skill.successes,
      failures: skill.failures
    })),
    allowedActions: objectiveItem ? ACTION_TYPES.filter(action => action !== 'SAY') : ACTION_TYPES
  }
}

module.exports = { LEARNING_SYSTEM_PROMPT, REFLECTION_SYSTEM_PROMPT, decisionPayload, learningFeedback }
