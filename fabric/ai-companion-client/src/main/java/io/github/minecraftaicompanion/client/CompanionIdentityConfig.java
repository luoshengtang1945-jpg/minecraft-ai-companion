package io.github.minecraftaicompanion.client;

import java.util.Locale;

public final class CompanionIdentityConfig {
    public static final String DEFAULT_PROFILE_NAME = "AI_Companion";
    public static final String DEFAULT_SKIN_PATH = "config/offlineskins/AI_Companion.png";

    public boolean enabled = true;
    public String profileName = DEFAULT_PROFILE_NAME;
    public String skinPath = DEFAULT_SKIN_PATH;
    public String model = "wide";

    public void applyDefaultsAndValidate() {
        profileName = normalizeOrDefault(profileName, DEFAULT_PROFILE_NAME);
        skinPath = normalizeOrDefault(skinPath, DEFAULT_SKIN_PATH);
        model = normalizeOrDefault(model, "wide").toLowerCase(Locale.ROOT);

        if (!model.equals("wide") && !model.equals("slim")) {
            model = "wide";
        }
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
