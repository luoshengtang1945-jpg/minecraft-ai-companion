# Companion checkpoint — 2026-09-22

Branch: `feature/learning-agent`. This checkpoint includes the accumulated Stage 4
learning infrastructure, Stage 4.2 perception foundation, and companion-continuity
fixes. It does not replace the stable Stage 3 checkpoint on the main branch.

## User-verified in Minecraft Java 1.21.11

- Joining the LAN world, local Ollama conversation, and separate companion skin.
- Arrival companionship and player FOLLOW / COME / STOP behavior.
- Survival/combat and recall behavior from the preceding live validation rounds.
- Random join greetings and the presence of proactive speech.
- Actual sleep in a nearby bed and waking through the corrected 1.21.11 packet.
- Resuming prior following after rest, while preserving an explicit player STOP.
- The user reported all requested rest-continuity tests passing before release.

These observations are user-reported live validation, not a claim that every
Minecraft situation or every model response is correct.

## Automated release checks

- `npm test`: 205 tests passing.
- `npm run check`: 108 JavaScript files parsed successfully.
- Fabric `gradlew.bat test build`: successful (cached tasks up to date).
- `git diff --check`: clean.
- Root and Fabric module remain MIT licensed.

Local-model smoke checks are available under `scripts/`; schema success and
occasional successful dialogue do not establish general conversational reliability.
Benchmark inputs/results, private gameplay frames and learning memories stay local.

## Scope and limitations

Learning remains an experimental bounded primitive-action loop, not a generally
competent Minecraft player. Vision is optional human-client shared framebuffer
context, not a bot-controlled first-person camera. Rest only uses nearby safe
overworld beds; it does not build/find beds or independently manage a bedtime.
Dialogue can still contain repetitive wording, inaccurate claims or weak contextual
judgment. The narrow action-claim guards do not solve general hallucination.

`.env`, personal skin PNGs, client-local configuration, model weights, dependencies,
Gradle/build output, screenshots, logs and learning memory are not release content.
The Gradle wrapper JAR is an intentional build-tool dependency, not mod build output.

## Next increment

1. Ground speech in observed facts and actual action outcomes; make unknowns explicit.
2. Evaluate shared-activity understanding from observable events rather than held
   tools alone. Do not infer an activity or intention without supporting evidence.
3. Improve continuity and timing of conversation while retaining silent companionship.

Keep each increment small, preserve validated locomotion/rest/combat invariants,
and repeat live acceptance before the next checkpoint. Do not add broad scripted
resource-solving behavior merely to make demonstrations appear more capable.
