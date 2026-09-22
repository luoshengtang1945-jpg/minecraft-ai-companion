const IMMEDIATE_MOVEMENT = Object.freeze({
  FOLLOW: 'FOLLOW',
  COME: 'COME',
  STOP: 'STOP'
})

function recognizeImmediateMovement(message) {
  const text = String(message || '').replace(/[，。！？!?,.]/g, '').trim()
  if (/(停下|别动|不要动|等我|原地等)/.test(text)) return IMMEDIATE_MOVEMENT.STOP
  if (/(跟我来|跟着我|跟我走)/.test(text)) return IMMEDIATE_MOVEMENT.FOLLOW
  if (/(过来|回来|回我这|来我这|到我身边|回到我身边)/.test(text)) return IMMEDIATE_MOVEMENT.COME
  return null
}

module.exports = { IMMEDIATE_MOVEMENT, recognizeImmediateMovement }
