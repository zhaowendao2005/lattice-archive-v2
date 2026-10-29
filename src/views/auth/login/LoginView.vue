<script setup lang="ts">
import { useRouter } from 'vue-router';
import { ArrowRight, Eye, EyeOff, ShieldCheck } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAuthStore } from '@/stores/auth/stores/authStore';
import TurnstileWidget from '@/views/auth/components/TurnstileWidget.vue';

const authStore = useAuthStore();
const router = useRouter();

async function handleSubmit() {
  if (!authStore.emailInput.trim() || !authStore.passwordInput) {
    authStore.setAuthError('请输入邮箱和密码');
    document.getElementById(authStore.emailInput.trim() ? 'login-password' : 'login-email')?.focus();
    return;
  }
  if (!authStore.turnstileToken) { authStore.setAuthError('请先完成人机安全验证'); return; }
  if (await authStore.submitLogin()) await router.push({ name: 'chats' });
}
</script>

<template>
  <div>
    <header class="mb-6 lg:mb-7 [@media(max-height:560px)]:mb-3">
      <h1 class="text-2xl font-semibold leading-tight tracking-tight text-foreground sm:text-[28px]">欢迎回来</h1>
      <p class="mt-2 text-sm leading-relaxed text-muted-foreground [@media(max-height:560px)]:hidden">
        请输入账户凭证，继续你的归档工作区。
      </p>
    </header>

    <form class="space-y-3.5 lg:space-y-4 [@media(max-height:560px)]:space-y-3" @submit.prevent="handleSubmit">
      <div>
        <label for="login-email" class="mb-1.5 block text-xs font-medium text-foreground">邮箱</label>
        <Input
          id="login-email"
          :model-value="authStore.emailInput"
          type="text"
          autocomplete="username"
          placeholder="name@company.com"
          class="h-11 rounded-xl border-input bg-muted/50 px-3.5 focus-visible:bg-card"
          @update:model-value="authStore.setEmailInput($event as string)"
        />
      </div>

      <div>
        <div class="mb-1.5 flex items-center justify-between">
          <label for="login-password" class="text-xs font-medium text-foreground">密码</label>
          <span class="text-xs text-muted-foreground">忘记密码请联系管理员</span>
        </div>
        <div class="relative">
          <Input
            id="login-password"
            :model-value="authStore.passwordInput"
            :type="authStore.isUserPasswordVisible ? 'text' : 'password'"
            autocomplete="current-password"
            placeholder="请输入你的密码"
            class="h-11 rounded-xl border-input bg-muted/50 px-3.5 pr-11 focus-visible:bg-card"
            @update:model-value="authStore.setPasswordInput($event as string)"
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

      <label class="flex cursor-pointer select-none items-center gap-2 pt-0.5">
        <input
          type="checkbox"
          :checked="authStore.keepSignedIn"
          class="size-4 cursor-pointer rounded border-input accent-brand"
          @change="authStore.setKeepSignedIn(($event.target as HTMLInputElement).checked)"
        />
        <span class="text-xs text-muted-foreground">30 天内保持登录状态</span>
      </label>

      <div v-if="authStore.authError" role="alert" class="rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive">{{ authStore.authError }}</div>
      <TurnstileWidget action="login" />
      <Button
        type="submit"
        size="lg"
        class="mt-1 h-11 w-full rounded-xl text-sm shadow-sm"
      >
        进入工作区
        <span v-if="authStore.isSubmitting" class="sr-only">正在验证</span>
        <ArrowRight class="size-4" :stroke-width="2" />
      </Button>
    </form>

    <!-- 次级入口：管理员凭证独立，与普通用户会话互不通用 -->
    <div class="mt-5 flex items-center gap-3 lg:mt-6">
      <span class="h-px flex-1 bg-border" />
      <span class="text-[11px] tracking-wider text-muted-foreground">或</span>
      <span class="h-px flex-1 bg-border" />
    </div>

    <RouterLink
      :to="{ name: 'admin-login' }"
      class="mt-3.5 flex h-11 w-full items-center justify-center gap-2 rounded-xl border border-border text-sm font-medium text-muted-foreground transition-colors duration-200 hover:border-brand/40 hover:bg-accent/50 hover:text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring lg:mt-4"
    >
      <ShieldCheck class="size-4" :stroke-width="1.75" />
      使用管理员凭证登录
    </RouterLink>

    <p class="mt-5 text-center text-xs text-muted-foreground lg:mt-7">
      还没有账号？
      <RouterLink
        :to="{ name: 'auth-register' }"
        class="font-semibold text-foreground underline underline-offset-4 transition-colors duration-200 hover:text-brand"
      >
        注册新账号
      </RouterLink>
    </p>
  </div>
</template>