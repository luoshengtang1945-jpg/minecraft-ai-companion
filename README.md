# Minecraft AI Companion

See [the companion checkpoint](docs/COMPANION-CHECKPOINT.md) for user-verified
behavior, release checks, remaining limitations, and the next development priorities.

A local-first autonomous companion for Minecraft Java Edition, built with Mineflayer, mineflayer-pathfinder, Ollama, and `qwen3-vl:8b`. It can converse and follow player commands, but it also observes a compact game state and occasionally chooses its own safe nearby action when the player says nothing.

The project requires no paid API. Stage 4.2 adds an opt-in local multimodal perception foundation; it does **not** implement voice, long-term visual memory, a true companion render camera, or general Minecraft play.

The manually validated Stage 3 stack remains the stable foundation. The current feature branch adds the minimal Learning Agent loop for one objective: obtain at least one `oak_log` through validated primitives, observation, evaluation, reflection, and local memory. Learning is disabled by default.

## Current capabilities

- Minecraft Java 1.21.11 connection through Mineflayer
- Local Ollama conversation and validated player actions
- `FOLLOW`, `COME`, `STOP`, and natural chat
- `PASSIVE`, `DEFENSIVE` (default), and `AGGRESSIVE` combat modes
- Real-time hostile detection independent of LLM inference
- Defensive player protection, low-health retreat, creeper avoidance, weapon selection, and timed melee attacks
- Periodic and event-triggered autonomous cognition with only one autonomy inference at a time
- Explicit single-owner locomotion arbitration: `SURVIVAL > PLAYER > PLAYER_TASK > AUTONOMY > PRESENCE`
- Compact state summaries containing position, player distance/activity, health, food, time, weather, combat mode, behavior, entities, resources, inventory, recent events, and current goal
- Autonomous `IDLE`, `FOLLOW_PLAYER`, `WANDER_NEAR_PLAYER`, `LOOK_AT_PLAYER`, `COME_TO_PLAYER`, `EXPLORE_NEARBY`, `SAY`, and `WAIT`
- Non-LLM spawn presence after a short randomized delay, plus bounded nearby movement with basic endpoint hazard checks
- Proactive speech with global cooldown and semantic-key deduplication
- Source-aware goals with survival/player/autonomous priority and interruption lifecycle
- An editable persistent personality configuration
- Optional local-only custom skin rendering for the remote `AI_Companion` profile through a purpose-built Fabric client mod
- Opt-in Stage 4.0 learning episodes with strict primitive actions, deterministic objective evaluation, bounded retries, grounded reflection, and ignored local JSON memory
- Opt-in Stage 4.2 Fabric framebuffer capture, bounded loopback transport, qwen3-vl perception, short-lived fused visual/symbolic state, visual questions, and `LOOK_VISUALLY`

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
                                  ▲
     controlled observation ──> learning loop ──> validated primitives
     Fabric framebuffer ──localhost PNG──> visual perception ──> fused world model
```

The layers are deliberately separate:

- `src/agent/` handles player-triggered conversation and commands.
- `src/autonomy/` owns scheduling, world-state summaries, autonomous inference, actions, safe nearby targets, event history, and speech throttling.
- `src/goals/` owns goal source, priority, lifecycle, interruption, resumption, and abandonment.
- `src/survival/` runs the real-time reflex loop and always has the highest priority.
- `src/combat/` owns weapon choice and attack execution.
- `src/skills/` owns high-level movement state and pathfinder goals.
- `src/presence/` schedules cheap spawn/idle looks and rare 1–3 block walks without Ollama.
- `src/learning/` owns the Stage 4.0 observation/action/evaluation/reflection loop, episode budgets, and local learned-skill memory. Autonomous experiments use the AUTONOMY tier; player-requested learning uses the intermediate PLAYER_TASK tier.
- `src/ollama/` serializes local model work and preempts lower-priority inference when player conversation arrives.
- `src/vision/` validates a single-slot local frame stream, schedules qwen3-vl perception, and holds a source-labelled short-term multimodal world model.
- `config/companion-personality.json` contains personality and behavioral preferences separately from prompts.
- `fabric/ai-companion-client/` maps a configured remote profile to a local skin PNG and can optionally capture/downscale the native game framebuffer for the loopback visual bridge.

Ollama requests are asynchronous and centrally scheduled as `PLAYER_VISUAL_PERCEPTION > PLAYER_CONVERSATION > PLAYER_TASK_DECISION > TASK_VISUAL_PERCEPTION > LEARNING_REFLECTION > BACKGROUND_VISUAL_PERCEPTION > AUTONOMY`. Vision owns no locomotion tier: Mineflayer events, pathfinding, combat, and the survival timer never wait for Qwen.

## Stage 4.2 local visual perception

Set `VISION_ENABLED=true` in `.env` and `visionEnabled=true` in the Fabric client config to opt in. Fabric captures the completed Minecraft framebuffer at a low rate, downsamples it (960×540 default), computes a 16×9 grayscale change signature, and POSTs a bounded PNG to `http://127.0.0.1:32145/v1/frames`. Both sides accept loopback only; an optional shared token can be set on both sides. Node keeps only the newest non-stale frame, rejects malformed/oversize input, and drops redundant background work.

The current source is explicitly `HUMAN_CLIENT_CAMERA`. It is useful shared visual context, but it is not AI_Companion's own viewpoint. The source label is retained through the world model and conversation prompt. Visual claims remain approximate region/confidence hypotheses; only Mineflayer symbolic observations may supply exact positions, health, inventory, entities, or objective success.

Background perception checks at a 45-second interval and after substantial grayscale changes, with `VISION_BACKGROUND_COOLDOWN_MS=30000` measured from completion. Incoming frames replace one pending slot while inference runs. A newer frame ID alone does not invalidate a useful result; age, dimension, UI, or a newer accepted observation can. Background work does not queue behind busy model work, and cooldown also follows preemption/discard/failure. Task/player refreshes bypass background cooldown. Visual observations expire 30 seconds after capture. Optional bounded debug frames go under ignored `vision-debug/`.

Fabric labels frames `GAMEPLAY`, `MENU`, `CHAT`, `INVENTORY`, or `OTHER_SCREEN` using the client Screen type. World perception processes only `GAMEPLAY`. Frames without UI metadata are conservatively treated as `OTHER_SCREEN`, so rebuild and install the updated Fabric jar. `[VISION] metrics` summarizes received/replaced frames, inference starts, accepted/stale observations, and preemption at most once per 30 seconds.

Learning `EXPLORE` now specifies a total intention extent of 2–32 blocks, still constrained by the episode radius. Qwen chooses the heading, extent, and optional `watchFor` symbolic names. One path persists while observations update every 750 ms; no LLM decision is requested at each short segment. Arrival, timeout, route failure, player interruption, new watched/objective-item evidence, or changed visual scene context returns control to cognition. Survival suspends/resumes the path. `MOVE_NEAR` uses the same monitoring. A pending or active learning task blocks Presence, including the memory-loading and inference intervals.

The reproducible scheduler simulation is `node benchmark/vision/scheduler.js`. See [the regression report](docs/STAGE-4.2-REGRESSION.md) for measurements and the exact live retest.

During a learning episode, normal autonomy is suppressed and presence is denied movement. Survival can preempt it. Ordinary chat leaves the episode intact, FOLLOW/COME/STOP immediately preempt its movement, and only an explicit task-cancellation message ends it. Learning never changes the configured combat mode.

## Goal priority and lifecycle

Goal priority is `SURVIVAL (100) > PLAYER (50) > PLAYER_TASK (30) > AUTONOMOUS (10)`. Locomotion follows `SURVIVAL > PLAYER > PLAYER_TASK > AUTONOMY > PRESENCE` and permits exactly one owner at a time.

- Survival interrupts a resumable player or autonomous goal, then resumes it if it is still relevant and inside its resume window.
- A player command abandons the current autonomous goal.
- A player movement command received during survival is retained as pending and starts after the emergency clears.
- Natural wood-task requests are routed to a PLAYER_TASK episode, acknowledged immediately, and evaluated only through the `oak_log` inventory predicate.
- Normal player conversation does not cancel or mutate an active task; explicit phrases such as “别弄了” do.
- Autonomous actions are rejected while a higher-priority goal owns the body.
- An in-progress autonomous movement intention is not replaced by periodic autonomy ticks.
- Autonomous movement goals complete on `goal_reached`; timed waits complete through bounded timers.

The action registry is intentionally extensible so future stages can register `GATHER`, `MINE`, `CRAFT`, `BUILD`, `EAT`, `EQUIP`, `SLEEP`, `EXPLORE`, `FIGHT`, and `RETURN_HOME` without replacing the scheduler or goal system.

## Autonomous world state

### Short-term companion context

`src/companion/session-context.js` shares a read-only session snapshot between
conversation and autonomy. A cheap one-second position sample distinguishes player
movement from staying still without assuming remote velocity is reliable. Holding
a tool is reported separately, never interpreted as evidence of mining/building.
Current FOLLOW/COME/STOP commitments and survival interruptions come directly from
the movement controller; this layer cannot change goals, pathfinding, look, or combat.

The snapshot includes the last six conversation/proactive speech entries (up to
220 characters each), expires them after five minutes, and clears on disconnect.
It is in-memory context, not persistent learning or world memory. Conversation
requests attach only the latest snapshot rather than saving old observations in
chat history. Autonomy uses the same context and existing inference schedule.
If a conversation decision merely repeats the currently active PLAYER movement
for the same player, the agent retains the existing path instead of resetting it.
Immediate commands and survival-owned movement still use the normal command path.
Proactive speech leaves 15 seconds after recent dialogue and suppresses identical
recent companion messages even when the model supplies a different reason key;
existing speech cooldowns still apply. The context sampler adds no model calls or
movement actions. Paraphrase deduplication still depends on the model/context.

For ordinary companionship use `AUTONOMY_ENABLED=true` and `LEARNING_ENABLED=false`.
The latter disables only the automatic spawn experiment; explicit player learning
requests remain available and suspend autonomy while pending/active. Disabled
autonomy now logs that proactive conversation is disabled. Silence decisions log
their model reason; blocked speech logs conversation-gap/cooldown/topic/text reasons.

While PLAYER/PLAYER_TASK/SURVIVAL owns locomotion, autonomy's model action schema
is narrowed to SAY/IDLE and independently validated. The existing survival and
learning suppression still applies. The model can react to a new observed event
without issuing movement, or choose silence; there is no forced timed greeting.

Conversation uses temperature 0.5; speech-only autonomy also uses 0.5. Other
structured requests retain temperature 0. Empty/repeated conversation replies or
recognized reversed FOLLOW wording get at most one text-only revision (temperature
0.7, strict reply-only schema, no response retries). The original action is never
changed by this revision. If it still fails, duplicate/invalid wording is withheld
and logged, not repeatedly regenerated. Thus occasional conversation latency may
increase by one inference; movement/survival never wait for that inference. Repetition
checking retains six recent conversation replies, including short acknowledgements.
FOLLOW revisions use an explicit first-person companion subject, with an additional
check for common reversed-direction phrases. This is a narrow language guard, not
a general guarantee that every model sentence is correct.

Run `node scripts/smoke-companion-dialogue.js` for an actual configured-model check:
three “跟着我” exchanges, an ordinary preference question, and two synthetic new-rain
events during FOLLOW. It never connects to Minecraft. It checks basic role direction,
nonempty/nonidentical replies and SAY decisions, not general factual correctness or
human-like quality. Model output remains variable, and regex direction checks are
not a full semantic validator.

Live retest: restart the bot, verify `Autonomy enabled` and no automatic learning
experiment on spawn. Issue FOLLOW, exchange a few messages, then stay silent for
90–120 seconds while continuing to walk. For a reproducible new event, if you have
cheats enabled, use `/weather clear`, wait at least 60 seconds without chat, then
`/weather rain` and wait up to 60 seconds (longer if higher-priority model work is
running). Autonomy should be able to comment without interrupting FOLLOW. Check
`Autonomy chose`, `[AUTONOMY] Chose silence`, and `[SPEECH] Skipped` if it does not.
Repeat STOP/chat and combat recall checks. Unchanging surroundings may legitimately
produce silence; speech is not promised at every interval. Weather commands are
optional test-world changes, not actions performed by the bot.

Manual companion-context test (about 10 minutes):

1. Start the usual LAN session, issue FOLLOW and walk, then stop for 5–10 seconds.
   Ask what the companion is doing; check that its reply fits its current behavior
   without resetting the follow path.
2. Stand still holding a pickaxe; ask what it can tell you are doing. It should not
   claim to have observed mining just from the held tool.
3. Exchange a few messages, then remain quiet. Check that autonomous remarks do not
   immediately interrupt the exchange or repeat the same reminder.
4. Issue STOP, chat normally, and confirm it stays stopped. Then resume FOLLOW.
5. Repeat the verified combat/recall test: order an attack, call it back, and verify
   recall and subsequent following still work; low-health/creeper safety retains priority.

These checks require live validation: shared context improves grounding but does
not guarantee human-like conversation or activity understanding.

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

### Arrival companionship and nearby-bed interaction

`AUTO_ACCOMPANY_ENABLED=true` starts one default autonomous FOLLOW intention after
`AUTO_ACCOMPANY_DELAY_MS=3500`, choosing the nearest visible human within
`AUTO_ACCOMPANY_RANGE=16`. It retries unavailable ownership/player visibility for
at most 20 checks, without Ollama. Any player movement command invalidates this
arrival intention, even STOP before the delay ends. It never recreates FOLLOW on
autonomy ticks. Existing player/survival/learning ownership remains authoritative.
Disable this option to keep arrival entirely stationary/presence-driven.

Explicit `睡觉`, `你躺床上`, or `上床睡觉` requests now use Mineflayer's bed API,
not a model's completion claim. Only a known overworld dimension, sleep-permitted
night/thunderstorm, an unoccupied bed within three blocks, and no nearby hostile
allow an attempt. No bed search beyond this radius, crafting, navigation to beds,
daytime bed-click/respawn-point command, or autonomous bedtime policy is implemented.
Unknown dimensions fail closed; Nether/End beds are never deliberately activated.

Sleep takes PLAYER STOP ownership, superseding FOLLOW. Success is reported only
after the Mineflayer sleep event/state, not merely after clicking. `起床`/`别睡了`
request waking; FOLLOW/COME/STOP cancel a pending sleep and wake the companion.
Survival also wakes it without replacing the survival path. A late SDK sleep result
is invalidated by the command epoch and wakes rather than confirming success. The
SDK's in-flight interaction cannot be unsent. Rest remembers the previous behavior:
after confirmed or natural waking, previous FOLLOW resumes with its original PLAYER
or AUTONOMOUS priority, once, without recreating paths on ticks. An explicit STOP
before sleep stays stopped; a newer command cancels restoration. Survival defers
restoration until it releases control. Failed sleep also restores following. Rest
entered from idle releases only its own temporary PLAYER STOP so presence/autonomy
can run again. A missing target is retried for up to 30 seconds after waking outside
survival, then remains stopped rather than following a different player. Multiplayer night-skipping still
depends on the world's player-sleep rules and other players entering their own beds.

Wake compatibility: the installed Mineflayer bed plugin still sends legacy numeric
entity action 2. Minecraft 1.21.11 maps that value to stop_sprinting; leave_bed is 0.
The project uses the negotiated protocol's symbolic `leave_bed` mapping without
editing dependencies. Explicit `起床`/`起来` waits up to three seconds for actual
sleeping=false/wake confirmation, reports timeout honestly, and deduplicates pending
requests. FOLLOW/cancellation and survival use the same corrected packet sender.
Regression tests serialize the real installed 1.21.11 protocol, not just a fake wake.

Conversation now receives actual time/rain/sleep status. A narrow output guard
blocks known false bed/respawn completion phrases; it is not a general semantic
truth verifier. Quiet companionship after 90 seconds is offered to the existing
autonomy inference as a social opportunity, not a forced sentence. Stationary is
not interpreted as proof of resting; hurt events alone do not identify an attacker.

Manual validation: restart and give no command for 5–10 seconds, then walk away
within the configured arrival range and confirm automatic following. STOP must
remain sticky for at least 60 seconds. Next bring the bot within 2 blocks of its
own empty bed in a safe overworld area at night and say `睡觉`; check actual lying
pose, then `起床`. Repeat with daytime, no bed, occupied bed, and a new FOLLOW during
the attempt; it must report refusal/cancellation rather than imaginary success.
Do not test hazardous-dimension beds by manually clicking them. Observe quiet
companionship for 2–3 minutes; inspect SAY/IDLE diagnostics instead of assuming
silence means inference did not run. No Fabric reinstall is required.

### Greeting selection

With `SPAWN_MESSAGE` empty or unset, each bot connection randomly chooses one short
greeting from `config/spawn-greetings.json`. Edit that JSON array to customize the
pool, or set a nonempty `SPAWN_MESSAGE` for a fixed override. The greeting uses no
LLM and is recorded in shared conversation context to avoid immediately talking
over itself. It is sent once on the first spawn, not on death/respawn. Selection
has no persistent history, so separate launches can occasionally pick the same
line; randomness does not guarantee a different line every time.

### Windows double-click launcher

Double-click `start-companion.cmd` (or a desktop shortcut pointing to it). Enter
the current LAN port displayed in Minecraft chat after opening the world to LAN.
No terminal commands are needed for normal launches. Node.js, project dependencies,
Ollama, and the configured model must already be installed.

The launcher preserves `.env` and overrides `MC_PORT` only for this process. It
checks TCP connectivity, checks the configured Ollama model list, and starts
`ollama serve` hidden only if the default local `localhost:11434` service is
unavailable. Other addresses must be started manually. It never downloads models,
installs dependencies, or changes gameplay settings. Existing learning/vision
opt-ins remain in effect. Service readiness does not imply the model is warmed up.

Keep the log window open or minimized while playing. Close it or press Ctrl+C to
stop the companion; Ollama remains running and can be closed separately. Closing
the LAN world disconnects the bot. This is not a dedicated server, automatic
reconnect, or an always-on service. Launch only one companion window at a time.

Manual check: open a LAN world, launch and enter its port, verify the bot joins
and responds to FOLLOW/COME/STOP. Verify invalid ports are rejected, an incorrect
LAN port reports a connection failure, and a second session's new port works
without editing `.env`. With Ollama initially closed, verify local startup; with
it already open, verify it is reused. No Fabric reinstall is needed.

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

Player FOLLOW / COME (including `回来`) / STOP commands cancel combat pursuit and
outstanding attack orders immediately, before conversation inference. The companion
may defend against an authorized enemy already within melee reach without replacing
the player's path or facing. Chasing stays disabled until a fresh explicit attack
order or combat-mode command. Low-health escape and creeper avoidance still take
priority; the newest player movement resumes when the emergency clears. Pending
model attack/mode decisions from before the movement command are discarded.

Pursuit has independent limits: `COMBAT_MAX_PURSUIT_MS=8000`,
`COMBAT_MAX_PURSUIT_DISTANCE=6` from its starting point, and
`COMBAT_PLAYER_LEASH=8` from the companion's player. Reaching a limit restores the
prior behavior and applies `COMBAT_PURSUIT_COOLDOWN_MS=10000`. Detection radius is
not permission to pursue indefinitely. Limits apply across target changes during
one engagement.

To retest recall: restart the Node bot, order an attack against a nearby ordinary
hostile, then say `回来` while it approaches. Confirm immediate COME ownership and
no renewed chase while the hostile remains nearby. Repeat with `跟我来` and `停下`,
and with a slow pending model attack decision. Separately test low health and a
nearby creeper: retreat should still win until danger clears, then the latest
player command must resume. This fix changes Node code only; no Fabric reinstall
is required.

Ollama response configuration:

| Variable | Default | Purpose |
| --- | ---: | --- |
| `OLLAMA_TIMEOUT_MS` | `120000` | HTTP timeout for one inference attempt |
| `OLLAMA_RESPONSE_RETRIES` | `2` | Retries for empty or malformed JSON responses; no Minecraft action is charged |
| `OLLAMA_RETRY_BACKOFF_MS` | `250` | Base bounded retry delay |
| `OLLAMA_THINK` | `false` | Low-latency qwen3-vl mode; keep the default for this model/version combination |
| `OLLAMA_DEBUG` | `false` | Logs response metadata and safely truncated raw content/thinking channels |
| `OLLAMA_DEBUG_RAW_MAX_CHARS` | `2000` | Maximum characters from either raw model channel in debug logs |

All decision clients share one structured-response layer. Requests use `stream:false` plus an Ollama JSON Schema, then pass through a second strict local validator. Ollama 0.34.2 with `qwen3-vl:8b` can place a schema-constrained answer in `message.thinking` while leaving `message.content` empty when thinking is disabled. The client recognizes that compatibility case only when the alternate channel itself validates against the exact allowlist; arbitrary reasoning text is never executed.

Controlled learning configuration:

| Variable | Default | Purpose |
| --- | ---: | --- |
| `LEARNING_ENABLED` | `false` | Opt in to the Stage 4.0 oak-log experiment after spawn |
| `LEARNING_START_DELAY_MS` | `5000` | Delay before the controlled episode starts |
| `LEARNING_MAX_ACTIONS` | `20` | Maximum validated primitives in one episode |
| `LEARNING_MAX_DURATION_MS` | `180000` | Wall-clock episode budget |
| `LEARNING_REPEAT_LIMIT` | `3` | Consecutive identical failed/no-progress actions allowed |
| `LEARNING_OBSERVATION_RANGE` | `8` | Radius for bounded block/entity observations |
| `LEARNING_EXPLORE_RADIUS` | `16` | Maximum horizontal radius from the episode start for generic exploration |
| `LEARNING_MOVE_TIMEOUT_MS` | `20000` | Timeout for one primitive movement |
| `LEARNING_MEMORY_FILE` | `learning-memory/memory.json` | Local transparent memory file; the default directory is Git-ignored |

Personality persists in `config/companion-personality.json` and can be edited without changing the LLM prompts or controller code.

Visual configuration is fully listed in `.env.example`. Important defaults are `VISION_ENABLED=false`, loopback port `32145`, 2 MB / 1280×720 input bounds, a 45-second background interval, and a 30-second observation TTL. The Fabric capture defaults to 960×540 at most once per second; Qwen is not called for every captured frame.

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

### Exact Stage 4.2 live visual test

1. Build the Fabric module with Java 21 and replace the instance's old `ai-companion-client-1.0.0.jar` with the new jar from `fabric/ai-companion-client/build/libs/` while Minecraft is closed. Do not change the skin PNG.
2. In `.env`, set `VISION_ENABLED=true`, `VISION_BRIDGE_HOST=127.0.0.1`, and `VISION_DEBUG_SAVE_FRAMES=true`. Keep `OLLAMA_MODEL=qwen3-vl:8b` and `OLLAMA_THINK=false`. Optionally choose a random local `VISION_BRIDGE_TOKEN`.
3. Launch Fabric once, open `config/ai-companion-client.json`, set `visionEnabled` to `true`, and copy the same optional token to `visionToken`. Keep `visionEndpoint` as `http://127.0.0.1:32145/v1/frames`. Restart Minecraft after editing.
4. Open a disposable world to LAN, update `MC_PORT`, and run `npm start`. Confirm `[VISION] local frame bridge listening` and then `[VISION] frame received`; no external endpoint should be contacted.
5. Say `跟我来`, walk continuously, and wait for `[VISION] inference started`. Confirm AI_Companion keeps following smoothly throughout the several-second inference. Repeat near a hostile/creeper and confirm survival/combat still reacts while vision runs.
6. Confirm `[VISION] observation updated`. Inspect the newest ignored `vision-debug/*.json`: verify `frame.perspective` is `HUMAN_CLIENT_CAMERA`, the observation uses regions/confidence rather than block coordinates, and its scene matches the frame.
7. Ask `你看到前面那个东西了吗？` while pointing the human camera at a distinctive object. Confirm a fresh visual inference runs, then the reply is grounded and describes the perspective as a shared client view. Turn away or stop the Fabric bridge and repeat; the bot must say it lacks a usable new image rather than claiming sight.
8. For the learning experiment, stand where the target is outside the symbolic scan but a broad environmental clue is visible, enable learning, and start the controlled goal. Confirm Qwen may select `LOOK_VISUALLY`; that primitive updates perception without stopping movement and the following decision receives both symbolic nearby state and the broader visual hypothesis.
9. If Qwen selects `EXPLORE`, verify the chosen direction comes from cognition rather than a resource-specific JavaScript rule. After moving, verify Mineflayer's symbolic scan later confirms or rejects any relevant target; only symbolic inventory evidence may complete the objective.
10. Point the client camera at a materially different scene. After the change trigger/minimum gap, inspect the next debug JSON and confirm the prior hypothesis is replaced. Wait longer than `VISION_OBSERVATION_TTL_MS` without frames and verify a visual question refuses stale context.
11. Disable `VISION_DEBUG_SAVE_FRAMES` after testing. Debug PNG/JSON files stay under ignored `vision-debug/` and can be deleted without affecting learned memory or gameplay.

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
npm run smoke:learning
npm run reliability:learning
npm run coherence:learning
npm run benchmark:vision -- --count=3 --case=open_grassland=C:\path\frame.png
```

The smoke command sends the real learning prompt/state to the configured local model once. The reliability command repeats the same validated decision 20 times. The coherence command gives Qwen a resource-neutral synthetic state with repeated no-progress observations and verifies that it can select generic `EXPLORE`. None of these commands connects to Minecraft or executes a primitive action.

Build and test the optional Fabric client module separately:

```powershell
cd fabric\ai-companion-client
.\gradlew.bat build
```

Tests cover locomotion ownership, stale inference epochs, message routing, fast task acknowledgement, player-task priority, central Ollama scheduling/preemption, structured response classification/retries, reflection carry-forward, repeated-action discouragement, bounded exploration and novelty tracking, conversation during learning, spawn presence, autonomy scheduling, goal lifecycle, survival/combat, primitive validation, evidence-only success, episode budgets, memory persistence, skill extraction/retrieval, and confidence updates.

## Exact manual Stage 4.0 experiment

Use a disposable, flat test area and keep a backup. The model is deliberately not given a harvesting recipe, so success is not guaranteed in one episode.

1. Start Ollama and confirm `qwen3-vl:8b` is available. Open Minecraft Java 1.21.11 to LAN and update `MC_PORT` in `.env`.
2. Put `AI_Companion` on solid ground within roughly 3–6 blocks of one or more naturally placed oak logs. Remove every `oak_log` from its inventory. Keep hazards and valuable builds outside the observation area.
3. Set `COMBAT_MODE=DEFENSIVE` and `AUTONOMY_ENABLED=true`. `LEARNING_ENABLED` may remain `false`; it controls only the automatic experiment, not player-created tasks.
4. Run `npm start`, then say “帮我弄点木头” or “你试试怎么获得一个原木”. Confirm “行，我试试。” appears immediately, before planning completes, followed by a PLAYER_TASK learning episode.
5. Watch `[LEARN] Attempt N: ACTION -> EVALUATION` logs. After no progress, confirm the next cycle links `[LEARN] Previous`, `[LEARN] Lesson`, and `[LEARN] Next`. When no useful target is visible, Qwen may choose bounded `EXPLORE heading=... distance=...`; JavaScript must not choose it on Qwen's behalf.
6. Confirm `EXPLORE` stays within `LEARNING_EXPLORE_RADIUS` of the episode start, moves through existing learning/pathfinder ownership, and produces a new observation containing updated region and nearby-block history.
7. Spawn or approach a hostile during exploration. Confirm SURVIVAL takes locomotion immediately. After danger clears, exploration resumes if its time budget remains; combat must not wait for Qwen.
8. While a learning decision is pending, say “你在干嘛？”. Confirm the conversation is answered before the task's next model decision and that the episode remains active.
9. Say “跟我来” or “停下”. Confirm PLAYER locomotion takes control immediately without marking the task cancelled. Then explicitly say “别弄了” and confirm the task ends as `PLAYER_CANCELLED`.
10. Start a fresh uninterrupted task. Count inventory independently. SUCCESS is valid only after Mineflayer observes at least one `oak_log`; model text alone cannot complete the objective.
11. Stop the bot and inspect `learning-memory/memory.json`. Confirm the episode contains its request/source, observations, attempts, evaluations, outcome, duration, and—only after evaluator-confirmed success—a skill copied from the actual action sequence.
12. Restart under comparable conditions. Confirm relevant learned candidates are retrieved and inspect confidence/success/failure timestamps after reuse.

To reset only learned Stage 4 state, stop the bot and remove the local `learning-memory/` directory. It is not tracked by Git.

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
- Stage 3 goals and recent events remain runtime-only. Stage 4 learning episodes/skill candidates persist as local JSON, but this is narrow experimental strategy memory rather than general long-term memory.
- Autonomous actions do not gather, mine, craft, build, eat, equip, sleep, fight, or travel beyond the nearby player area.
- Ollama work is single-flight through a central priority queue. Conversation can still take the model's normal generation time, but it no longer waits behind a full autonomy or reflection response; lower-priority requests are aborted and retried/deferred.
- The learning model sees Mineflayer's symbolic block/entity data, not pixels. It can attempt only the configured oak-log objective, has no crafting/general task planner, and may fail due to model choices, reachability, tool requirements, drops, or the action/time budget.
- The custom skin is client-side by design. Vanilla/unmodded observers still see the offline default skin, and every observing client must install the Fabric module locally.
- The skin is cached for the Minecraft client session. Changing the PNG or identity configuration requires a Minecraft restart.

## License

This project, including the Fabric client module, is licensed under the [MIT License](LICENSE).
