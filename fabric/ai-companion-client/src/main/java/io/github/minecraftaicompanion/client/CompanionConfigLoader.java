package io.github.minecraftaicompanion.client;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import org.slf4j.Logger;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

final class CompanionConfigLoader {
    static final String CONFIG_FILENAME = "ai-companion-client.json";
    private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();

    private CompanionConfigLoader() {
    }

    static CompanionIdentityConfig load(Path configDirectory, Logger logger) {
        Path configPath = configDirectory.resolve(CONFIG_FILENAME);
        CompanionIdentityConfig config = new CompanionIdentityConfig();

        try {
            Files.createDirectories(configDirectory);
            if (Files.notExists(configPath)) {
                config.applyDefaultsAndValidate();
                Files.writeString(
                    configPath,
                    GSON.toJson(config) + System.lineSeparator(),
                    StandardCharsets.UTF_8
                );
                logger.info("Created AI Companion client config at {}", configPath);
                return config;
            }

            CompanionIdentityConfig loaded = GSON.fromJson(
                Files.readString(configPath, StandardCharsets.UTF_8),
                CompanionIdentityConfig.class
            );
            if (loaded != null) {
                config = loaded;
            }
        } catch (IOException | RuntimeException error) {
            logger.error("Could not read {}; using safe defaults", configPath, error);
        }

        config.applyDefaultsAndValidate();
        return config;
    }
}
