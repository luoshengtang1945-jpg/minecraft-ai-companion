package io.github.minecraftaicompanion.client;

import com.google.gson.Gson;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.texture.NativeImage;
import net.minecraft.client.util.ScreenshotRecorder;
import net.minecraft.entity.Entity;
import net.minecraft.client.gui.screen.ChatScreen;
import net.minecraft.client.gui.screen.GameMenuScreen;
import net.minecraft.client.gui.screen.ingame.HandledScreen;
import org.slf4j.Logger;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.net.InetAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.HexFormat;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

final class LocalVisionBridge {
    static final String PERSPECTIVE = "HUMAN_CLIENT_CAMERA";
    private static final Gson GSON = new Gson();

    private final CompanionIdentityConfig config;
    private final Logger logger;
    private final URI endpoint;
    private final HttpClient http;
    private final ExecutorService encoder;
    private final AtomicBoolean capturePending = new AtomicBoolean(false);
    private volatile long lastCaptureAt;
    private volatile long lastConnectionWarningAt;

    LocalVisionBridge(CompanionIdentityConfig config, Logger logger) {
        this.config = config;
        this.logger = logger;
        this.endpoint = config.visionEnabled
            ? validateEndpoint(config.visionEndpoint)
            : URI.create("http://127.0.0.1:32145/v1/frames");
        this.encoder = Executors.newSingleThreadExecutor(task -> {
            Thread thread = new Thread(task, "ai-companion-vision-bridge");
            thread.setDaemon(true);
            return thread;
        });
        this.http = HttpClient.newBuilder()
            .executor(encoder)
            .connectTimeout(Duration.ofSeconds(2))
            .build();
        if (config.visionEnabled) {
            logger.info("AI Companion visual bridge enabled at {} using explicit {} perspective", endpoint, PERSPECTIVE);
        }
    }

    void onFrameRendered(MinecraftClient client) {
        if (!config.visionEnabled || client.world == null || client.player == null || capturePending.get()) return;
        long now = System.currentTimeMillis();
        if (now - lastCaptureAt < config.visionCaptureIntervalMs) return;
        if (!capturePending.compareAndSet(false, true)) return;
        lastCaptureAt = now;
        try {
            // Snapshot on the render thread, before asynchronous readback/encoding.
            Entity camera = client.getCameraEntity();
            Map<String, Double> pose = camera == null ? Map.of() : Map.of(
                "x", camera.getX(), "y", camera.getY(), "z", camera.getZ(),
                "yaw", (double)camera.getYaw(), "pitch", (double)camera.getPitch()
            );
            String uiState = client.currentScreen == null ? "GAMEPLAY"
                : client.currentScreen instanceof ChatScreen ? "CHAT"
                : client.currentScreen instanceof GameMenuScreen ? "MENU"
                : client.currentScreen instanceof HandledScreen<?> ? "INVENTORY" : "OTHER_SCREEN";
            FrameContext context = new FrameContext(GSON.toJson(pose), client.world.getRegistryKey().getValue().toString(), uiState);
            int factor = downscaleFactor(client.getFramebuffer().textureWidth, client.getFramebuffer().textureHeight);
            ScreenshotRecorder.takeScreenshot(client.getFramebuffer(), factor, image -> encoder.execute(() -> encodeAndSend(context, image, now)));
        } catch (RuntimeException error) {
            capturePending.set(false);
            warnThrottled("Could not capture Minecraft framebuffer", error);
        }
    }

    private record FrameContext(String camera, String dimension, String uiState) {}

    private void encodeAndSend(FrameContext context, NativeImage image, long capturedAt) {
        boolean handedToTransport = false;
        try (image) {
            double scale = Math.min(1.0, Math.min((double)config.visionMaxWidth / image.getWidth(), (double)config.visionMaxHeight / image.getHeight()));
            int targetWidth = Math.max(1, (int)Math.floor(image.getWidth() * scale));
            int targetHeight = Math.max(1, (int)Math.floor(image.getHeight() * scale));
            BufferedImage buffered = new BufferedImage(targetWidth, targetHeight, BufferedImage.TYPE_INT_ARGB);
            for (int y = 0; y < targetHeight; y++) {
                for (int x = 0; x < targetWidth; x++) {
                    int sourceX = Math.min(image.getWidth() - 1, x * image.getWidth() / targetWidth);
                    int sourceY = Math.min(image.getHeight() - 1, y * image.getHeight() / targetHeight);
                    buffered.setRGB(x, y, image.getColorArgb(sourceX, sourceY));
                }
            }
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            ImageIO.write(buffered, "png", output);
            byte[] png = output.toByteArray();
            if (png.length > config.visionMaxEncodedBytes) {
                warnThrottled("Visual frame exceeded configured encoded-size bound", null);
                return;
            }
            send(context, buffered, png, capturedAt).whenComplete((ignored, error) -> capturePending.set(false));
            handedToTransport = true;
        } catch (Exception error) {
            warnThrottled("Could not encode visual frame", error);
        } finally {
            if (!handedToTransport) capturePending.set(false);
        }
    }

    private java.util.concurrent.CompletableFuture<Void> send(FrameContext context, BufferedImage image, byte[] png, long capturedAt) {
        HttpRequest.Builder request = HttpRequest.newBuilder(endpoint)
            .timeout(Duration.ofSeconds(5))
            .header("Content-Type", "image/png")
            .header("X-AI-Companion-Frame-Id", UUID.randomUUID().toString())
            .header("X-AI-Companion-Captured-At", Long.toString(capturedAt))
            .header("X-AI-Companion-Perspective", PERSPECTIVE)
            .header("X-AI-Companion-Signature", signature(image))
            .header("X-AI-Companion-Camera", context.camera())
            .header("X-AI-Companion-Dimension", context.dimension())
            .header("X-AI-Companion-UI-State", context.uiState())
            .POST(HttpRequest.BodyPublishers.ofByteArray(png));
        if (!config.visionToken.isBlank()) request.header("X-AI-Companion-Token", config.visionToken);
        return http.sendAsync(request.build(), HttpResponse.BodyHandlers.discarding())
            .handle((response, error) -> {
                if (error != null) {
                    warnThrottled("Visual bridge is unavailable", error);
                    return null;
                }
                if (response.statusCode() >= 400) warnThrottled("Visual bridge rejected a frame with HTTP " + response.statusCode(), null);
                return null;
            });
    }

    private int downscaleFactor(int width, int height) {
        for (int factor = 1; factor <= 8; factor++) {
            if (width % factor == 0 && height % factor == 0 && width / factor <= config.visionMaxWidth && height / factor <= config.visionMaxHeight) return factor;
        }
        return 1;
    }

    private String signature(BufferedImage image) {
        byte[] values = new byte[16 * 9];
        for (int row = 0; row < 9; row++) {
            for (int column = 0; column < 16; column++) {
                int rgb = image.getRGB(Math.min(image.getWidth() - 1, column * image.getWidth() / 16), Math.min(image.getHeight() - 1, row * image.getHeight() / 9));
                values[row * 16 + column] = (byte)((((rgb >> 16) & 255) * 30 + ((rgb >> 8) & 255) * 59 + (rgb & 255) * 11) / 100);
            }
        }
        return HexFormat.of().formatHex(values);
    }

    private void warnThrottled(String message, Throwable error) {
        long now = System.currentTimeMillis();
        if (now - lastConnectionWarningAt < 30_000) return;
        lastConnectionWarningAt = now;
        if (error == null) logger.warn(message); else logger.warn(message, error);
    }

    private static URI validateEndpoint(String value) {
        URI uri = URI.create(value);
        if (!"http".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null || !isLoopback(uri.getHost()) || !"/v1/frames".equals(uri.getPath())) {
            throw new IllegalArgumentException("visionEndpoint must be an http:// loopback URL ending in /v1/frames");
        }
        return uri;
    }

    private static boolean isLoopback(String host) {
        try {
            return InetAddress.getByName(host).isLoopbackAddress();
        } catch (Exception ignored) {
            return false;
        }
    }
}
