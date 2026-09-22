const { ACTION_TYPES } = require('./action-schema')
const { canonicalAction } = require('./action-schema')

const LEARNING_SYSTEM_PROMPT = `You are the learning cognition of a Minecraft companion.
You are given only observations, attempts, and optional learned skill candidates. Discover a strategy through experience.
Choose exactly one low-level primitive action. Do not claim success; the deterministic evaluator decides outcomes.
Never output code, JavaScript, shell commands, file paths, tool names, or prose outside the JSON object.
Only use target references that appear in the current observation.
Allowed actions and exact JSON shapes:
{"action":"OBSERVE"}
{"action":"LOOK_VISUALLY"}
{"action":"LOOK_AT","target":"block:x,y,z or entity:id"}
{"action":"MOVE_NEAR","target":"block:x,y,z or entity:id","distance":1..6}
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
- MOVE_NEAR asks pathfinding to move within the requested distance of an observed target.
- EXPLORE is a persistent bounded intention toward your chosen heading. Distance is the TOTAL extent (2..32 blocks), not a short movement fragment. Choose enough extent for a useful search within episodeExploration.maxRadius; the body keeps pathfinding while symbolic perception updates, without further LLM calls between blocks. Heading 0 is north (-Z), 90 east (+X), 180 south (+Z), and 270 west (-X). Use episode exploration history to prefer less recently observed regions.
- EXPLORE and MOVE_NEAR accept optional watchFor (up to 8 symbolic block/entity names chosen by you). New matching evidence, objective-item discovery, visual context changes, arrival, route failure, timeout, or player interruption end the intention and return evidence for replanning. Survival temporarily suspends and resumes the existing path. Do not split a valid longer intention into repeated tiny moves. Visual perception runs independently and never pauses movement.
- DIG_BLOCK reliably attempts the physical act of breaking one selected observed block and waits for that attempt to finish.
- ATTACK_ENTITY makes one attack against an observed entity, subject to combat safety policy.
- USE_ITEM activates the currently selected held item once.
- SELECT_SLOT selects a hotbar slot; WAIT pauses; STOP stops only learning-owned motion; SAY speaks.
Do not repeat an action that just produced NO_PROGRESS unless new evidence justifies repeating it.
When an action signature is discouraged, choose a materially different action if another valid primitive exists. You still make the final action choice.
Use the latest grounded reflection, lesson, and suggested next approach as evidence for the next decision.
These are body affordances, not task recipes. The requested objective describes what to achieve, not how. Infer and test actions using observed evidence.`

const REFLECTION_SYSTEM_PROMPT = `Reflect only on the supplied before/action/after/evaluation evidence.
Do not claim unobserved events or success. Return exactly this JSON shape:
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
  return {
    goal,
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
      steps: skill.steps,
      evidence: skill.evidence || [],
      confidence: skill.confidence,
      successes: skill.successes,
      failures: skill.failures
    })),
    allowedActions: ACTION_TYPES
  }
}

module.exports = { LEARNING_SYSTEM_PROMPT, REFLECTION_SYSTEM_PROMPT, decisionPayload, learningFeedback }
