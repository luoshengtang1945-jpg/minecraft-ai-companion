// Small real-model probe for conversation quality. No Minecraft connection or actions.
const config = require('../src/config')
const { OllamaClient } = require('../src/agent/ollama-client')
const { chatReplyIssue } = require('../src/agent/reply-grounding')

const englishScenarios = [
  'I feel bored',
  'What do you want to do?',
  'Can you build a house?',
  'Do you remember the house we built?',
  '你喜欢下雨天吗？'
]
const chineseScenarios = [
  '我有点无聊',
  '你想干嘛？',
  '你会建房子吗？',
  '你还记得我们盖的房子吗？',
  '你喜欢下雨天吗？'
]

async function main() {
  const trials = Number(process.argv[2] || 5)
  const summaryOnly = process.argv.includes('--summary')
  const scenarios = process.argv.includes('--zh') ? chineseScenarios : englishScenarios
  if (!Number.isInteger(trials) || trials < 1 || trials > 20) throw new Error('Expected 1–20 trials')
  const totals = { decisions: 0, revisions: 0, fallbacks: 0, invalidFinal: 0 }
  const byScenario = {}
  for (const input of scenarios) {
    const scenario = { revisions: 0, fallbacks: 0, invalidFinal: 0, replies: new Set(), failures: [], invalidSamples: [] }
    byScenario[input] = scenario
    for (let trial = 1; trial <= trials; trial++) {
      const logs = []
      const client = new OllamaClient({ ...config.ollama, debug: false }, null, { info: line => logs.push(line) })
      const decision = await client.decide('TestPlayer', input)
      const revised = logs.some(line => line.includes('requesting grounded text-only revision'))
      const fallback = revised && !logs.some(line => line.includes('capability revision valid structured response'))
      const issue = decision.action === 'CHAT' ? chatReplyIssue(decision.reply, { playerMessage: input }) : 'WRONG_ACTION'
      totals.decisions++
      totals.revisions += Number(revised)
      totals.fallbacks += Number(fallback)
      totals.invalidFinal += Number(Boolean(issue))
      scenario.revisions += Number(revised)
      scenario.fallbacks += Number(fallback)
      scenario.invalidFinal += Number(Boolean(issue))
      if (issue && scenario.invalidSamples.length < 3) scenario.invalidSamples.push({ reply: decision.reply, issue })
      scenario.replies.add(decision.reply)
      const revisionFailure = logs.find(line => line.includes('Grounding revision unavailable')) || null
      if (revisionFailure && scenario.failures.length < 3) scenario.failures.push(revisionFailure)
      if (!summaryOnly) console.log(JSON.stringify({ input, trial, action: decision.action, reply: decision.reply, revised, fallback, issue, revisionFailure }))
    }
  }
  console.log(JSON.stringify({ model: config.ollama.model, trialsPerScenario: trials, totals,
    byScenario: Object.fromEntries(Object.entries(byScenario).map(([input, result]) => [input, { ...result, distinctReplies: result.replies.size, replies: [...result.replies].slice(0, 5) }])) }))
}

main().catch(error => { console.error(error); process.exitCode = 1 })
