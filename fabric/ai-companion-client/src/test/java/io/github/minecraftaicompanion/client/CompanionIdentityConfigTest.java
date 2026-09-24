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
        assertEquals("HUMAN_CLIENT_CAMERA", config.visionPerspective);
        assertEquals(5000, config.visionCompanionCaptureIntervalMs);
        assertEquals("http://127.0.0.1:32145/v1/frames", config.visionEndpoint);
    }

    @Test
    void invalidOrBlankValuesFallBackSafely() {
        CompanionIdentityConfig config = new CompanionIdentityConfig();
        config.profileName = " ";
        config.skinPath = null;
        config.model = "unknown";
        config.visionPerspective = "unsupported";
        config.visionCompanionCaptureIntervalMs = 1;
        config.applyDefaultsAndValidate();

        assertEquals("AI_Companion", config.profileName);
        assertEquals("config/offlineskins/AI_Companion.png", config.skinPath);
        assertEquals("wide", config.model);
        assertEquals("HUMAN_CLIENT_CAMERA", config.visionPerspective);
        assertEquals(5000, config.visionCompanionCaptureIntervalMs);
    }

    @Test
    void companionCameraCanBeSelectedWithoutChangingTheProfileOrSkin() {
        CompanionIdentityConfig config = new CompanionIdentityConfig();
        config.visionPerspective = "companion_camera";
        config.visionCompanionCaptureIntervalMs = 3000;
        config.applyDefaultsAndValidate();

        assertEquals("COMPANION_CAMERA", config.visionPerspective);
        assertEquals(3000, config.visionCompanionCaptureIntervalMs);
        assertTrue(config.matchesProfile("AI_Companion"));
    }

    @Test
    void disabledConfigurationNeverMatchesAProfile() {
        CompanionIdentityConfig config = new CompanionIdentityConfig();
        config.enabled = false;
        config.applyDefaultsAndValidate();

        assertFalse(config.matchesProfile("AI_Companion"));
    }
}
