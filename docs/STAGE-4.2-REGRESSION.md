# Stage 4.2 performance regression fix

The background scheduler discarded results whenever the latest frame ID changed.
At one capture per second and five seconds per inference, this predictably
discarded useful work. Discard also skipped the success timestamp, enabling
immediate retries. Capture had no UI metadata, so pause screens were processed.
The grayscale signature treated even one intensity level of noise as a fully
changed pixel; it now measures normalized mean absolute luminance difference.

Learning EXPLORE previously ended at a maximum eight-block destination and
required fresh model reasoning for every next fragment. MOVE_NEAR was already
durable; it now shares evidence monitoring. Auto-started learning decisions used
AUTONOMY model priority, allowing background vision to preempt them; all controlled
learning decisions now use PLAYER_TASK_DECISION. Presence already blocked active
learning leases, but pending tasks had a gap before memory loading/lease acquisition.
The pending reservation now closes that gap and cancels any existing Presence walk.

## Repeatable simulation

Run `node benchmark/vision/scheduler.js`. This is virtual time using the production
visual and central model schedulers, not a claim of a new real GPU benchmark.
Model latency is fixed at 5,000 ms, based on the measured live latency. Frames
arrive every 100 ms for 60 seconds (601 arrivals, including endpoints).

| Measure | Original frame-ID discard rule | Revised scheduler |
| --- | ---: | ---: |
| Background inference starts | 13 | 2 |
| Accepted completed observations | 0 | 1 |
| Discarded stale observations | 12 | 0 |
| Preempted by conversation | Not modelled in original baseline | 1 |
| Maximum pending frames | 1 | 1 |
| Maximum queued background jobs | Not measured | 0 |

The original baseline reproduces only its discard/restart rule; the revised
simulation additionally injects conversation, task reasoning, and reflection.
All three start with zero simulated queue wait. Separate regression tests also
force task decisions and reflection to preempt a running background visual job.
The useful completed revised observation is accepted (1/1), and the second
request is deliberately aborted for player priority. Estimated visual execution
is 7 seconds versus roughly 60 seconds under the old retry rule.

## Intention contract

`EXPLORE {heading, distance, watchFor?}` uses distance as total extent (2–32),
not a segment length. The existing episode radius still constrains destinations.
The body executes one path with no intermediate reasoning. Every 750 ms the
observer updates symbolic state and episode novelty. New names from Qwen's
`watchFor` or the exact objective item trigger `SYMBOLIC_DISCOVERY`; inventory
completion, arrival, route failure, timeout, and player interruption also return
evidence. Changed visual scene type triggers reassessment, not a declaration
that the previous hypothesis was false. Survival preserves and resumes the path.
Symbolic discovery counts as partial progress only when the final observation
confirms the emitted evidence; it never declares objective success.

JavaScript does not translate an item into a biome, recipe, or search strategy.
Qwen can still choose a short extent, so short movements remain possible by
model choice. A longer path is not an unlimited exploration permission, and its
destination remains subject to endpoint hazard checks and pathfinder reachability.

## Exact Minecraft retest

1. Exit Minecraft. Run `npm run check`, `npm test`, and Java-21 Fabric
   `./gradlew.bat test build`. Replace the instance's existing
   `mods/ai-companion-client-1.0.0.jar` with `fabric/ai-companion-client/build/libs/ai-companion-client-1.0.0.jar`.
   Keep the existing skin PNG and identity settings.
2. Keep `OLLAMA_MODEL=qwen3-vl:8b`, `OLLAMA_THINK=false`, and both Node/Fabric
   vision enabled. Set `VISION_BACKGROUND_COOLDOWN_MS=30000`; keep the
   45-second background interval and the existing episode radius. Update the LAN port.
3. Launch the world and bot. Walk and turn the camera for 60 seconds. In each
   `[VISION] metrics` line, check pendingFrames <= 1 and that useful completed
   inferences increment observationsAccepted. New frame arrivals alone must not
   generate a repeated stale-discard/restart sequence. Cooldown follows completion.
4. Open Escape/pause for at least 15 seconds, then inventory and chat. Verify
   no new background world inference starts for these frames. An already running
   inference may finish/discard once, followed by cooldown. Close the screen,
   allow the next gameplay capture, and ask `那边是什么？`; the explicit request
   should run even during background cooldown. A request while a screen is still
   open reports unavailable world context instead of analyzing the UI.
5. Issue `跟我来` and trigger visual inference while walking. FOLLOW must continue.
   Send ordinary chat during background inference and confirm preemption serves
   conversation. Controlled task reasoning and reflection also outrank background vision.
6. Start a player learning task in a disposable clear area with room to move.
   During acknowledgement, memory loading, reasoning, movement, and paused tasks,
   confirm no `NONE -> PRESENCE (WANDER)` occurs. Presence may resume after the
   episode ends or is cancelled.
7. When Qwen selects EXPLORE with an extent above eight blocks, observe that the
   same path continues beyond four/eight blocks without another model decision.
   Watch for `[LEARN] Intention ... ended: REASON` only at an actual termination
   event. A short model-selected extent is still honored.
8. Bring a model-watched or exact objective item/block into the symbolic scan.
   Expect `SYMBOLIC_DISCOVERY` and replanning with evidence. Do not require the
   observer to map resources to recipes. Obstruct a route and verify `NO_PATH`
   or the movement timeout ends the intention cleanly for Qwen to reassess.
9. During an intention, allow background visual inference. Verify movement
   continues. If a newly accepted visual scene changes materially, expect
   `VISUAL_CONTEXT_CHANGED` to return for reassessment; it is not symbolic proof.
10. Introduce nearby danger, then remove it: survival must take ownership and
    resume the existing intention afterward. Issue FOLLOW or STOP during movement
    and during survival: PLAYER must win, and intention cleanup must not clear
    FOLLOW or replace STOP. Cancel the learning task explicitly when finished.

Live Minecraft validation and GPU inference were not rerun for this scheduler
fix; the benchmark above is reproducible simulated timing plus integration tests.
