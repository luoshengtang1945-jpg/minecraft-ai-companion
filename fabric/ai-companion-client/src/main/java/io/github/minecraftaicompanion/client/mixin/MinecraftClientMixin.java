package io.github.minecraftaicompanion.client.mixin;

import io.github.minecraftaicompanion.client.AiCompanionClient;
import net.minecraft.client.MinecraftClient;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(MinecraftClient.class)
abstract class MinecraftClientMixin {
    @Inject(method = "render", at = @At("RETURN"))
    private void aiCompanion$afterRender(boolean tick, CallbackInfo callbackInfo) {
        AiCompanionClient.onFrameRendered((MinecraftClient)(Object)this);
    }
}
