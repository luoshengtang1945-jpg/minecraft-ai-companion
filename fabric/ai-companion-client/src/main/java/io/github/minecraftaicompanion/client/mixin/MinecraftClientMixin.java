package io.github.minecraftaicompanion.client.mixin;

import io.github.minecraftaicompanion.client.AiCompanionClient;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.gl.Framebuffer;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

@Mixin(MinecraftClient.class)
abstract class MinecraftClientMixin {
    @Inject(method = "render", at = @At("RETURN"))
    private void aiCompanion$afterRender(boolean tick, CallbackInfo callbackInfo) {
        AiCompanionClient.onFrameRendered((MinecraftClient)(Object)this);
    }

    @Inject(method = "getFramebuffer", at = @At("HEAD"), cancellable = true)
    private void aiCompanion$offscreenFramebuffer(CallbackInfoReturnable<Framebuffer> callbackInfo) {
        Framebuffer framebuffer = AiCompanionClient.getVisionFramebufferOverride();
        if (framebuffer != null) callbackInfo.setReturnValue(framebuffer);
    }
}
