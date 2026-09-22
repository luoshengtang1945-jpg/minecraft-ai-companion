const path = require('node:path')
const fs = require('node:fs')
const net = require('node:net')
const { spawn } = require('node:child_process')
const readline = require('node:readline/promises')
const { setTimeout: delay } = require('node:timers/promises')

function parsePort(input) {
  const value = String(input).trim()
  if (!/^\d{1,5}$/.test(value) || Number(value) < 1 || Number(value) > 65535) {
    throw new Error('请输入 1–65535 之间的整数端口。')
  }
  return Number(value)
}

function tagsUrl(chatUrl) {
  const url = new URL(chatUrl)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('OLLAMA_URL 必须是无凭据、无查询参数的 HTTP(S) 地址。')
  }
  if (!/\/api\/chat\/?$/.test(url.pathname)) throw new Error('OLLAMA_URL 必须以 /api/chat 结尾。')
  url.pathname = url.pathname.replace(/chat\/?$/, 'tags')
  return url
}

function canStartLocalServer(url) {
  return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) &&
    url.port === '11434' && url.pathname === '/api/tags'
}

async function getModels(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(2000), redirect: 'error' })
  if (!response.ok) throw new Error(`Ollama HTTP ${response.status}`)
  const body = await response.json()
  if (!Array.isArray(body.models)) throw new Error('Ollama 模型列表格式不正确。')
  return body.models
}

function startLocalOllama() {
  const installed = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama', 'ollama.exe')
  const executable = fs.existsSync(installed) ? installed : 'ollama'
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['serve'], {
      detached: true, windowsHide: true, stdio: 'ignore',
      env: { ...process.env, OLLAMA_HOST: '127.0.0.1:11434' }
    })
    child.once('error', () => reject(new Error('无法启动 Ollama。请先从开始菜单打开 Ollama，然后重试。')))
    child.once('spawn', () => { child.unref(); resolve() })
  })
}

async function ensureOllama({ chatUrl, model, probe = getModels, start = startLocalOllama,
  sleep = delay, log = console.log, attempts = 15 }) {
  const url = tagsUrl(chatUrl)
  let models
  try { models = await probe(url) } catch {
    if (!canStartLocalServer(url)) {
      throw new Error('配置的 Ollama 服务无法访问。请手动启动对应服务；不会修改你的地址或启动其他服务。')
    }
    log('[启动] 正在后台启动 Ollama，请稍候……')
    await start()
    for (let attempt = 0; attempt < attempts; attempt++) {
      await sleep(1000)
      try { models = await probe(url); break } catch { /* Bounded startup polling. */ }
    }
    if (!models) throw new Error('等待 Ollama 启动超时。请打开 Ollama 检查后重试。')
  }
  const normalize = name => name.includes(':') ? name : `${name}:latest`
  if (!models.some(entry => typeof entry.name === 'string' && normalize(entry.name) === normalize(model))) {
    throw new Error(`Ollama 中没有已配置的模型 ${model}。请先安装该模型；启动器不会自动下载。`)
  }
  log(`[启动] Ollama 已就绪，模型：${model}`)
}

function checkMinecraft(host, port) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port })
    const finish = error => {
      socket.destroy()
      if (error) reject(new Error('无法连接 Minecraft。请确认世界已开放局域网，并输入聊天栏显示的本次端口。'))
      else resolve()
    }
    socket.setTimeout(3000, () => finish(new Error('timeout')))
    socket.once('error', finish)
    socket.once('connect', () => finish())
  })
}

async function main() {
  if (Number(process.versions.node.split('.')[0]) < 18) throw new Error('需要 Node.js 18 或更新版本。')
  process.chdir(path.resolve(__dirname, '..'))
  let dotenv
  try { dotenv = require('dotenv'); require.resolve('mineflayer'); require.resolve('mineflayer-pathfinder') } catch {
    throw new Error('项目依赖未安装。请先在项目目录运行一次 npm install。')
  }
  dotenv.config({ quiet: true })
  console.log('\nMinecraft AI 陪玩启动器\n先进入世界 → 对局域网开放 → 查看聊天栏的端口。\n')
  const input = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    while (true) {
      const answer = await input.question('请输入本次局域网端口（输入 q 退出）：')
      if (answer.trim().toLowerCase() === 'q') return
      try { process.env.MC_PORT = String(parsePort(answer)); break } catch (error) { console.log(error.message) }
    }
  } finally { input.close() }
  // Validate the existing configuration before starting services. No .env writes.
  const config = require('../src/config')
  await checkMinecraft(config.minecraft.host, config.minecraft.port)
  await ensureOllama({ chatUrl: config.ollama.url, model: config.ollama.model })
  console.log('[启动] 正在加入世界。请保留或最小化此窗口；结束陪玩时关闭窗口或按 Ctrl+C。')
  console.log('[启动] 退出 Minecraft 世界后机器人会断开；Ollama 后台服务会保留。\n')
  require('../bot')
}

if (require.main === module) {
  main().catch(error => { console.error(`[启动失败] ${error.message}`); process.exitCode = 1 })
}

module.exports = { parsePort, tagsUrl, canStartLocalServer, ensureOllama, checkMinecraft }
