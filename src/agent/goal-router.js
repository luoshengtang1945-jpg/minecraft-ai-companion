const { recognizeImmediateMovement } = require('./immediate-movement')
const { GOAL_SOURCES } = require('../goals')
const { createOakLogGoal } = require('../learning/learning-controller')

const PLAYER_MESSAGE_TYPES = Object.freeze({
  CONVERSATION: 'CONVERSATION',
  IMMEDIATE_COMMAND: 'IMMEDIATE_COMMAND',
  TASK_GOAL: 'TASK_GOAL',
  CANCEL_TASK: 'CANCEL_TASK'
})

function normalize(message) {
  return String(message || '').replace(/[，。！？!?,.]/g, ' ').replace(/\s+/g, ' ').trim()
}

function isCancelTask(text) {
  return /(别弄了|别做了|别挖了|别砍了|别继续了|算了.*别|取消任务|停止任务|放弃任务|cancel\s+(the\s+)?task)/i.test(text)
}

function isOakLogGoal(text) {
  return /(木头|原木|橡木|挖树|砍树|oak[_ ]?logs?|\bwood\b|\blogs?\b)/i.test(text)
}

function classifyPlayerMessage(username, message) {
  const text = normalize(message)
  const immediateAction = recognizeImmediateMovement(text)
  if (immediateAction) {
    return { type: PLAYER_MESSAGE_TYPES.IMMEDIATE_COMMAND, immediateAction, text }
  }
  if (isCancelTask(text)) return { type: PLAYER_MESSAGE_TYPES.CANCEL_TASK, text }
  if (isOakLogGoal(text)) {
    return {
      type: PLAYER_MESSAGE_TYPES.TASK_GOAL,
      text,
      goal: createOakLogGoal({
        source: GOAL_SOURCES.PLAYER_TASK,
        requestedBy: username,
        request: message
      })
    }
  }
  return { type: PLAYER_MESSAGE_TYPES.CONVERSATION, text }
}

module.exports = { PLAYER_MESSAGE_TYPES, classifyPlayerMessage, isOakLogGoal, isCancelTask }
