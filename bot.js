const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const { GoalFollow, GoalNear } = goals

const bot = mineflayer.createBot({
  host: 'localhost',
  port: 60976,
  username: 'AI_Companion',
  auth: 'offline',
  version: '1.21.11'
})

bot.loadPlugin(pathfinder)

const OLLAMA_URL = 'http://localhost:11434/api/chat'
const MODEL = 'qwen3-vl:8b'

const history = []
let movements = null
let followingPlayer = null

bot.once('spawn', () => {
  movements = new Movements(bot)
  bot.pathfinder.setMovements(movements)

  console.log('✅ AI Companion 已进入 Minecraft！')
  console.log('🦵 移动系统已启动')
  bot.chat('我回来了，这次我会走路了。')
})

function getPlayer(username) {
  return bot.players[username]?.entity
}

function followPlayer(username) {
  const player = getPlayer(username)

  if (!player) {
    bot.chat('我没看到你，你跑哪去了？')
    return false
  }

  followingPlayer = username

  // 保持大约 2 格距离，并持续跟踪目标
  bot.pathfinder.setGoal(
    new GoalFollow(player, 2),
    true
  )

  console.log(`🚶 开始跟随 ${username}`)
  return true
}

function comeToPlayer(username) {
  const player = getPlayer(username)

  if (!player) {
    bot.chat('我现在看不到你。')
    return false
  }

  followingPlayer = null

  bot.pathfinder.setGoal(
    new GoalNear(
      player.position.x,
      player.position.y,
      player.position.z,
      1
    )
  )

  console.log(`🏃 正在前往 ${username}`)
  return true
}

function stopMoving() {
  followingPlayer = null
  bot.pathfinder.setGoal(null)
  bot.clearControlStates()

  console.log('🛑 已停止移动')
}

async function askAI(username, message) {
  history.push({
    role: 'user',
    content: `${username} 对你说：${message}`
  })

  if (history.length > 20) {
    history.splice(0, history.length - 20)
  }

  const response = await fetch(OLLAMA_URL, {
    method: 'POST',

    headers: {
      'Content-Type': 'application/json'
    },

    body: JSON.stringify({
      model: MODEL,
      stream: false,

      messages: [
        {
          role: 'system',
          content: `
你叫 AI_Companion，是 Minecraft 中陪玩家一起玩的队友。

你现在拥有以下真实能力：

CHAT：只聊天
FOLLOW：持续跟随玩家
COME：走到玩家身边
STOP：停止移动

你必须判断玩家真正想让你做什么。

只输出一个 JSON 对象，不要输出 Markdown，不要解释。

格式：

{
  "action": "CHAT",
  "reply": "你想说的话"
}

action 只能是：
CHAT
FOLLOW
COME
STOP

例如：

玩家：“跟我来”
{
  "action": "FOLLOW",
  "reply": "来了。"
}

玩家：“过来一下”
{
  "action": "COME",
  "reply": "来了来了。"
}

玩家：“你在这里等我”
{
  "action": "STOP",
  "reply": "行，我在这等你。"
}

玩家：“你觉得我们先干嘛？”
{
  "action": "CHAT",
  "reply": "先弄点吃的吧，不然晚上挺麻烦。"
}

说话自然、简短，像一起玩游戏的朋友。
不要假装执行自己没有的能力。
`
        },

        ...history
      ]
    })
  })

  if (!response.ok) {
    throw new Error(`Ollama HTTP ${response.status}`)
  }

  const data = await response.json()

  let text = data.message?.content?.trim()

  // 防止模型偶尔套 ```json
  text = text
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim()

  return JSON.parse(text)
}

bot.on('chat', async (username, message) => {
  if (username === bot.username) return

  console.log(`[MC] ${username}: ${message}`)

  try {
    console.log('🧠 AI 正在决定做什么...')

    const decision = await askAI(username, message)

    console.log('🤖 决策：', decision)

    switch (decision.action) {
      case 'FOLLOW':
        followPlayer(username)
        break

      case 'COME':
        comeToPlayer(username)
        break

      case 'STOP':
        stopMoving()
        break

      case 'CHAT':
      default:
        break
    }

    if (decision.reply) {
      bot.chat(
        decision.reply
          .replace(/\n+/g, ' ')
          .slice(0, 220)
      )
    }

    history.push({
      role: 'assistant',
      content: JSON.stringify(decision)
    })

  } catch (error) {
    console.error('❌ AI 决策失败：', error)
    bot.chat('等下，我脑子刚卡了一下。')
  }
})

bot.on('goal_reached', () => {
  if (!followingPlayer) {
    console.log('📍 已到达目标')
  }
})

bot.on('path_update', result => {
  if (result.status === 'noPath') {
    console.log('⚠️ 找不到路径')
  }
})

bot.on('kicked', reason => {
  console.log('❌ 被踢出：', reason)
})

bot.on('error', err => {
  console.log('❌ Mineflayer 错误：', err)
})