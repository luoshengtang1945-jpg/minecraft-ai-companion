# Current companion checkpoint — 2026-09-25

This checkpoint builds on the stable Stage 3 architecture and documents the Stage 4 learning/perception development version. It is **not** a claim of general autonomous Minecraft competence.

## Components and working features

| Layer | Current behavior |
| --- | --- |
| Node/Mineflayer body | Joins a Java 1.21.11 LAN world, observes symbolic game state, executes validated movement and low-level actions. |
| Player conversation | Local Ollama/Qwen chat and natural commands including FOLLOW, COME, STOP, combat modes/orders, and supported rest/wake requests. Immediate movement commands take control before inference finishes. |
| Survival/combat | Real-time hostile detection outside the LLM loop; DEFENSIVE by default, optional PASSIVE/AGGRESSIVE, weapon selection, attack timing, creeper avoidance, low-health retreat, and resumption of interrupted following. |
| Autonomy/presence | Low-rate world-state decisions, bounded nearby movement, cheap non-LLM spawn/idle behavior, and occasional proactive speech with cooldown and deduplication. One authoritative locomotion owner at a time: SURVIVAL > PLAYER > PLAYER_TASK > AUTONOMY > PRESENCE. |
| Learning Agent | Opt-in bounded episodes using allowlisted primitives, observations after actions, objective evaluation, reflection, local JSON memory, and learned-skill candidates. Player requests can launch a task while the automatic experiment remains off. |
| Fabric client | Locally assigns the remote companion's configurable skin without changing the human player's skin. Optional `COMPANION_CAMERA` separately renders the loaded bot's viewpoint and sends downsampled frames to a loopback-only Node bridge. |

The Fabric client is required for the custom skin and optional camera, but not for basic Mineflayer movement, conversation, or survival. Ollama runs locally; no paid API is needed. See [README setup](../README.md#setup) and [architecture](ARCHITECTURE.md).

## What has actually been validated

- The user previously verified joining, local conversation, FOLLOW/COME/STOP, defensive survival/combat, custom skin with the human skin unaffected, nearby-bed sleep/wake, restoration of following after rest, and some proactive speech in a real 1.21.11 Fabric LAN game.
- During the 2026-09-25 controlled live test, the corrected `COMPANION_CAMERA` frame matched Minecraft's native spectator view of the bot rather than the human's view. Moving the bot produced a fresh, different visual answer; dark/rainy scenes still showed a model classification error, which the symbolic-dimension guard rejected.
- In a disposable superflat world with **one manually placed** oak-log block, a player-requested learning episode selected `DIG_BLOCK → MOVE_NEAR` and ended only when inventory acquisition was confirmed. After clearing that item, a second episode selected `MOVE_NEAR → DIG_BLOCK → MOVE_NEAR` and also succeeded. Local ignored memory recorded the episodes and updated a relevant learned candidate. This tests the learning loop, **not** independent tree search.
- FOLLOW took PLAYER locomotion after the learning episode; a later STOP took effect immediately. A learning task requested during persistent FOLLOW waited instead of stealing movement.

## Checks for this checkpoint

- `npm test`: **326/326** passing.
- `npm run check`: **125** JavaScript files parsed successfully.
- Fabric `gradlew.bat test build --offline` with Java 21: successful (tasks up to date).
- `git diff --check`: clean.

These checks describe this environment on the date above. Other clients, GPUs, worlds, and model settings are not implied to have passed.

## Important limitations

- It does not generally gather, mine, craft, build, manage a home, or survive independently like a human player. Ordinary autonomy stays near the player; autonomous item-learning is opt-in and bounded.
- Qwen may choose weak actions or produce repetitive/incorrect dialogue. Narrow factual guards withhold some unsupported claims, but they do not solve hallucination. Proactive speech is occasional, not continuous.
- The optional camera provides short-lived, approximate visual context, not a full world map or reliable object recognition. It requires the Fabric client to have the remote companion entity loaded; an open chat/menu is not used as a companion-camera frame.
- The skin is client-side. Other observers need the Fabric module to see it; unmodded clients see the offline default.
- Combat attribution is approximate because a damage event does not always identify the attacker. Movement uses bounded targets and pathfinder rather than full route-level hazard planning.
- Learning memory is a local, git-ignored JSON file. A recorded successful sequence is only a candidate strategy, not proof it will transfer to a different terrain or inventory.

## Local/private release boundary

Do not publish `.env`, personal skin PNGs, client-local configuration, Minecraft worlds, model weights, dependencies, Gradle/build output, debug frames, logs, or `learning-memory/`. The repository contains `.env.example` and documented setup instead. The root and Fabric module use the MIT License.

## Sensible next validation

Test in an ordinary survival world without a manually placed target: can the model discover useful evidence, choose safe exploration, collect a dropped item, and return to the player without losing FOLLOW/STOP responsiveness? Record the actual action/evaluation sequence and visual frame IDs. Failure should guide a small general fix, not a hardcoded resource script.
