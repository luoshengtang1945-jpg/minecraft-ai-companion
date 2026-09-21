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
  "model": "wide"
}
```

Relative `skinPath` values resolve from the Minecraft instance directory. Set
`model` to `slim` only if the PNG uses three-pixel-wide arms. The PNG must be a
modern 64x64 Minecraft skin.

Build with Java 21 and Gradle:

```powershell
gradle build
```

Install `build/libs/ai-companion-client-1.0.0.jar` in the Fabric instance's
`mods` directory. Fabric API is not required by this mod.
