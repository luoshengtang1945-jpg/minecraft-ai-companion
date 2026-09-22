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
  "visionEndpoint": "http://127.0.0.1:32145/v1/frames",
  "visionToken": "",
  "visionCaptureIntervalMs": 1000,
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

This first foundation deliberately labels every frame `HUMAN_CLIENT_CAMERA`.
It is the human client's rendered view, **not** AI_Companion's own first-person
camera. Node preserves that distinction in the world model and conversation
prompt. A future off-screen companion camera can use the same protocol with a
different perspective value.

To enable it, set `visionEnabled` to `true`. Match `visionEndpoint` to
`VISION_BRIDGE_HOST` / `VISION_BRIDGE_PORT` in the Node `.env`. If a
`VISION_BRIDGE_TOKEN` is configured, copy the same value to `visionToken`.

Build with Java 21 and Gradle:

```powershell
gradle build
```

Install `build/libs/ai-companion-client-1.0.0.jar` in the Fabric instance's
`mods` directory. Fabric API is not required by this mod.
