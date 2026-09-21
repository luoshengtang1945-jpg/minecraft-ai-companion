package io.github.minecraftaicompanion.client;

import net.minecraft.client.MinecraftClient;
import net.minecraft.client.network.AbstractClientPlayerEntity;
import net.minecraft.client.texture.NativeImage;
import net.minecraft.client.texture.NativeImageBackedTexture;
import net.minecraft.entity.player.PlayerSkinType;
import net.minecraft.entity.player.SkinTextures;
import net.minecraft.util.AssetInfo;
import net.minecraft.util.Identifier;
import org.slf4j.Logger;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;

final class LocalCompanionSkin {
    private static final Identifier TEXTURE_ID = Identifier.of(
        AiCompanionClient.MOD_ID,
        "skins/ai_companion"
    );

    private final Path gameDirectory;
    private final CompanionIdentityConfig config;
    private final Logger logger;

    private SkinTextures cachedSkin;
    private boolean loadAttempted;

    LocalCompanionSkin(Path gameDirectory, CompanionIdentityConfig config, Logger logger) {
        this.gameDirectory = gameDirectory.toAbsolutePath().normalize();
        this.config = config;
        this.logger = logger;
    }

    SkinTextures getOverride(AbstractClientPlayerEntity renderedPlayer) {
        if (!config.matchesProfile(renderedPlayer.getGameProfile().name())) {
            return null;
        }

        MinecraftClient client = MinecraftClient.getInstance();
        if (client.player == renderedPlayer) {
            return null;
        }

        return loadOnce(client);
    }

    private synchronized SkinTextures loadOnce(MinecraftClient client) {
        if (cachedSkin != null || loadAttempted) {
            return cachedSkin;
        }
        loadAttempted = true;

        Path configuredPath = Path.of(config.skinPath);
        Path skinPath = configuredPath.isAbsolute()
            ? configuredPath.normalize()
            : gameDirectory.resolve(configuredPath).normalize();

        if (!Files.isRegularFile(skinPath)) {
            logger.error("AI Companion skin file does not exist: {}", skinPath);
            return null;
        }

        try (InputStream input = Files.newInputStream(skinPath)) {
            NativeImage image = NativeImage.read(input);
            if (image.getWidth() != 64 || image.getHeight() != 64) {
                int width = image.getWidth();
                int height = image.getHeight();
                image.close();
                logger.error(
                    "AI Companion skin must be a modern 64x64 PNG, but {} is {}x{}",
                    skinPath,
                    width,
                    height
                );
                return null;
            }

            NativeImageBackedTexture texture = new NativeImageBackedTexture(
                () -> "AI Companion local skin",
                image
            );
            client.getTextureManager().registerTexture(TEXTURE_ID, texture);

            PlayerSkinType model = config.model.equals("slim")
                ? PlayerSkinType.SLIM
                : PlayerSkinType.WIDE;
            AssetInfo.TextureAsset body = new AssetInfo.TextureAssetInfo(TEXTURE_ID, TEXTURE_ID);
            cachedSkin = new SkinTextures(body, null, null, model, false);
            logger.info(
                "Using local skin {} for remote profile {} ({})",
                skinPath,
                config.profileName,
                config.model
            );
            return cachedSkin;
        } catch (IOException | RuntimeException error) {
            logger.error("Could not load AI Companion skin from {}", skinPath, error);
            return null;
        }
    }
}
