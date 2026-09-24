package io.github.minecraftaicompanion.client;

import java.util.Locale;

public final class CompanionIdentityConfig {
    public static final String DEFAULT_PROFILE_NAME = "AI_Companion";
    public static final String DEFAULT_SKIN_PATH = "config/offlineskins/AI_Companion.png";

    public boolean enabled = true;
    public String profileName = DEFAULT_PROFILE_NAME;
    public String skinPath = DEFAULT_SKIN_PATH;
    public String model = "wide";
    public boolean visionEnabled = false;
    public String visionPerspective = "HUMAN_CLIENT_CAMERA";
    public String visionEndpoint = "http://127.0.0.1:32145/v1/frames";
    public String visionToken = "";
    public int visionCaptureIntervalMs = 1000;
    public int visionCompanionCaptureIntervalMs = 5000;
    public int visionMaxWidth = 960;
    public int visionMaxHeight = 540;
    public int visionMaxEncodedBytes = 2_000_000;

    public void applyDefaultsAndValidate() {
        profileName = normalizeOrDefault(profileName, DEFAULT_PROFILE_NAME);
        skinPath = normalizeOrDefault(skinPath, DEFAULT_SKIN_PATH);
        model = normalizeOrDefault(model, "wide").toLowerCase(Locale.ROOT);
        visionEndpoint = normalizeOrDefault(visionEndpoint, "http://127.0.0.1:32145/v1/frames");
        visionPerspective = normalizeOrDefault(visionPerspective, "HUMAN_CLIENT_CAMERA").toUpperCase(Locale.ROOT);
        if (!visionPerspective.equals("HUMAN_CLIENT_CAMERA") && !visionPerspective.equals("COMPANION_CAMERA")) {
            visionPerspective = "HUMAN_CLIENT_CAMERA";
        }
        visionToken = visionToken == null ? "" : visionToken.trim();
        visionCaptureIntervalMs = clamp(visionCaptureIntervalMs, 500, 60_000, 1000);
        visionCompanionCaptureIntervalMs = clamp(visionCompanionCaptureIntervalMs, 2000, 60_000, 5000);
        visionMaxWidth = clamp(visionMaxWidth, 160, 1920, 960);
        visionMaxHeight = clamp(visionMaxHeight, 90, 1080, 540);
        visionMaxEncodedBytes = clamp(visionMaxEncodedBytes, 65_536, 8_000_000, 2_000_000);

        if (!model.equals("wide") && !model.equals("slim")) {
            model = "wide";
        }
    }

    private static int clamp(int value, int minimum, int maximum, int fallback) {
        return value < minimum || value > maximum ? fallback : value;
    }

    public boolean matchesProfile(String name) {
        return enabled && name != null && profileName.equalsIgnoreCase(name);
    }

    private static String normalizeOrDefault(String value, String fallback) {
        if (value == null || value.isBlank()) {
            return fallback;
        }
        return value.trim();
    }
}
