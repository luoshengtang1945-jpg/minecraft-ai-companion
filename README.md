# Minecraft AI Companion

A local-first autonomous companion for Minecraft Java Edition, built with Mineflayer, mineflayer-pathfinder, Ollama, and `qwen3-vl:8b`. It can converse and follow player commands, but it also observes a compact game state and occasionally chooses its own safe nearby action when the player says nothing.

The project requires no paid API. Stage 3 does **not** implement full multimodal vision, voice, long-term memory, gathering, mining, crafting, or building.

This repository is currently at the manually validated Stage 3 checkpoint. Learning Agent behavior is intentionally not part of this checkpoint.

## Current capabilities

- Minecraft Java 1.21.11 connection through Mineflayer
- Local Ollama conversation and validated player actions
- `FOLLOW`, `COME`, `STOP`, and natural chat
- `PASSIVE`, `DEFENSIVE` (default), and `AGGRESSIVE` combat modes
- Real-time hostile detection independent of LLM inference
- Defensive player protection, low-health retreat, creeper avoidance, weapon selection, and timed melee attacks
- Periodic and event-triggered autonomous cognition with only one autonomy inference at a time
- Explicit single-owner locomotion arbitration: `SURVIVAL > PLAYER > AUTONOMY > PRESENCE`
- Compact state summaries containing position, player distance/activity, health, food, time, weather, combat mode, behavior, entities, resources, inventory, recent events, and current goal
- Autonomous `IDLE`, `FOLLOW_PLAYER`, `WANDER_NEAR_PLAYER`, `LOOK_AT_PLAYER`, `COME_TO_PLAYER`, `EXPLORE_NEARBY`, `SAY`, and `WAIT`
- Non-LLM spawn presence after a short randomized delay, plus bounded nearby movement with basic endpoint hazard checks
- Proactive speech with global cooldown and semantic-key deduplication
- Source-aware goals with survival/player/autonomous priority and interruption lifecycle
- An editable persistent personality configuration
- Optional local-only custom skin rendering for the remote `AI_Companion` profile through a purpose-built Fabric client mod

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for component boundaries, control flow, ownership rules, and extension constraints.

```text
                       ┌──────────────── player chat ────────────────┐
                       ▼                                             │
Minecraft <──> Mineflayer body <── locomotion arbiter <── player agent
     │                ▲                    ▲
     │                │                    │
     │         survival reflexes ─── SURVIVAL owner
     │          (150 ms, no LLM)            ▲
     │                                      │ priority/preemption
     ├── lightweight presence (no LLM) ─────────┘
     └── compact world state ──> autonomy ──────> action registry
                                  │
                             local Ollama
```

The layers are deliberately separate:

- `src/agent/` handles player-triggered conversation and commands.
- `src/autonomy/` owns scheduling, world-state summaries, autonomous inference, actions, safe nearby targets, event history, and speech throttling.
- `src/goals/` owns goal source, priority, lifecycle, interruption, resumption, and abandonment.
- `src/survival/` runs the real-time reflex loop and always has the highest priority.
- `src/combat/` owns weapon choice and attack execution.
- `src/skills/` owns high-level movement state and pathfinder goals.
- `src/presence/` schedules cheap spawn/idle looks and rare 1–3 block walks without Ollama.
- `config/companion-personality.json` contains personality and behavioral preferences separately from prompts.
- `fabric/ai-companion-client/` is an optional client-only Fabric 1.21.11 integration module. It maps a configured remote profile name to a local skin PNG without changing Mineflayer or uploading the image.

Ollama requests are asynchronous. Mineflayer events, pathfinding, and the survival timer continue while either conversation or autonomy is waiting for Qwen. Player and survival ownership increments an autonomy epoch, so stale movement results cannot execute later.

## Goal priority and lifecycle

Goal priority remains `SURVIVAL (100) > PLAYER (50) > AUTONOMOUS (10)`. Locomotion adds the lowest-priority `PRESENCE` owner and permits exactly one owner at a time.

- Survival interrupts a resumable player or autonomous goal, then resumes it if it is still relevant and inside its resume window.
- A player command abandons the current autonomous goal.
- A player movement command received during survival is retained as pending and starts after the emergency clears.
- Autonomous actions are rejected while a higher-priority goal owns the body.
- An in-progress autonomous movement intention is not replaced by periodic autonomy ticks.
- Autonomous movement goals complete on `goal_reached`; timed waits complete through bounded timers.

The action registry is intentionally extensible so future stages can register `GATHER`, `MINE`, `CRAFT`, `BUILD`, `EAT`, `EQUIP`, `SLEEP`, `EXPLORE`, `FIGHT`, and `RETURN_HOME` without replacing the scheduler or goal system.

## Autonomous world state

Every permitted inference receives compact JSON with:

- companion position, health, and food;
- selected player position, distance, movement, and heuristic activity;
- time of day, day number, and rain state when Mineflayer exposes them;
- combat mode and current movement behavior;
- grouped nearby hostile and passive entities;
- a small scan of useful nearby ores, logs, chests, furnaces, and crafting tables;
- a compact inventory summary;
- recent bounded events;
- current goal, source, priority, and payload.

Resource scanning is bounded and occurs only when building an autonomy state, not every game tick.

## Setup

Requirements:

- Node.js 18 or newer
- Minecraft Java Edition 1.21.11, or another configured compatible version
- A LAN/local server that accepts the configured Mineflayer account
- Ollama with `qwen3-vl:8b` installed locally

```bash
npm install
ollama pull qwen3-vl:8b
```

Copy `.env.example` to `.env`, set the current LAN port, then run:

```bash
npm start
```

`MC_PORT` is required because a Minecraft LAN port may change each session. `.env`, Minecraft data, model files, and `node_modules` are ignored by Git.

## Configuration

Core autonomy defaults:

| Variable | Default | Purpose |
| --- | ---: | --- |
| `AUTONOMY_ENABLED` | `true` | Enables the autonomy controller without affecting survival or chat |
| `AUTONOMY_INTERVAL_MS` | `30000` | Periodic inference interval; minimum 5000 ms |
| `AUTONOMY_EVENT_MIN_GAP_MS` | `10000` | Minimum gap between event-triggered inference starts |
| `AUTONOMY_SPEECH_COOLDOWN_MS` | `60000` | Minimum gap between autonomous chat messages |
| `AUTONOMY_SPEECH_DEDUP_MS` | `300000` | Prevents repeating the same contextual speech key |
| `AUTONOMY_MAX_PLAYER_DISTANCE` | `16` | Distance at which nearby exploration falls back to coming closer |
| `AUTONOMY_WANDER_RADIUS` | `6` | Maximum casual wander radius around the player |
| `AUTONOMY_EXPLORE_RADIUS` | `12` | Maximum Stage 3 exploration radius around the player |
| `AUTONOMY_SUMMARY_RANGE` | `12` | Entity summary radius |
| `AUTONOMY_RESOURCE_SCAN_RANGE` | `10` | Bounded useful-block scan radius |

Lightweight presence configuration:

| Variable | Default | Purpose |
| --- | ---: | --- |
| `PRESENCE_ENABLED` | `true` | Enables non-LLM natural presence |
| `PRESENCE_INITIAL_MIN_MS` | `1200` | Earliest first presence gesture after spawn |
| `PRESENCE_INITIAL_MAX_MS` | `3000` | Latest first presence gesture after spawn |
| `PRESENCE_INTERVAL_MIN_MS` | `10000` | Minimum recurring presence delay |
| `PRESENCE_INTERVAL_MAX_MS` | `22000` | Maximum recurring presence delay |
| `PRESENCE_WALK_TIMEOUT_MS` | `8000` | Safety timeout for a 1–3 block presence walk |

Combat remains `DEFENSIVE` by default. Autonomy has no action capable of changing combat mode or initiating hostile hunting. All combat, Ollama, connection, and survival tuning options are documented in `.env.example`.

Personality persists in `config/companion-personality.json` and can be edited without changing the LLM prompts or controller code.

## Custom local skin for AI_Companion

Mineflayer's `auth: 'offline'` creates an offline `GameProfile`; it cannot supply the Mojang-signed `textures` property used by an unmodified client for authenticated skins. The repository therefore includes a small client-only Fabric mod at `fabric/ai-companion-client/`. It intercepts skin selection only for the configured remote profile and explicitly leaves the local human player unchanged.

The default configuration already matches this project and the existing PCL instance layout:

```json
{
  "enabled": true,
  "profileName": "AI_Companion",
  "skinPath": "config/offlineskins/AI_Companion.png",
  "model": "wide"
}
```

For a launcher instance named `1.21.11-Fabric 0.19.5`, the default Windows skin path is:

```text
%APPDATA%\.minecraft\versions\1.21.11-Fabric 0.19.5\config\offlineskins\AI_Companion.png
```

The file must remain named `AI_Companion.png` at that path unless `skinPath` is changed in `config/ai-companion-client.json`. The current PNG is already valid at 64x64 and is referenced in place; it is not copied, changed, or uploaded.

Build and install the mod with Java 21:

```powershell
cd fabric\ai-companion-client
$env:JAVA_HOME = "$env:APPDATA\.minecraft\runtime\java-runtime-delta"
.\gradlew.bat build
$instanceDir = Join-Path $env:APPDATA ".minecraft\versions\1.21.11-Fabric 0.19.5"
Copy-Item .\build\libs\ai-companion-client-1.0.0.jar (Join-Path $instanceDir "mods")
```

Before launching, remove or disable `offline-skins-1.21.11.jar` in that same `mods` directory. Its global texture replacement conflicts with identity-specific rendering and is not used by this implementation. The replacement is `ai-companion-client-1.0.0.jar`; Fabric API is not required by it, although the instance may keep Fabric API for other mods.

On first launch, the mod creates:

```text
%APPDATA%\.minecraft\versions\1.21.11-Fabric 0.19.5\config\ai-companion-client.json
```

Set `model` to `slim` only if the PNG uses three-pixel-wide arms. Each Minecraft client that should see the custom appearance must install the mod and have access to its own local PNG; the LAN server and Mineflayer process require no skin changes.

### Exact manual custom-skin test

1. Fully exit Minecraft before changing jars. In the instance `mods` directory, confirm `ai-companion-client-1.0.0.jar` is present and `offline-skins-1.21.11.jar` is absent or has a non-jar suffix such as `.jar.disabled`.
2. Confirm the skin still exists as the exact 64x64 file `config/offlineskins/AI_Companion.png`; do not rename it.
3. Launch the `1.21.11-Fabric 0.19.5` instance. Open `logs/latest.log` and confirm it contains `AI Companion client integration enabled for remote profile AI_Companion`.
4. Open the test world to LAN and put the current LAN port in the repository `.env` as `MC_PORT`.
5. From the repository root, run `npm start` and wait for the Mineflayer player named exactly `AI_Companion` to join.
6. Look directly at `AI_Companion`. Confirm the custom PNG is rendered, including its second layer, and that arm geometry matches the configured `wide` model.
7. Switch the human player to third-person view with F5. Confirm the legitimate human account still uses its own normal Microsoft/Minecraft skin.
8. Exercise `跟我来`, `过来`, `停下`, and a defensive combat scenario. Confirm the skin remains attached while the existing movement and survival behavior is unchanged.
9. Stop the bot, leave the world, fully restart Minecraft, reopen the LAN world, and start the bot again. Confirm the same custom skin returns without any upload or reconfiguration.
10. If the bot is still default-skinned, check `logs/latest.log` for `AI Companion skin file does not exist` or `must be a modern 64x64 PNG`, and verify that the profile name in `config/ai-companion-client.json` remains exactly `AI_Companion`.

## Development checks

```bash
npm run check
npm test
```

Build and test the optional Fabric client module separately:

```powershell
cd fabric\ai-companion-client
.\gradlew.bat build
```

Tests cover locomotion ownership, stale inference epochs, immediate commands, spawn presence, durable autonomous movement, LOOK isolation, autonomy scheduling, single-flight inference, speech throttling, goal lifecycle, survival interruption, Stage 2 combat, and movement restoration.

## Exact manual Stage 3 test procedure

Use a flat test area with `keepInventory` enabled if desired.

1. Start Ollama and confirm `ollama list` contains `qwen3-vl:8b`.
2. Open Minecraft Java 1.21.11 to LAN, copy its current port into `.env`, and leave `COMBAT_MODE=DEFENSIVE` and `AUTONOMY_ENABLED=true`.
3. Set daytime before starting the bot so a dusk event does not trigger early inference. Keep the normal `AUTONOMY_INTERVAL_MS=30000` for the spawn test.
4. Run `npm start`. Confirm logs report DEFENSIVE combat, autonomy enabled, and `Lightweight presence enabled`.
5. Within roughly 1.2–3 seconds, confirm the companion looks toward the visible player or looks around. This first gesture must happen before the first periodic Ollama autonomy call.
6. Leave it uncommanded for 30–60 seconds. If presence chooses a short walk, confirm `[MOVE] NONE -> PRESENCE (WANDER)` followed by `PRESENCE -> NONE`, with only a 1–3 block destination.
7. Wait for an LLM movement intention such as `WANDER_NEAR_PLAYER` or `EXPLORE_NEARBY`. Confirm `[MOVE] NONE -> AUTONOMY (...)` appears once and movement continues smoothly until goal completion. There should be no periodic `setGoal(null)`-style stopping.
8. While that autonomous movement is still active, wait past another autonomy interval. Confirm no new movement intention replaces the current path; the next movement decision occurs only after completion/interruption.
9. When the log prints `Autonomy inference`, immediately say “跟我来” before Qwen responds. Confirm locomotion changes to PLAYER immediately, before the chat reply, and the eventual autonomy result does not move the bot.
10. Walk continuously for at least 60 seconds with FOLLOW active. Confirm one persistent follow path, no presence walks, no autonomous COME/wander, and no repeated ownership changes. Autonomous `SAY` remains allowed.
11. Spawn an immediate hostile while FOLLOW is active. Confirm `[MOVE] PLAYER -> SURVIVAL`, then after the threat clears `[MOVE] SURVIVAL -> PLAYER (resume FOLLOW)` and smooth following resumes automatically.
12. During survival, say “跟我来”. Confirm survival retains ownership until danger clears, then the pending FOLLOW command starts.
13. Say “停下”, “别动”, or “等我”. Confirm PLAYER takes ownership immediately, pathfinding stops once, and neither autonomy nor presence restarts wandering afterward.
14. Say “过来” from a distance. Confirm COME starts immediately without waiting for the LLM response and ends cleanly on arrival.
15. Let a presence or autonomous LOOK action occur. Confirm it changes orientation only and never clears or replaces a pathfinder goal.
16. Trigger a deliberately slow autonomy inference, then create immediate danger before Ollama responds. Confirm survival reacts while inference is pending and the stale autonomous movement result never executes afterward.
17. Spawn a normal hostile 6–8 blocks away without causing damage. Confirm default DEFENSIVE behavior still ignores it and autonomy does not switch to AGGRESSIVE.
18. Spawn a creeper 4–5 blocks away during FOLLOW. Confirm avoidance preempts FOLLOW and FOLLOW resumes afterward.
19. Reduce the companion below eight health and trigger an authorized fight. Confirm low-health retreat takes SURVIVAL ownership and later releases it correctly.
20. Optionally reduce `AUTONOMY_INTERVAL_MS` to `10000` only after the smooth FOLLOW test. Confirm faster cognition still does not fragment an active movement intention.

LLM choices are intentionally non-deterministic. A particular inference may choose `IDLE` or `WAIT`; validate safety, cadence, priority, and boundedness across several decisions rather than expecting one exact action every interval.

## Known limitations

- Player activity is inferred from velocity, water state, and held item; there is no visual scene understanding yet.
- “帮我打它” selects the nearest eligible non-creeper hostile rather than using crosshair ray tracing.
- Damage events do not identify the attacker, so defensive attribution selects a nearby plausible hostile.
- Safe autonomous movement validates the destination and relies on pathfinder for the route; it does not yet perform full route-level cliff, water, or hazard planning.
- Useful-block summaries are bounded local scans, not semantic vision or world memory.
- Goals and recent events are runtime-only and reset when the process exits. Personality configuration persists, but long-term episodic memory is not implemented.
- Autonomous actions do not gather, mine, craft, build, eat, equip, sleep, fight, or travel beyond the nearby player area.
- Only autonomy inference is single-flight. Player conversation and autonomy may each have a separate Ollama request in progress, while survival remains independent of both.
- The custom skin is client-side by design. Vanilla/unmodded observers still see the offline default skin, and every observing client must install the Fabric module locally.
- The skin is cached for the Minecraft client session. Changing the PNG or identity configuration requires a Minecraft restart.

## License

This project, including the Fabric client module, is licensed under the [MIT License](LICENSE).
