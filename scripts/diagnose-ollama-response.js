const path = require('node:path')
const dotenv = require('dotenv')
const { LEARNING_SYSTEM_PROMPT, decisionPayload } = require('../src/learning/prompt')
const { OAK_LOG_EXPERIMENT } = require('../src/learning')

dotenv.config({ path: path.resolve(process.cwd(), '.env'), quiet: true })

async function main() {
  const url = process.env.OLLAMA_URL || 'http://localhost:11434/api/chat'
  const model = process.env.OLLAMA_MODEL || 'qwen3-vl:8b'
  const state = decisionPayload({
    goal: OAK_LOG_EXPERIMENT,
    observation: {
      position: { x: 0, y: 64, z: 0 },
      health: 20,
      food: 20,
      heldItem: null,
      hotbar: Array.from({ length: 9 }, (_, slot) => ({ slot, name: null, count: 0 })),
      inventory: {},
      inventoryDelta: {},
      nearbyBlocks: [
        { ref: 'block:3,64,0', name: 'oak_log', position: { x: 3, y: 64, z: 0 }, distance: 3, diggable: true }
      ],
      nearbyEntities: [],
      targetState: null,
      currentGoal: OAK_LOG_EXPERIMENT,
      recentProgress: [],
      previousActionResult: null
    },
    attempts: [],
    learnedSkills: []
  })
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      format: 'json',
      messages: [
        { role: 'system', content: LEARNING_SYSTEM_PROMPT },
        { role: 'user', content: JSON.stringify(state) }
      ]
    })
  })
  const text = await response.text()
  console.log(JSON.stringify({ httpStatus: response.status, responseBodyBytes: Buffer.byteLength(text) }))
  if (!text) return
  const data = JSON.parse(text)
  console.log(JSON.stringify({
    done: data.done,
    doneReason: data.done_reason || null,
    messageKeys: Object.keys(data.message || {}),
    content: data.message?.content ?? null,
    thinkingLength: typeof data.message?.thinking === 'string' ? data.message.thinking.length : 0,
    thinkingPreview: typeof data.message?.thinking === 'string' ? data.message.thinking.slice(0, 500) : null,
    promptEvalCount: data.prompt_eval_count ?? null,
    evalCount: data.eval_count ?? null
  }))
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
