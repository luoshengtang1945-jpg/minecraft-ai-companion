const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { SurvivalController } = require('../src/survival/survival-controller')

function fixture() {
  const bot = new EventEmitter()
  bot.username = 'AI_Companion'
  bot.entity = { id: 10, position: { distanceTo: () => 0 } }
  bot.players = {}
  bot.entities = {}

  const combat = { disengage() {} }
  const movement = { endOverride() {} }
  const logger = { info() {}, warn() {}, throttled() {} }
  const config = {
    initialCombatMode: 'DEFENSIVE',
    detectionRange: 10,
    attackOrderMs: 15000
  }
  return new SurvivalController(bot, { combat, movement, logger, config })
}

test('DEFENSIVE is the default combat mode', () => {
  assert.equal(fixture().getCombatMode(), 'DEFENSIVE')
})

test('PASSIVE rejects explicit attack orders', () => {
  const survival = fixture()
  survival.setCombatMode('PASSIVE')
  assert.deepEqual(survival.requestAttack('Steve'), { accepted: false, reason: 'PASSIVE' })
})
