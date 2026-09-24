// Exercises the real learning controller and configured Ollama model against a tiny fake world.
// This is NOT Minecraft validation and contains no skill implementation or world-server connection.
const { EventEmitter } = require('node:events')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { localOllamaConfig } = require('./local-ollama-config')
const { GoalManager } = require('../src/goals')
const { MovementController } = require('../src/skills')
const { LearningController, LearningObservationBuilder, PrimitiveActionExecutor,
  LearningOllamaClient, LearningMemoryStore, createItemGoal } = require('../src/learning')
const { ITEM_NAME } = require('../src/learning/item-goal')

const item = process.argv.find(argument => argument.startsWith('--item='))?.slice('--item='.length) || 'birch_log'
const targetX = Number(process.argv.find(argument => argument.startsWith('--distance='))?.split('=')[1] || 3)
const episodeCount = Number(process.argv.find(argument => argument.startsWith('--episodes='))?.split('=')[1] || 1)
const noPath = process.argv.includes('--no-path')
if (!ITEM_NAME.test(item)) throw new Error('item must be a Minecraft-style symbolic name')
if (!Number.isInteger(targetX) || targetX < 2 || targetX > 8) throw new Error('distance must be 2..8')
if (!Number.isInteger(episodeCount) || episodeCount < 1 || episodeCount > 2) throw new Error('episodes must be 1 or 2')
if (noPath && episodeCount !== 1) throw new Error('--no-path supports one episode only')

class Vec3 {
  constructor(x, y, z) { this.x = x; this.y = y; this.z = z }
  offset(dx, dy, dz) { return new Vec3(this.x + dx, this.y + dy, this.z + dz) }
  clone() { return new Vec3(this.x, this.y, this.z) }
  distanceTo(other) { return Math.hypot(this.x - other.x, this.y - other.y, this.z - other.z) }
}

class FakeBot extends EventEmitter {
  constructor() {
    super()
    this.entity = { id: 1, position: new Vec3(0, 64, 0) }
    this.entities = {}
    this.players = {}
    this.health = 20
    this.food = 20
    this.itemCount = 0
    this.blockPresent = true
    this.inventory = { items: () => this.itemCount ? [{ name: item, count: this.itemCount }] : [], slots: [] }
    this.pathTimer = null
    this.pathfinder = {
      setMovements() {},
      setGoal: goal => {
        if (this.pathTimer) clearTimeout(this.pathTimer)
        this.pathTimer = null
        if (!goal) return
        this.pathTimer = setTimeout(() => {
          if (noPath) {
            this.emit('path_update', { status: 'noPath' })
            return
          }
          const target = new Vec3(goal.x, goal.y, goal.z)
          const distance = Math.sqrt(goal.rangeSq || 1)
          if (this.entity.position.distanceTo(target) > distance) {
            this.entity.position = new Vec3(Math.max(0, goal.x - 1), goal.y, goal.z)
          }
          this.collectNearbyDrop()
          this.emit('goal_reached')
        }, 30)
      }
    }
  }

  clearControlStates() {}
  lookAt() { return Promise.resolve() }
  setQuickBarSlot(slot) { this.quickBarSlot = slot }
  chat() {}
  collectNearbyDrop() {
    if (this.entities[7] && this.entity.position.distanceTo(this.entities[7].position) <= 1.5) {
      this.itemCount += 1
      delete this.entities[7]
    }
  }
  resetExperiment() {
    if (this.pathTimer) clearTimeout(this.pathTimer)
    this.pathTimer = null
    this.entity.position = new Vec3(0, 64, 0)
    this.entities = {}
    this.itemCount = 0
    this.blockPresent = true
  }
  findBlocks() {
    return [new Vec3(2, 63, 0), ...(this.blockPresent ? [new Vec3(targetX, 64, 0)] : [])]
  }
  blockAt(position) {
    if (position.x === targetX && position.y === 64 && position.z === 0 && this.blockPresent) {
      return { name: item, position: new Vec3(targetX, 64, 0) }
    }
    if (position.x === 2 && position.y === 63 && position.z === 0) {
      return { name: 'grass_block', position: new Vec3(2, 63, 0) }
    }
    return { name: 'air', position }
  }
  canDigBlock(block) { return block.name === item }
  async dig(block) {
    if (!this.blockPresent || block.name !== item) throw new Error('BLOCK_NOT_DIGGABLE')
    this.blockPresent = false
    this.entities[7] = { id: 7, name: 'item', type: 'other', position: new Vec3(targetX, 64, 0),
      getDroppedItem: () => ({ name: item, count: 1 }) }
    setTimeout(() => this.collectNearbyDrop(), 20)
  }
}

async function main() {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'minecraft-ai-sim-'))
  try {
    const bot = new FakeBot()
    const logger = { info: (...parts) => console.log(...parts), warn: (...parts) => console.warn(...parts), error: (...parts) => console.error(...parts) }
    const goalManager = new GoalManager()
    const movement = new MovementController(bot, { logger, goalManager })
    movement.initialize({})
    const observer = new LearningObservationBuilder({ bot, range: 8 })
    const executor = new PrimitiveActionExecutor({ bot, movement, observer, moveTimeoutMs: 3000 })
    const client = new LearningOllamaClient({ ollama: {
      ...localOllamaConfig(), debug: process.argv.includes('--debug')
    }, logger })
    const memory = new LearningMemoryStore({ filePath: path.join(temporaryDirectory, 'memory.json') })
    await memory.load()
    const controller = new LearningController({
      movement, goalManager, observer, executor, client,
      memory,
      autonomy: { setSuppressed() {} }, logger,
      config: { enabled: false, maxActions: 10, maxDurationMs: 60000,
        repeatedActionLimit: 3, exploreRadius: 16, observationSettleMs: 100 }
    })
    const goal = createItemGoal(item)
    for (let index = 1; index <= episodeCount; index += 1) {
      if (index > 1) {
        bot.resetExperiment()
        if (!memory.findRelevantSkills(goal).length) throw new Error('No learned skill was retrieved for retry')
      }
      const result = await controller.runExperiment(goal)
      console.log(`[SIM] episode ${index}/${episodeCount}: ${result.outcome}; itemCount=${bot.itemCount}; actions=${result.attempts.map(attempt => attempt.action.action).join(' -> ')}`)
      if (noPath) {
        if (result.outcome !== 'FAILURE' || bot.itemCount !== 0) {
          throw new Error('Blocked fake world did not fail conservatively')
        }
      } else if (result.outcome !== 'SUCCESS' || bot.itemCount < 1) {
        throw new Error('Simulated objective was not confirmed')
      }
    }
    const stored = JSON.parse(await fs.readFile(path.join(temporaryDirectory, 'memory.json'), 'utf8'))
    if (stored.episodes.length !== episodeCount ||
        (noPath ? stored.skills.length !== 0 : !stored.skills.length ||
          !stored.skills.every(skill => skill.steps.length > 0))) {
      throw new Error('Learning memory did not persist the successful episodes and skills')
    }
    if (episodeCount === 2 && !stored.skills.some(skill => skill.successes >= 2 && skill.confidence > 2 / 3)) {
      throw new Error('Repeated success did not update learned-skill confidence')
    }
    console.log(`[SIM] PASS: ${episodeCount} fake-world episode(s), ${stored.skills.length} persisted skill candidate(s); Minecraft remains untested`)
  } finally {
    if (path.dirname(temporaryDirectory) === os.tmpdir() &&
        path.basename(temporaryDirectory).startsWith('minecraft-ai-sim-')) {
      await fs.rm(temporaryDirectory, { recursive: true, force: true })
    }
  }
}

main().catch(error => { console.error(`[SIM] FAIL: ${error.message}`); process.exitCode = 1 })
