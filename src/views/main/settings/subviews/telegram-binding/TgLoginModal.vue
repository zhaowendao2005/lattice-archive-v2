<script setup lang="ts">
import { useTelegramStore } from '@/stores/telegram/stores/telegramStore';

const store = useTelegramStore();

function submit() {
  const value = store.loginStage === 'phone' ? store.phoneInput
    : store.loginStage === 'code' ? store.codeInput
      : store.passwordInput;
  store.submitLoginValue(value);
}
</script>

<template>
  <div v-if="store.loginStage !== 'idle'" class="fixed inset-0 z-50 grid place-items-center bg-background/70 p-4 backdrop-blur-sm">
    <section class="w-full max-w-md rounded-xl border border-border bg-card p-6 shadow-xl">
      <div class="flex items-center justify-between">
        <h3 class="font-semibold">添加 Telegram 账户</h3>
        <button type="button" class="text-muted-foreground hover:text-foreground" @click="store.closeLogin">关闭</button>
      </div>

      <div class="mt-6 space-y-4">
        <!-- 二维码由 local worker 本地编码后以 data URL 传入，不经过任何第三方服务 -->
        <div v-if="store.loginStage === 'qr'" class="space-y-3 text-center">
          <img
            v-if="store.qrImage"
            :src="store.qrImage"
            alt="Telegram 登录二维码"
            class="mx-auto size-56 rounded-lg bg-white p-2"
          >
          <p v-else class="py-16 text-sm text-muted-foreground">正在生成二维码…</p>
          <p class="text-sm text-muted-foreground">使用 Telegram 手机端扫描二维码，过期后会自动刷新。</p>
          <button type="button" class="text-xs text-muted-foreground underline" @click="store.switchToPhoneLogin()">改用手机号登录</button>
        </div>

        <div v-else-if="store.loginStage === 'phone' || store.loginStage === 'code' || store.loginStage === 'password'" class="space-y-3">
          <p class="text-sm text-muted-foreground">
            {{ store.loginStage === 'phone' ? '输入 Telegram 手机号（含国家码）' : store.loginStage === 'code' ? '输入 Telegram 验证码' : '输入两步验证密码' }}
          </p>
          <input
            v-if="store.loginStage === 'phone'"
            :value="store.phoneInput"
            inputmode="tel"
            class="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
            placeholder="+8613800138000"
            @input="store.setPhoneInput(($event.target as HTMLInputElement).value)"
          >
          <input
            v-else-if="store.loginStage === 'code'"
            :value="store.codeInput"
            inputmode="numeric"
            class="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
            @input="store.setCodeInput(($event.target as HTMLInputElement).value)"
          >
          <input
            v-else
            :value="store.passwordInput"
            type="password"
            class="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
            @input="store.setPasswordInput(($event.target as HTMLInputElement).value)"
          >
          <button type="button" class="token-control-height w-full rounded-lg bg-primary text-sm text-primary-foreground hover:opacity-90" @click="submit">继续</button>
          <button type="button" class="w-full text-xs text-muted-foreground underline" @click="store.switchToQrLogin()">返回二维码登录</button>
        </div>

        <div v-else class="rounded-lg bg-muted/60 p-4 text-center text-sm text-muted-foreground">登录成功，正在同步账户绑定信息…</div>
      </div>
    </section>
  </div>
</template>
