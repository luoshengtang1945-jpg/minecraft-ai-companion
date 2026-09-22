package io.github.minecraftaicompanion.client;

import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.client.network.AbstractClientPlayerEntity;
import net.minecraft.entity.player.SkinTextures;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public final class AiCompanionClient implements ClientModInitializer {
    public static final String MOD_ID = "ai_companion_client";
    private static final Logger LOGGER = LoggerFactory.getLogger(MOD_ID);

    private static LocalCompanionSkin companionSkin;
    private static LocalVisionBridge visionBridge;

    @Override
    public void onInitializeClient() {
        FabricLoader loader = FabricLoader.getInstance();
        CompanionIdentityConfig config = CompanionConfigLoader.load(loader.getConfigDir(), LOGGER);
        companionSkin = new LocalCompanionSkin(loader.getGameDir(), config, LOGGER);
        visionBridge = new LocalVisionBridge(config, LOGGER);
        LOGGER.info(
            "AI Companion client integration enabled for remote profile {}",
            config.profileName
        );
    }

    public static void onFrameRendered(net.minecraft.client.MinecraftClient client) {
        if (visionBridge != null) {
            visionBridge.onFrameRendered(client);
        }
    }

    public static SkinTextures getSkinOverride(AbstractClientPlayerEntity player) {
        return companionSkin == null ? null : companionSkin.getOverride(player);
    }
}
