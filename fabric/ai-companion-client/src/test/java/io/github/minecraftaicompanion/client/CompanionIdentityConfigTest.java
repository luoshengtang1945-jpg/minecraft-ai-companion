package io.github.minecraftaicompanion.client;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class CompanionIdentityConfigTest {
    @Test
    void defaultsMatchTheMineflayerIdentityAndExistingSkinLocation() {
        CompanionIdentityConfig config = new CompanionIdentityConfig();
        config.applyDefaultsAndValidate();

        assertTrue(config.matchesProfile("AI_Companion"));
        assertTrue(config.matchesProfile("ai_companion"));
        assertEquals("config/offlineskins/AI_Companion.png", config.skinPath);
        assertEquals("wide", config.model);
        assertFalse(config.visionEnabled);
        assertEquals("http://127.0.0.1:32145/v1/frames", config.visionEndpoint);
    }

    @Test
    void invalidOrBlankValuesFallBackSafely() {
        CompanionIdentityConfig config = new CompanionIdentityConfig();
        config.profileName = " ";
        config.skinPath = null;
        config.model = "unknown";
        config.applyDefaultsAndValidate();

        assertEquals("AI_Companion", config.profileName);
        assertEquals("config/offlineskins/AI_Companion.png", config.skinPath);
        assertEquals("wide", config.model);
    }

    @Test
    void disabledConfigurationNeverMatchesAProfile() {
        CompanionIdentityConfig config = new CompanionIdentityConfig();
        config.enabled = false;
        config.applyDefaultsAndValidate();

        assertFalse(config.matchesProfile("AI_Companion"));
    }
}
