<script setup lang="ts">
import { useRouter } from 'vue-router';
import { ArrowRight, Eye, EyeOff } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAuthStore } from '@/stores/auth/stores/authStore';

const authStore = useAuthStore();
const router = useRouter();

function handleSubmit() {
  if (authStore.canSubmitRegister) {
    authStore.registerAndLogin();
    router.push({ name: 'chats' });
    return;
  }
  const missing = !authStore.registerName.trim()
    ? 'reg-name'
    : !authStore.registerEmail.trim()
      ? 'reg-email'
      : 'reg-password';
  document.getElementById(missing)?.focus();
}
</script>

<template>
  <div>
    <header class="mb-6 lg:mb-7 [@media(max-height:560px)]:mb-3">
      <h1 class="text-2xl font-semibold leading-tight tracking-tight text-foreground sm:text-[28px]">创建账号</h1>
      <p class="mt-2 text-sm leading-relaxed text-muted-foreground [@media(max-height:560px)]:hidden">
        注册一个本地账户，数据将保存在你自己的设备上。
      </p>
    </header>

    <form class="space-y-3.5 lg:space-y-4 [@media(max-height:560px)]:space-y-3" @submit.prevent="handleSubmit">
      <div>
        <label for="reg-name" class="mb-1.5 block text-xs font-medium text-foreground">用户名</label>
        <Input
          id="reg-name"
          :model-value="authStore.registerName"
          type="text"
          autocomplete="name"
          placeholder="例如：Elena"
          class="h-11 rounded-xl border-input bg-muted/50 px-3.5 focus-visible:bg-card"
          @update:model-value="authStore.setRegisterName($event as string)"
        />
      </div>

      <div>
        <label for="reg-email" class="mb-1.5 block text-xs font-medium text-foreground">邮箱</label>
        <Input
          id="reg-email"
          :model-value="authStore.registerEmail"
          type="email"
          autocomplete="email"
          placeholder="name@company.com"
          class="h-11 rounded-xl border-input bg-muted/50 px-3.5 focus-visible:bg-card"
          @update:model-value="authStore.setRegisterEmail($event as string)"
        />
      </div>

      <div>
        <div class="mb-1.5 flex items-center justify-between">
          <label for="reg-password" class="text-xs font-medium text-foreground">设置密码</label>
          <span class="text-xs text-muted-foreground">至少 8 位</span>
        </div>
        <div class="relative">
          <Input
            id="reg-password"
            :model-value="authStore.registerPassword"
            :type="authStore.isUserPasswordVisible ? 'text' : 'password'"
            autocomplete="new-password"
            placeholder="包含数字与字母"
            class="h-11 rounded-xl border-input bg-muted/50 px-3.5 pr-11 focus-visible:bg-card"
            @update:model-value="authStore.setRegisterPassword($event as string)"
          />
          <button
            type="button"
            class="absolute right-1 top-1/2 flex size-9 -translate-y-1/2 cursor-pointer items-center justify-center rounded-lg text-muted-foreground transition-colors duration-200 hover:text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
            :aria-label="authStore.isUserPasswordVisible ? '隐藏密码' : '显示密码'"
            @click="authStore.toggleUserPasswordVisible()"
          >
            <EyeOff v-if="authStore.isUserPasswordVisible" class="size-4" :stroke-width="1.75" />
            <Eye v-else class="size-4" :stroke-width="1.75" />
          </button>
        </div>
      </div>

      <Button
        type="submit"
        size="lg"
        class="mt-1 h-11 w-full rounded-xl text-sm shadow-sm"
      >
        创建账号并进入
        <ArrowRight class="size-4" :stroke-width="2" />
      </Button>
    </form>

    <p class="mt-5 text-center text-xs text-muted-foreground lg:mt-8">
      已有账号？
      <RouterLink
        :to="{ name: 'auth-login' }"
        class="font-semibold text-foreground underline underline-offset-4 transition-colors duration-200 hover:text-brand"
      >
        直接登录
      </RouterLink>
    </p>
  </div>
</template>