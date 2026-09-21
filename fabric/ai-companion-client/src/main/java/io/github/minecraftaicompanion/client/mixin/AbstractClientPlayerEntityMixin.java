package io.github.minecraftaicompanion.client.mixin;

import io.github.minecraftaicompanion.client.AiCompanionClient;
import net.minecraft.client.network.AbstractClientPlayerEntity;
import net.minecraft.entity.player.SkinTextures;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

@Mixin(AbstractClientPlayerEntity.class)
abstract class AbstractClientPlayerEntityMixin {
    @Inject(method = "getSkin", at = @At("HEAD"), cancellable = true)
    private void aiCompanionClient$useConfiguredRemoteSkin(
        CallbackInfoReturnable<SkinTextures> callback
    ) {
        AbstractClientPlayerEntity player = (AbstractClientPlayerEntity) (Object) this;
        SkinTextures override = AiCompanionClient.getSkinOverride(player);
        if (override != null) {
            callback.setReturnValue(override);
        }
    }
}
