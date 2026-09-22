// Real local-model check with SYNTHETIC state; does not connect to Minecraft.
const assert = require('node:assert/strict')
const config = require('../src/config')
const { OllamaClient } = require('../src/agent/ollama-client')
const { AutonomyOllamaClient } = require('../src/autonomy/ollama-client')
const { personality } = require('../src/personality')
const { isRepeatedReply, hasReversedFollowReply } = require('../src/agent/reply-variety')

async function main() {
  const client = new OllamaClient({ ...config.ollama, debug: false }, null, { info: console.log })
  const behavior = { type: 'FOLLOW', username: 'TestPlayer', source: 'PLAYER', locomotionOwner: 'PLAYER' }
  const companionSession = { behavior, playerCommitment: 'FOLLOW', interruptedBySurvival: false,
    player: { username: 'TestPlayer', distance: 3, activity: 'MOVING' },
    speech: { eligible: true, quietSeconds: 120, reason: 'READY' }, recentDialogue: [] }
  const replies = []
  const failures = []
  console.log(`Synthetic dialogue smoke test; model=${config.ollama.model}; no Minecraft actions`)
  for (let index = 0; index < 3; index++) {
    const decision = await client.decide('TestPlayer', '跟着我', JSON.stringify({ companionSession }))
    console.log(JSON.stringify({ trial: index + 1, input: '跟着我', ...decision }))
    assert.ok(['CHAT', 'FOLLOW'].includes(decision.action), 'unexpected action')
    if (!decision.reply) failures.push(`trial ${index + 1}: no usable reply after revision`)
    assert.equal(hasReversedFollowReply('FOLLOW', decision.reply), false, 'follow direction reversed')
    if (isRepeatedReply(decision.reply, replies)) failures.push(`trial ${index + 1}: repeated reply`)
    replies.push(decision.reply)
  }
  const preference = await client.decide('TestPlayer', '你喜欢下雨天吗？', JSON.stringify({ companionSession }))
  console.log(JSON.stringify({ input: '你喜欢下雨天吗？', ...preference }))
  assert.equal(preference.action, 'CHAT')
  assert.doesNotMatch(preference.reply, /^在跟着你|^在这等你/, 'status reply instead of responding to topic')
  const autonomy = new AutonomyOllamaClient({ ollama: config.ollama, personality })
  for (let trial = 1; trial <= 2; trial++) {
    const decision = await autonomy.decide({
      autonomyTrigger: 'weather', behavior, companionSession,
      companion: { health: 20, food: 20 }, player: companionSession.player,
      combatMode: 'DEFENSIVE', world: { raining: true, timeOfDay: 12500, isDay: false },
      nearbyEntities: { hostile: [], passive: [] }, usefulBlocks: [], inventory: [],
      recentEvents: [{ type: 'weather', detail: 'rain_started' }],
      currentGoal: { type: 'FOLLOW', source: 'PLAYER' }
    })
    console.log(JSON.stringify({ trial, syntheticEvent: 'new rain at dusk after 120s silence', ...decision }))
    assert.equal(decision.action, 'SAY', 'salient new weather did not elicit proactive speech in this trial')
    assert.ok(decision.message.trim())
  }
  assert.deepEqual(failures, [], 'dialogue quality checks failed')
  const quietDecision = await autonomy.decide({
    autonomyTrigger: 'interval', behavior: { ...behavior, source: 'AUTONOMOUS', locomotionOwner: 'AUTONOMY' },
    companionSession, player: companionSession.player,
    world: { raining: false, timeOfDay: 6000, isDay: true }, combatMode: 'DEFENSIVE',
    nearbyEntities: { hostile: [], passive: [] }, recentEvents: [],
    socialOpportunity: { kind: 'QUIET_COMPANY', quietSeconds: 120 }
  })
  console.log(JSON.stringify({ syntheticEvent: 'quiet automatic companionship for 120s', ...quietDecision }))
  assert.ok(['SAY', 'IDLE'].includes(quietDecision.action), 'automatic following must remain speech-only')
  console.log('PASS: follow direction, reply variety, topic response and proactive speech (synthetic state only)')
}

main().catch(error => { console.error(error.message); process.exitCode = 1 })
