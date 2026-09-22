const { test } = require('node:test')
const assert = require('node:assert/strict')
const { parsePort, tagsUrl, canStartLocalServer, ensureOllama } = require('../scripts/launch-companion')

const options = { chatUrl: 'http://localhost:11434/api/chat', model: 'qwen3-vl:8b', log() {}, sleep: async () => {} }
const models = [{ name: options.model }]

test('launcher accepts only valid integer LAN ports', () => {
  assert.equal(parsePort(' 51234 '), 51234)
  for (const input of ['', '0', '-1', '65536', '1.2', '1e3', '123 & echo unsafe']) assert.throws(() => parsePort(input))
})

test('launcher respects configured Ollama endpoint and only auto-starts default loopback service', () => {
  assert.equal(tagsUrl('http://localhost:11434/api/chat').href, 'http://localhost:11434/api/tags')
  assert.equal(tagsUrl('https://example.org/ollama/api/chat').pathname, '/ollama/api/tags')
  for (const url of ['http://example.org:11434/api/chat', 'http://localhost:11435/api/chat']) {
    assert.equal(canStartLocalServer(tagsUrl(url)), false)
  }
  assert.throws(() => tagsUrl('file:///api/chat'))
  assert.throws(() => tagsUrl('http://user:secret@localhost:11434/api/chat'))
})

test('running Ollama is reused without starting a second service', async () => {
  await ensureOllama({ ...options, probe: async () => models, start: () => assert.fail('must not start') })
})

test('launcher starts unavailable local Ollama and waits for readiness', async () => {
  let calls = 0
  let starts = 0
  await ensureOllama({ ...options, probe: async () => { if (++calls < 3) throw new Error('offline'); return models }, start: async () => { starts++ } })
  assert.equal(starts, 1)
  assert.equal(calls, 3)
})

test('launcher startup retries are bounded and never replace a remote endpoint', async () => {
  let calls = 0
  const probe = async () => { calls++; throw new Error('offline') }
  await assert.rejects(ensureOllama({ ...options, probe, attempts: 2, start: async () => {} }), /超时/)
  assert.equal(calls, 3)
  await assert.rejects(ensureOllama({ ...options, chatUrl: 'http://example.org:11434/api/chat', probe, start: () => assert.fail('must not start') }), /手动启动/)
})

test('missing model fails clearly without automatically downloading anything', async () => {
  await assert.rejects(ensureOllama({ ...options, probe: async () => [], start: () => assert.fail('must not start') }), /不会自动下载/)
})
