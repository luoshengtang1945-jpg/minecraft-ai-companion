const { sendWakeRequest } = require('./wake-request')

function recognizeRestRequest(message) {
  const text = String(message).trim().replace(/[。！!]+$/g, '')
  if (/^(?:你|请|我们|咱们)?(?:去)?(?:睡觉|睡吧|睡一觉|睡一下|上床睡觉|躺床上|躺到床上|去床上)(?:吧|一下)?$/.test(text)) return 'SLEEP'
  if (/^(?:你|请)?(?:起床|起来|醒醒|别睡了|不要睡了)(?:吧|一下)?$/.test(text)) return 'WAKE'
  return null
}

function sleepAvailability(bot) {
  const dimension = bot.game?.dimension
  if (!['overworld', 'minecraft:overworld'].includes(dimension)) return '这里只能确认主世界的床安全，我不会在这个维度尝试睡觉。'
  const time = bot.time?.timeOfDay
  if (!(time >= 12541 && time <= 23458) && !(bot.isRaining && bot.thunderState > 0)) return '现在还不能睡，普通下雨不算雷暴，要等晚上。'
  return null
}

class RestController {
  constructor({ bot, movement, survival, logger, session, setIntervalFn = setInterval, clearIntervalFn = clearInterval, wakeTimeoutMs = 3000, now = Date.now }) {
    Object.assign(this, { bot, movement, survival, logger, session, setIntervalFn, clearIntervalFn })
    this.active = null
    this.sleepPending = false
    this.started = false
    this.guardTimer = null
    this.lastSleepEpoch = null
    this.lastWakeAt = -Infinity
    this.wakeTimeoutMs = wakeTimeoutMs
    this.wakeConfirmation = null
    this.cancelWakeConfirmation = null
    this.now = now
    this.resumePlan = null
    this.onWake = () => this.#resumeCompanionship()
    this.onSleep = () => {
      if (this.active?.cancelled || this.lastSleepEpoch !== this.movement.getPlayerCommandEpoch() || this.movement.getLocomotionOwner() !== 'PLAYER') void this.#wakeSafely()
    }
  }

  start() {
    if (this.started) return
    this.started = true
    this.bot.on('sleep', this.onSleep)
    this.bot.on('wake', this.onWake)
    this.guardTimer = this.setIntervalFn(() => {
      if (this.bot.isSleeping && (this.movement.getLocomotionOwner() === 'SURVIVAL' || this.lastSleepEpoch !== this.movement.getPlayerCommandEpoch())) void this.#wakeSafely()
      this.#resumeCompanionship()
    }, 250)
  }
  stop() {
    this.cancelWakeConfirmation?.()
    this.cancel(); this.started = false; this.bot.removeListener('sleep', this.onSleep)
    this.bot.removeListener('wake', this.onWake)
    if (this.guardTimer !== null) this.clearIntervalFn(this.guardTimer)
    this.guardTimer = null
  }
  #say(text) { this.bot.chat(text); this.session?.recordSpeech(text) }
  async #wakeSafely() {
    if (this.bot.isSleeping && Date.now() - this.lastWakeAt >= 1000) {
      this.lastWakeAt = Date.now()
      try { await sendWakeRequest(this.bot) } catch (error) { this.logger.info(`[REST] Wake request failed: ${error.message}`) }
    }
  }

  cancel() {
    this.resumePlan = null
    if (this.active) this.active.cancelled = true
    void this.#wakeSafely()
  }

  #resumeCompanionship() {
    const plan = this.resumePlan
    if (!plan || this.bot.isSleeping || this.sleepPending || this.wakeConfirmation) return false
    if (this.movement.getPlayerCommandEpoch() !== plan.epoch) {
      this.resumePlan = null
      this.logger.info('[REST] Resume discarded: newer player command')
      return false
    }
    if (this.movement.getLocomotionOwner() === 'SURVIVAL') return false
    plan.deadline ??= this.now() + 30000
    if (this.now() > plan.deadline) {
      this.resumePlan = null
      this.logger.info('[REST] Resume expired: previous player/ownership unavailable')
      return false
    }
    if (!this.movement.resumeAfterRest?.(plan.behavior, plan.epoch)) return false
    this.resumePlan = null
    this.logger.info(`[REST] Rest ended; restored ${plan.behavior.source || 'idle'} ${plan.behavior.type}`)
    return true
  }

  async request(action) {
    if (action === 'WAKE') {
      if (this.active) this.active.cancelled = true
      if (this.wakeConfirmation) { this.#say('已请求起床，正在等服务器确认。'); return }
      if (!this.bot.isSleeping) { this.#say(this.sleepPending ? '取消这次睡觉。' : '我现在没在睡觉。'); return }
      const epoch = this.movement.getPlayerCommandEpoch()
      let finish
      let timeout
      const confirmation = new Promise(resolve => {
        finish = result => {
          clearTimeout(timeout)
          this.bot.removeListener('wake', onWake)
          resolve(result)
        }
        const onWake = () => { if (!this.bot.isSleeping) finish('CONFIRMED') }
        this.bot.on('wake', onWake)
        timeout = setTimeout(() => finish(this.bot.isSleeping ? 'TIMEOUT' : 'CONFIRMED'), this.wakeTimeoutMs)
      })
      this.wakeConfirmation = confirmation
      this.cancelWakeConfirmation = () => finish('CANCELLED')
      this.#say('我试着起床，等服务器确认。')
      await this.#wakeSafely()
      if (!this.bot.isSleeping) finish('CONFIRMED')
      const result = await confirmation
      this.wakeConfirmation = null
      this.cancelWakeConfirmation = null
      this.logger.info(`[REST] Wake ${result}; sleeping=${Boolean(this.bot.isSleeping)}`)
      if (result !== 'CANCELLED' && epoch === this.movement.getPlayerCommandEpoch()) {
        this.#say(result === 'CONFIRMED' ? '起来了。' : '起床请求没得到服务器确认，我还在床上。')
      }
      if (result === 'CONFIRMED') this.#resumeCompanionship()
      return
    }
    if (this.sleepPending) { this.#say('正在确认床的状态，稍等一下。'); return }
    if (this.bot.isSleeping) { this.#say('我已经在床上了。'); return }
    const unavailable = sleepAvailability(this.bot)
    if (unavailable) { this.#say(unavailable); return }
    if (this.movement.getLocomotionOwner() === 'SURVIVAL') { this.#say('先避开眼前的危险，再睡。'); return }
    const origin = this.bot.entity?.position
    const beds = this.bot.findBlocks({ matching: block => Boolean(this.bot.isABed(block)), maxDistance: 3, count: 16 })
      .map(position => this.bot.blockAt(position))
      .filter(block => block && this.bot.isABed(block) && !this.bot.parseBedMetadata(block).occupied && origin.distanceTo(block.position) <= 3)
      .sort((a, b) => origin.distanceTo(a.position) - origin.distanceTo(b.position))
    const bed = beds[0]
    if (!bed) { this.#say('我身边三格内没有能用的空床，先带我靠近一张床吧。'); return }
    if (Object.values(this.bot.entities || {}).some(entity => entity.type === 'hostile' && entity.position?.distanceTo(bed.position) <= 10)) {
      this.#say('床附近有怪，先确保安全再睡。'); return
    }
    this.survival.cancelPursuit?.()
    const previousBehavior = this.movement.getBehaviorSummary()
    if (!this.movement.stop()) { this.#say('现在身体正忙，没法睡下。'); return }
    const operation = { cancelled: false, epoch: this.movement.getPlayerCommandEpoch() }
    this.resumePlan = { behavior: previousBehavior, epoch: operation.epoch, deadline: null }
    this.lastSleepEpoch = operation.epoch
    this.active = operation
    this.sleepPending = true
    const valid = () => !operation.cancelled && operation.epoch === this.movement.getPlayerCommandEpoch() && this.movement.getLocomotionOwner() === 'PLAYER'
    const monitor = this.setIntervalFn(() => { if (!valid()) { operation.cancelled = true; void this.#wakeSafely() } }, 100)
    this.#say('我试着在这张床睡下。')
    try {
      // Mineflayer resolves this only after receiving its sleep event (3s timeout).
      await this.bot.sleep(bed)
      if (!valid()) { await this.#wakeSafely(); return }
      this.#say(this.bot.isSleeping ? '这次确实躺下了。' : '没确认到睡眠状态，我不确定有没有睡下。')
      this.logger.info(`[REST] Sleep confirmed=${Boolean(this.bot.isSleeping)}`)
    } catch (error) {
      if (valid()) this.#say('没能睡下，可能床被挡住、被占用，或服务器不允许。')
      this.logger.info(`[REST] Sleep failed: ${error.message}`)
    } finally {
      this.clearIntervalFn(monitor)
      if (this.active === operation) this.active = null
      this.sleepPending = false
      this.#resumeCompanionship()
    }
  }
}

module.exports = { RestController, recognizeRestRequest, sleepAvailability }
