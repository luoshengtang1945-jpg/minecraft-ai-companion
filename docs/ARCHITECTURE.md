# Current Architecture

This document describes the manually validated Stage 3 checkpoint. It is a
snapshot of the working system before Learning Agent development. It does not
define or implement learning, long-term memory, multimodal vision, or voice.

## Runtime boundaries

The project has three independent runtime concerns:

1. The Node.js process runs Mineflayer, pathfinding, conversation, survival,
   combat, goals, autonomy, and lightweight presence.
2. Ollama runs the local Qwen model used by player conversation and periodic
   autonomous cognition. LLM requests are asynchronous and never own a game
   tick or pathfinder loop.
3. The optional Fabric client module runs only in each observing Minecraft
   client. It renders the configured local skin for the remote
   `AI_Companion` profile and does not control the bot.

```text
Minecraft LAN world
        │ protocol/events
        ▼
Mineflayer body ────────────────┐
        │                       │
        ├─ player chat ─> agent ├─> local Ollama/Qwen
        │                       │
        ├─ compact state ─> autonomy
        │
        ├─ survival reflexes ─> combat
        │
        └─ movement controller ─> mineflayer-pathfinder
                    ▲
                    │ one locomotion owner
       SURVIVAL > PLAYER > AUTONOMY > PRESENCE

Minecraft client rendering
        └─ Fabric AI Companion Client ─> local configurable PNG
```

## Node and Mineflayer agent

`bot.js` is the composition root. It creates the Mineflayer connection, loads
pathfinder, constructs each controller, and starts them after `spawn`.

- `src/config.js` is the only environment-variable boundary.
- `src/agent/` handles player-triggered conversation, validates LLM actions,
  and recognizes latency-sensitive FOLLOW, COME, and STOP commands before an
  LLM response arrives.
- `src/skills/` owns movement behavior and all pathfinder goal changes.
- `src/goals/` tracks source, priority, lifecycle, preemption, and resumption.
- `src/logger.js` provides normal and throttled logging.

No other subsystem should set or clear a pathfinder goal directly. Survival,
player commands, autonomy, and presence request movement through the movement
controller.

## Ollama and Qwen cognition

There are two deliberate LLM request paths:

- `src/agent/ollama-client.js` maintains a short player-conversation history
  and selects validated player actions.
- `src/autonomy/ollama-client.js` receives a compact current world state and
  selects at most one validated autonomous intention.

These requests may be in flight independently. Neither is awaited by the
survival timer or Mineflayer movement callbacks. Autonomy itself is
single-flight, uses configurable periodic/event scheduling, and captures a
locomotion epoch so stale movement results are rejected.

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
SURVIVAL > PLAYER > AUTONOMY > PRESENCE > NONE
```

PLAYER and SURVIVAL acquisition invalidates pending autonomous movement by
incrementing the autonomy epoch.

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

## Configuration and persistence

- `.env` contains machine/session values and is ignored.
- `.env.example` lists every environment option consumed by `src/config.js`.
- `config/companion-personality.json` is the tracked, non-secret personality
  definition kept separate from prompts.
- Runtime goals, event history, and conversation history are in memory only.
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
