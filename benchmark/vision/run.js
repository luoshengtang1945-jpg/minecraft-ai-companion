const fs = require('node:fs/promises')
const path = require('node:path')
const dotenv = require('dotenv')
const { VisionOllamaClient } = require('../../src/vision')

dotenv.config({ path: path.resolve(process.cwd(), '.env'), quiet: true })

function argumentsFrom(argv) {
  const countArg = argv.find(value => value.startsWith('--count='))
  const cases = argv.filter(value => value.startsWith('--case=')).map(value => {
    const pair = value.slice(7)
    const split = pair.indexOf('=')
    if (split < 1) throw new Error('--case must be label=absolute-or-relative-png-path')
    return { label: pair.slice(0, split), file: path.resolve(pair.slice(split + 1)) }
  })
  return { count: Number(countArg?.slice(8) || 1), cases }
}

async function main() {
  const options = argumentsFrom(process.argv.slice(2))
  if (!Number.isInteger(options.count) || options.count < 1 || options.count > 20 || !options.cases.length) {
    throw new Error('Usage: node benchmark/vision/run.js --count=3 --case=open_grassland=C:\\path\\frame.png')
  }
  const ollama = {
    url: process.env.OLLAMA_URL || 'http://127.0.0.1:11434/api/chat',
    model: process.env.OLLAMA_MODEL || 'qwen3-vl:8b',
    timeoutMs: Number(process.env.OLLAMA_TIMEOUT_MS || 120000),
    responseRetries: Number(process.env.OLLAMA_RESPONSE_RETRIES || 2),
    retryBackoffMs: Number(process.env.OLLAMA_RETRY_BACKOFF_MS || 250),
    think: false,
    debug: false
  }
  if (ollama.model !== 'qwen3-vl:8b') throw new Error(`Vision benchmark requires qwen3-vl:8b, got ${ollama.model}`)
  const logger = { info() {}, warn: console.warn, error: console.error }
  const client = new VisionOllamaClient({ ollama, scheduler: null, logger })
  const results = []
  for (const fixture of options.cases) {
    const startedRead = performance.now()
    const buffer = await fs.readFile(fixture.file)
    const preprocessingMs = performance.now() - startedRead
    for (let trial = 1; trial <= options.count; trial++) {
      const started = performance.now()
      try {
        const observation = await client.observe({
          id: `${fixture.label}-${trial}`,
          capturedAt: Date.now(),
          perspective: 'HUMAN_CLIENT_CAMERA',
          width: null,
          height: null,
          camera: null,
          dimension: 'unknown',
          buffer
        }, { kind: 'TASK_VISUAL_PERCEPTION', trigger: 'BENCHMARK' })
        results.push({ label: fixture.label, trial, valid: true, preprocessingMs, inferenceMs: performance.now() - started, observation })
      } catch (error) {
        results.push({ label: fixture.label, trial, valid: false, preprocessingMs, inferenceMs: performance.now() - started, error: error.message, status: error.status || null })
      }
    }
  }
  const directory = path.resolve('benchmark/vision/results')
  await fs.mkdir(directory, { recursive: true })
  const output = path.join(directory, `vision-${Date.now()}.json`)
  const valid = results.filter(result => result.valid)
  const summary = {
    model: ollama.model,
    think: false,
    createdAt: new Date().toISOString(),
    trials: results.length,
    structuredValid: valid.length,
    averageInferenceMs: valid.length ? valid.reduce((sum, result) => sum + result.inferenceMs, 0) / valid.length : null,
    results
  }
  await fs.writeFile(output, JSON.stringify(summary, null, 2))
  console.log(JSON.stringify({ output, trials: summary.trials, structuredValid: summary.structuredValid, averageInferenceMs: summary.averageInferenceMs }, null, 2))
}

main().catch(error => {
  console.error(error.message)
  process.exitCode = 1
})
