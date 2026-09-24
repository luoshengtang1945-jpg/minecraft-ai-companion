const { proactiveClaimIssue } = require('../autonomy/proactive-claims')

const UNVERIFIED_SCENE = /(?:附近|前面|那边|这边|不远处|远处|周围|眼前|我看到|我看见).{0,18}(?:有|是|能看到|几朵|几只).{0,18}(?:林子|森林|树|山|洞|河|湖|海|村庄|房子|建筑|矿|羊|鸡|怪|花|蒲公英|动静|脚步声)/
const UNSUPPORTED_NEARBY_PLACE = /(?:附近|前面|这边|周围)的(?:山洞|洞穴|森林|林子|村庄|矿洞|矿脉|河|湖|海|房子|建筑)/
const UNSOLICITED_COMBAT = /(?:一起|陪你|咱们|我们).{0,8}(?:打怪|打会儿怪|清怪|杀怪)/
const UNSUPPORTED_RESOURCE_HELP = /(?:我)?(?:可以|能|会|来)?(?:帮你|陪你|跟你|带你).{0,5}(?:找|收集|采|挖|砍).{0,10}(?:材料|资源|木头|木材|石头|泥土|矿)/
const UNSUPPORTED_RESOURCE_INTENT = /我(?:想|打算|准备|要).{0,8}(?:找|挖|采|砍|收集).{0,8}(?:资源|材料|木头|木材|石头|矿)/

const EMOTIONAL_MESSAGE = /无聊|好闷|孤单|寂寞|难过|心情不好|bored|lonely|sad/i
const EMOTIONAL_ACKNOWLEDGEMENT = /无聊|闷|孤单|寂寞|难过|心情|陪|懂|在呢|聊|不开心/
const EMOTIONAL_WORK_ASSIGNMENT = /(?:试试|要不要|不如|可以|干脆).{0,20}(?:挖|采|建|盖|合成|命令方块|红石)/
const ASKS_PREFERENCE = /你想(?:做|干|玩)|你(?:更)?喜欢.{0,18}[吗么]|你喜欢(?:做|玩)|what do you want(?: to do)?|what would you like(?: to do)?|do you like/i
const STATES_PREFERENCE = /我(?:想|更喜欢|比较喜欢|挺喜欢|宁愿)|我会选|我倒想/
const ASKS_SHARED_MEMORY = /(?:还)?记得.{0,18}(?:我们|咱们|一起)|(?:do you remember|remember when).{0,35}(?:we|our)/i
const MEMORY_UNCERTAINTY = /(?:没有|没).{0,8}(?:记录|记忆|印象)|(?:记不清|不记得|不能确认|不确定|不清楚|不敢说记得)/
const AFFIRMATIVE_SHARED_MEMORY = /(?:^|[，。！!？?\s])(?:当然|肯定|还)?记得(?:[，。！!？?\s]|$)/
const UNSUPPORTED_PAST_DETAIL = /那天|上次|当时|以前|曾经|屋顶|矿洞|山谷|用的材料/
const ASKS_BUILD_CAPABILITY = /(?:能|会|可以).{0,8}(?:建|盖|造).{0,5}房|can you build.{0,12}house/i
const ACKNOWLEDGES_BUILD_LIMIT = /(?:不会|不能|还不|做不到|不擅长|不可靠).{0,8}(?:建|盖|造).{0,4}房|(?:建|盖|造).{0,4}房.{0,8}(?:不会|不能|还不|做不到|不擅长|不可靠)/
const BUILD_CONDITIONAL_EXCUSE = /(?:不能|不会|还不).{0,8}(?:建|盖|造).{0,4}房.{0,12}(?:得先|要先|先得|只要|才行)/
const UNSUPPORTED_BUILD_COLLABORATION = /(?:指挥我|教我).{0,8}(?:搬砖|建|盖|搭|放方块|砌墙)|我.{0,8}(?:搬砖|砌墙|打地基)/
const ASKS_WEATHER_PREFERENCE = /(?:喜欢|偏爱).{0,12}(?:雨|晴)|do you like.{0,12}(?:rain|sun)/i
const SUSPECT_GAME_MECHANIC = /(?:种|晒干|打怪|挖矿|采矿|合成|刷怪|刷.{0,4}资源|资源|矿石|作物|蘑菇|收集.{0,4}(?:雨滴|雨水|阳光|云朵))/

function chatReplyIssue(reply, { freshVisual = false, playerMessage = '' } = {}) {
  if (freshVisual && /方块.{0,12}(?:不确定|不知道|说不准).{0,6}(?:是不是|算不算)方块/.test(reply)) return 'VISUAL_SELF_CONTRADICTION'
  if (!freshVisual && (UNVERIFIED_SCENE.test(reply) || UNSUPPORTED_NEARBY_PLACE.test(reply))) return 'UNVERIFIED_SCENE'
  if (UNSOLICITED_COMBAT.test(reply)) return 'UNSOLICITED_COMBAT'
  if (UNSUPPORTED_RESOURCE_HELP.test(reply)) return 'UNSUPPORTED_RESOURCE_HELP'
  if (UNSUPPORTED_RESOURCE_INTENT.test(reply)) return 'UNSUPPORTED_RESOURCE_HELP'
  const issue = proactiveClaimIssue(reply)
  if (issue === 'UNSUPPORTED_WORK_PROPOSAL' || issue === 'UNSTARTED_MOVEMENT_CLAIM' || issue === 'UNVERIFIED_ATTACKER') return issue
  if (EMOTIONAL_MESSAGE.test(playerMessage) && !EMOTIONAL_ACKNOWLEDGEMENT.test(reply)) return 'MISSED_EMOTION'
  if (EMOTIONAL_MESSAGE.test(playerMessage) && EMOTIONAL_WORK_ASSIGNMENT.test(reply)) return 'OVERLOADED_EMOTION_REPLY'
  if (EMOTIONAL_MESSAGE.test(playerMessage) && /或者|也可以/.test(reply)) return 'OVERLOADED_EMOTION_REPLY'
  if (ASKS_PREFERENCE.test(playerMessage) && !STATES_PREFERENCE.test(reply)) return 'DODGED_PREFERENCE'
  if (ASKS_SHARED_MEMORY.test(playerMessage) &&
      (!MEMORY_UNCERTAINTY.test(reply) || UNSUPPORTED_PAST_DETAIL.test(reply) ||
       AFFIRMATIVE_SHARED_MEMORY.test(reply))) return 'UNVERIFIED_SHARED_MEMORY'
  if (ASKS_BUILD_CAPABILITY.test(playerMessage) &&
      (!ACKNOWLEDGES_BUILD_LIMIT.test(reply) || BUILD_CONDITIONAL_EXCUSE.test(reply) ||
       UNSUPPORTED_BUILD_COLLABORATION.test(reply))) return 'DODGED_BUILD_LIMIT'
  if (ASKS_WEATHER_PREFERENCE.test(playerMessage) && SUSPECT_GAME_MECHANIC.test(reply)) return 'UNSUPPORTED_MECHANIC_CLAIM'
  return null
}

module.exports = { chatReplyIssue }
