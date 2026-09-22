# Current Architecture

This document describes the manually validated Stage 3 foundation plus the
opt-in Stage 4 Learning Agent and Stage 4.2 short-term multimodal perception
foundation. It does not implement general play, voice, long-term visual memory,
or unconstrained code execution.

## Runtime boundaries

The project has three independent runtime concerns:

1. The Node.js process runs Mineflayer, pathfinding, conversation, survival,
   combat, goals, autonomy, and lightweight presence.
2. Ollama runs the local Qwen model used by player conversation and periodic
   autonomous cognition. LLM requests are asynchronous and never own a game
   tick or pathfinder loop.
3. The optional Fabric client module runs only in each observing Minecraft
   client. It renders the configured local skin and can send a bounded native
   framebuffer capture to the Node loopback bridge. It never controls the bot.

```text
Minecraft LAN world
        │ protocol/events
        ▼
Mineflayer body ────────────────┐
        │                       │
        ├─ player chat ─> agent ├─> local Ollama/Qwen
        │                       │
        ├─ compact state ─> autonomy
        ├─ observations ─> learning ─> validated primitives
        │
        ├─ survival reflexes ─> combat
        │
        └─ movement controller ─> mineflayer-pathfinder
                    ▲
                    │ one locomotion owner
       SURVIVAL > PLAYER > PLAYER_TASK > AUTONOMY > PRESENCE

Minecraft client rendering
        └─ Fabric client ─> local skin
                         └─ bounded PNG/loopback ─> vision ─> fused world model
```

## Node and Mineflayer agent

`bot.js` is the composition root. It creates the Mineflayer connection, loads
pathfinder, constructs each controller, and starts them after `spawn`.

- `src/config.js` is the only environment-variable boundary.
- `src/agent/` routes chat into CONVERSATION, IMMEDIATE_COMMAND, TASK_GOAL, or
  CANCEL_TASK; FOLLOW/COME/STOP and task acknowledgement occur before an LLM
  response.
- `src/skills/` owns movement behavior and all pathfinder goal changes.
- `src/goals/` tracks source, priority, lifecycle, preemption, and resumption.
- `src/logger.js` provides normal and throttled logging.

No other subsystem should set or clear a pathfinder goal directly. Survival,
player commands, autonomy, and presence request movement through the movement
controller.

## Ollama and Qwen cognition

There are four deliberate LLM request paths:

- `src/agent/ollama-client.js` maintains a short player-conversation history
  and selects validated player actions.
- `src/autonomy/ollama-client.js` receives a compact current world state and
  selects at most one validated autonomous intention.
- `src/learning/ollama-client.js` selects validated primitive actions and
  produces evidence-grounded reflections.
- `src/vision/ollama-client.js` sends actual PNG image bytes through Ollama's
  multimodal `images` field and validates a compact grounded observation.

`src/ollama/request-scheduler.js` permits one local model request at a time and
orders it as PLAYER_VISUAL_PERCEPTION, PLAYER_CONVERSATION,
PLAYER_TASK_DECISION, TASK_VISUAL_PERCEPTION, LEARNING_REFLECTION,
BACKGROUND_VISUAL_PERCEPTION, then AUTONOMY.
Learning treats such preemption as a yield rather than episode failure.
Neither the queue nor any client is awaited by survival or movement ticks.

`src/ollama/structured-response.js` is the common HTTP and parsing boundary.
Every decision uses `stream:false`, an Ollama JSON Schema from
`src/ollama/schemas.js`, and a second local allowlist validator. It distinguishes
valid, empty, aborted, malformed, schema-invalid, and HTTP/Ollama failures.
Empty or malformed JSON can be retried without consuming a learning action.
For Ollama 0.34.2/qwen3-vl compatibility, an empty `message.content` may fall
back to `message.thinking` only when that entire alternate value passes the
same strict schema validation. Debug logging is bounded and opt-in.

## Survival and combat

`src/survival/` runs the high-frequency non-LLM reflex loop. It detects nearby
entities reported by Mineflayer as `entity.type === "hostile"`, attributes
recent damage when practical, enforces PASSIVE/DEFENSIVE/AGGRESSIVE policy,
and chooses retreat, creeper avoidance, or an authorized combat target.

`src/combat/` equips the best recognized melee weapon, approaches an authorized
target, and attacks with weapon-specific cooldowns. Combat authorization is
checked again after asynchronous equipment changes.

Survival owns the highest-priority locomotion override. When danger clears,
the movement controller restores a resumable player behavior such as FOLLOW.

## Autonomy and natural presence

`src/autonomy/` builds bounded state summaries, schedules cognition, validates
the supported Stage 3 action set, records recent events, and throttles proactive
speech. Autonomous movement is an intention that persists until completion or
preemption; inference intervals do not fragment an active path.

`src/presence/` is a cheap non-LLM layer for occasional looks and rare short
walks. It starts shortly after spawn but may run only when locomotion has no
higher-priority owner.

The locomotion arbiter in `src/skills/locomotion-arbiter.js` enforces exactly
one owner:

```text
SURVIVAL > PLAYER > PLAYER_TASK > AUTONOMY > PRESENCE > NONE
```

PLAYER and SURVIVAL acquisition invalidates pending autonomous movement by
incrementing the autonomy epoch.

## Learning Agent experiment

`src/learning/` is separate from player conversation, normal autonomy, and the
real-time survival loop. It implements this bounded cycle:

```text
OBSERVE -> THINK -> VALIDATE -> ACT -> OBSERVE RESULT
        -> DETERMINISTIC EVALUATE -> REFLECT -> REMEMBER -> RETRY
```

The only current objective is an inventory predicate for at least one
`oak_log`. The predicate states the desired result but contains no harvesting
recipe. Qwen receives compact symbolic observations and may choose one of
`OBSERVE`, `LOOK_VISUALLY`, `LOOK_AT`, `MOVE_NEAR`, `EXPLORE`, `ATTACK_ENTITY`, `DIG_BLOCK`, `USE_ITEM`,
`WAIT`, `SELECT_SLOT`, `STOP`, or `SAY`. A strict schema rejects unknown names, extra
arguments, code, commands, and filesystem targets before Mineflayer sees them.
The prompt describes only physical affordances: MOVE_NEAR delegates a durable
path, LOOK_AT changes facing, DIG_BLOCK completes one selected block-breaking
attempt, ATTACK_ENTITY performs one policy-gated attack, and USE_ITEM activates
the selected held item. It does not identify useful blocks, tools, or recipes.

EXPLORE accepts a heading and a 2–32 block total intention extent, plus optional
model-selected `watchFor` symbolic names. MOVE_NEAR also accepts `watchFor`.
A generic destination
selector finds a safe, less recently observed standing position in that chosen
direction and keeps every episode within its configured start-radius. It never
examines the goal, block names, biome, or resource type.

The executor retains one pathfinder goal until arrival, failure, timeout,
interruption, or meaningful evidence. `IntentionMonitor` examines symbolic
snapshots every 750 ms for new model-watched names or the exact objective item,
inventory completion, and changed accepted visual scene context. This emits
replanning evidence, without deriving a resource strategy or picking an action.
Survival suspends/resumes the same path; player command epochs terminate stale
intentions. No visual refresh is awaited between movement segments. Pending
player tasks reserve Presence suppression synchronously before memory loading.

Each episode owns bounded short-term exploration state containing recent region
visits, explored destinations, and compact block-observation snapshots. After a
failed/no-progress attempt, the next decision receives the previous action,
evaluation, grounded reflection, lesson, suggested next approach, and recent
failed action signatures. Repeated signatures are marked discouraged, but
JavaScript does not replace the model's decision with another primitive.

An automatic episode leases AUTONOMY; a natural player wood request creates a
PLAYER_TASK goal. Both suppress normal autonomy and presence. Ordinary chat
does not change the episode. Immediate PLAYER movement and SURVIVAL remain
authoritative, while explicit CANCEL_TASK invalidates pending learning output.

The deterministic evaluator—not Qwen—confirms success from observed inventory.
Action count, wall-clock duration, and repeated identical no-progress/failure
budgets terminate loops. Reflections are requested only from actual before and
after evidence. Completed episodes and learned candidates are written to the
configured local JSON file under `learning-memory/` by default; that directory
is ignored by Git. A successful candidate's steps are copied from the actual
episode rather than supplied as a built-in recipe.

## Fabric client integration

`fabric/ai-companion-client/` is a separate Java 21/Fabric 1.21.11 build. Its
Mixin intercepts the client skin lookup, matches a configurable remote profile
name, explicitly excludes the local human player, and registers one cached
local 64x64 texture. It performs no network upload and has no dependency on
the Node process or Ollama.

The default client configuration is created in the Minecraft instance at
`config/ai-companion-client.json`. The user-specific PNG defaults to
`config/offlineskins/AI_Companion.png` inside that instance and is intentionally
not stored in this repository.

This module is the appropriate future boundary for client-only visual
indicators or positional presentation. It must not become an alternate owner
of Mineflayer movement or survival decisions.

The same module can optionally observe completed renders through Minecraft
1.21.11's native `ScreenshotRecorder` framebuffer API. It downsamples before
transport and performs PNG encoding / HTTP work on a daemon executor. The
current capture is labelled `HUMAN_CLIENT_CAMERA`: it is an explicit shared
view approximation, not the Mineflayer entity's eyes. The protocol carries the
perspective so a future off-screen companion camera can replace it cleanly.

## Multimodal world model

`src/vision/` has four boundaries:

- `VisionFrameServer` binds only to loopback and accepts bounded PNG POSTs at
  `/v1/frames`; `FrameStore` is one replaceable slot, not a growing queue.
- `VisualPerceptionController` retains a latest-frame dirty flag and one background
  request. Completion (including failure/preemption/discard) starts a configurable
  cooldown. A new frame ID alone does not discard a completed observation. Age,
  dimension, perspective, UI, and newer accepted results guard freshness. Task/player
  requests bypass background cooldown; background work skips a busy model scheduler.
  It never touches movement.
- `VisionOllamaClient` sends the image to qwen3-vl and asks what appears there,
  not what gameplay action to take.
- `MultimodalWorldModel` retains a TTL-bound visual hypothesis beside current
  symbolic state, recent events, and goal context.

Sources stay explicit. `CONFIRMED_SYMBOLICALLY` is authoritative for exact
coordinates and objective evaluation; `OBSERVED_VISUALLY` is semantic and
confidence-labelled. Learning observations include this fused context, and
`LOOK_VISUALLY` requests a refresh without acquiring or stopping locomotion.
Visual conversation routing activates only for questions that depend on a
scene. Old visual observations expire instead of becoming permanent facts.

## Configuration and persistence

- `.env` contains machine/session values and is ignored.
- `.env.example` lists every environment option consumed by `src/config.js`.
- `config/companion-personality.json` is the tracked, non-secret personality
  definition kept separate from prompts.
- Runtime goals, event history, and conversation history are in memory only.
- Stage 4 episode/skill memory is local JSON under `learning-memory/` by default
  and is intentionally ignored. The model cannot choose or operate on its path.
- The local skin PNG, Minecraft instance data, model weights, dependencies,
  Gradle caches, and Fabric build outputs are ignored.

## Checkpoint extension rules

Future stages should preserve these verified invariants:

- survival stays independent of LLM latency;
- locomotion continues to have one authoritative owner;
- player commands and survival invalidate stale autonomous movement;
- new autonomous capabilities enter through validated actions and goal
  lifecycle management;
- persistent or learned data must have an explicit schema, ownership boundary,
  privacy policy, and reset/export behavior before it is enabled.

## Short-term companion context

`src/companion/session-context.js` is a read-only, session-local bridge between
player conversation and autonomous cognition. It samples player positions at 1 Hz,
reads existing movement ownership/commitments, and retains at most six recent
dialogue entries for five minutes. Conversation and autonomy consume the same
snapshot. It owns no locomotion, calls no LLM, scans no blocks, and clears its timer
and memory on disconnect. Movement/held-item observations do not prove an activity
such as mining. Existing survival/player arbitration and learning remain unchanged.

Arrival now issues at most one AUTONOMOUS FOLLOW intention after a short delay,
through the existing movement controller. It checks the player-command epoch,
nearby visibility and available ownership; no arrival timer can reverse STOP.
`RestController` handles explicit nearby-bed requests without model inference,
uses existing PLAYER STOP ownership and Mineflayer sleep confirmation, and wakes
on command invalidation or survival ownership. It does not navigate to/craft beds,
set spawn points separately, or add SLEEP to the learning action schema. Conversation
snapshots now expose symbolic weather/time and actual sleeping state.

Rest now stores a scoped resume plan (previous behavior + the temporary STOP's
player-command epoch). A confirmed/natural wake or failed sleep can restore FOLLOW
at its original priority, only while the matching temporary PLAYER STOP still owns
movement. Explicit waiting is preserved, newer commands discard the plan, survival
defers it, and target unavailability bounds retries. Successful restoration consumes
the plan once; idle restoration releases only this temporary lock. No additional
LLM calls or repeated GoalFollow updates are introduced.
