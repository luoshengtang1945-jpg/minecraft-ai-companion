# AI Companion Client (Fabric 1.21.11)

This client-only Fabric mod renders a configured local PNG as the skin of the
remote Mineflayer profile `AI_Companion`. It does not upload the PNG, contact a
skin service, or change the Mineflayer protocol connection.

The default runtime configuration is created at:

```text
config/ai-companion-client.json
```

Its defaults are:

```json
{
  "enabled": true,
  "profileName": "AI_Companion",
  "skinPath": "config/offlineskins/AI_Companion.png",
  "model": "wide",
  "visionEnabled": false,
  "visionPerspective": "HUMAN_CLIENT_CAMERA",
  "visionEndpoint": "http://127.0.0.1:32145/v1/frames",
  "visionToken": "",
  "visionCaptureIntervalMs": 1000,
  "visionCompanionCaptureIntervalMs": 5000,
  "visionMaxWidth": 960,
  "visionMaxHeight": 540,
  "visionMaxEncodedBytes": 2000000
}
```

Relative `skinPath` values resolve from the Minecraft instance directory. Set
`model` to `slim` only if the PNG uses three-pixel-wide arms. The PNG must be a
modern 64x64 Minecraft skin.

## Local visual bridge

Stage 4.2 extends this same client-only module with an optional native Minecraft
framebuffer capture. It never takes desktop screenshots and never writes normal
captures to disk. The capture is downscaled, PNG-encoded, and sent by local HTTP
POST to the Node agent. The endpoint is rejected unless it resolves to loopback.
The bridge keeps at most one capture/encode in flight and reconnects naturally
on the next capture after the Node process restarts.

Camera pose, dimension, and UI state are snapshotted on the render thread before
asynchronous encoding. `X-AI-Companion-UI-State` is `GAMEPLAY`, `MENU`, `CHAT`,
`INVENTORY`, or `OTHER_SCREEN`; Node skips all non-gameplay frames without an
Ollama call. Updating this jar is required for the UI metadata protocol.

`visionPerspective` selects the source. The default `HUMAN_CLIENT_CAMERA` is the
human client's displayed view. `COMPANION_CAMERA` renders a second, first-person
world view from the loaded remote `profileName` player entity into a separate
framebuffer. It does not replace the human's displayed camera or create another
Minecraft login. The off-screen render has no HUD/hand. Node records the exact
perspective in the world model and conversation prompt.

For the companion camera, set `visionPerspective` to `COMPANION_CAMERA` and
restart Minecraft. The bot must be within the human client's loaded entity and
chunk distance; if it is not loaded, no companion frame is sent. The default
`visionCompanionCaptureIntervalMs` is 5000 because this mode performs an extra
world render on the Minecraft render thread. You can return to the shared view
by setting `visionPerspective` to `HUMAN_CLIENT_CAMERA` and restarting. This
1.21.11 render path needs live validation on each client/GPU combination.

To enable it, set `visionEnabled` to `true`. Match `visionEndpoint` to
`VISION_BRIDGE_HOST` / `VISION_BRIDGE_PORT` in the Node `.env`. If a
`VISION_BRIDGE_TOKEN` is configured, copy the same value to `visionToken`.

Build with Java 21 and Gradle:

```powershell
gradle build
```

Install `build/libs/ai-companion-client-1.0.0.jar` in the Fabric instance's
`mods` directory. Fabric API is not required by this mod.

### Companion camera live check

1. Stop Minecraft. Install the new jar, then set `visionPerspective` to
   `COMPANION_CAMERA` and `visionEnabled` to `true` in the instance's
   `config/ai-companion-client.json`. Keep the Node `.env` `VISION_ENABLED=true`.
2. Start a 1.21.11 Fabric LAN world and join AI_Companion. Keep the bot within
   loaded entity distance and check the client log for
   `using explicit COMPANION_CAMERA perspective`.
3. For inspection only, set `VISION_DEBUG_SAVE_FRAMES=true` in Node `.env`.
   Restart the bot and inspect the newest ignored `vision-debug/*.png` and its
   matching JSON. The JSON must say `COMPANION_CAMERA`; the PNG must match the
   bot's position and facing, not the player's view.
4. Face a different direction from the bot, point the player's camera at an
   unmistakably different object, and ask `你看到前面有什么？`. Compare the reply
   with the bot-camera PNG. Move near the bot and repeat after it turns.
5. Walk beyond the human client's loaded entity distance. The bridge must log
   that the remote player is unavailable rather than relabel a player frame as
   the bot's view. Check FOLLOW, STOP, combat, FPS and visual reply latency.
6. Turn off `VISION_DEBUG_SAVE_FRAMES` after testing. If the extra render
   causes stutter, increase `visionCompanionCaptureIntervalMs` or switch back
   to `HUMAN_CLIENT_CAMERA` and restart Minecraft.
