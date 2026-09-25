const WORK_VERBS = /挖|采|砍|合成|建|盖|造|收集|种|钓|烧|炼/
const SHARED_PROGRESS = /(?:最近|刚才|之前|我们|咱们|你).{0,18}(?:进度|成果|完成|做完|多少|怎么样|如何)|(?:挖|采|砍|合成|建|盖|造|收集|种|钓|烧|炼).{0,12}(?:进度|成果|完成|做完|多少)/
const UNSUPPORTED_PROPOSAL = /(?:一起|一块|咱们|我们).{0,8}(?:挖|采|砍|合成|建|盖|造|找.{0,4}(?:煤|矿|材料|资源|木头))/
const UNSUPPORTED_RESOURCE_SCOUT = /(?:一起|一块|咱们|我们).{0,8}(?:看|找|逛).{0,14}(?:有没有|哪里有|找).{0,8}(?:煤|矿|材料|资源|木头)/
const UNVERIFIED_ATTACKER = /(?:刚才|刚刚|方才|这下)?(?:被|让).{1,16}(?:打|咬|撞|抓|射|炸|揍|攻击)(?:了|一)/
const UNSTARTED_MOVEMENT = /我(?:得|要|准备|打算|先|会|这就).{0,8}(?:去|走|跑|探索|查看|挖|建)|我带你(?:去|看|走)/
const FOLLOWING_CLAIM = /我(?:正|正在|还在|会|一直)?(?:跟着|跟随|跟上)你|我跟你(?:走|来)/
const WALK_INVITATION = /(?:一起|一块|咱们|我们).{0,5}(?:走|逛|出发|过去|去看看)/
// A resource in inventory does not prove how it was found. Until we keep a
// verified discovery event, proactive retrospective discovery claims are unsafe.
const UNVERIFIED_DISCOVERY = /我(?:刚|刚才|方才|最近).{0,20}(?:找到|发现|找到了).{1,24}/

function proactiveClaimIssue(message, state = null) {
  const text = String(message || '')
  if (UNVERIFIED_ATTACKER.test(text)) return 'UNVERIFIED_ATTACKER'
  if (UNVERIFIED_DISCOVERY.test(text)) return 'UNVERIFIED_DISCOVERY'
  if (FOLLOWING_CLAIM.test(text) && state?.behavior?.type !== 'FOLLOW') return 'FALSE_FOLLOW_CLAIM'
  if (state?.behavior?.type === 'STOP' && state.behavior.source === 'PLAYER' && WALK_INVITATION.test(text)) {
    return 'CONTRADICTS_PLAYER_STOP'
  }
  if (UNSTARTED_MOVEMENT.test(text) && state?.behavior?.locomotionOwner !== 'AUTONOMY') return 'UNSTARTED_MOVEMENT_CLAIM'
  // A proposal to jointly perform an unimplemented work skill implies the
  // companion can do it. Player-requested learning has its own explicit path.
  if (UNSUPPORTED_PROPOSAL.test(text) || UNSUPPORTED_RESOURCE_SCOUT.test(text)) return 'UNSUPPORTED_WORK_PROPOSAL'
  if (!WORK_VERBS.test(text) || !SHARED_PROGRESS.test(text)) return null
  const playerDialogue = state?.companionSession?.recentDialogue?.filter(entry => entry.speaker === 'player') || []
  const knownTask = JSON.stringify(state?.currentGoal || '')
  if (WORK_VERBS.test(knownTask) || playerDialogue.some(entry => WORK_VERBS.test(entry.text || ''))) return null
  return 'UNOBSERVED_SHARED_TASK'
}

module.exports = { proactiveClaimIssue }
