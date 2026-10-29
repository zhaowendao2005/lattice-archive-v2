<script setup lang="ts">
import { useRouter } from 'vue-router';
import { ArrowRight, Eye, EyeOff } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAuthStore } from '@/stores/auth/stores/authStore';
import AuthFormShell from '@/views/auth/components/AuthFormShell.vue';
import AuthWallpaperPanel from '@/views/auth/components/AuthWallpaperPanel.vue';
import TurnstileWidget from '@/views/auth/components/TurnstileWidget.vue';



const authStore = useAuthStore();
const router = useRouter();

async function handleSubmit() {
  if (!authStore.adminEmailInput.trim() || !authStore.adminPasswordInput) {
    authStore.setAuthError('请输入管理员账号和密码');
    document.getElementById(authStore.adminEmailInput.trim() ? 'admin-password' : 'admin-email')?.focus();
    return;
  }
  if (!authStore.turnstileToken) { authStore.setAuthError('请先完成人机安全验证'); return; }
  if (await authStore.submitAdminLogin()) await router.push({ name: 'admin-users' });
}
</script>

<template>
  <!-- 与用户端同一套分栏骨架，保证两个入口的视觉与动效完全一致 -->
  <div class="flex h-dvh w-full flex-col overflow-hidden bg-card lg:flex-row">
    <AuthWallpaperPanel
      class="h-[26dvh] min-h-[140px] w-full shrink-0 [@media(max-height:560px)]:h-[64px] [@media(max-height:560px)]:min-h-0 lg:h-auto lg:min-h-0 lg:w-[54%]"
    />

    <div class="relative shrink-0 bg-border max-lg:h-px max-lg:w-full lg:h-full lg:w-px">
      <span class="pointer-events-none absolute inset-0 bg-gradient-to-r from-transparent via-brand/45 to-transparent lg:bg-gradient-to-b" />
    </div>

    <AuthFormShell badge="Admin Console">
      <div>
        <header class="mb-6 lg:mb-7 [@media(max-height:560px)]:mb-3">
          <h1 class="text-2xl font-semibold leading-tight tracking-tight text-foreground sm:text-[28px]">管理员登录</h1>
          <p class="mt-2 text-sm leading-relaxed text-muted-foreground [@media(max-height:560px)]:hidden">
            此入口使用独立凭证，与普通用户会话互不通用。
          </p>
        </header>

        <form class="space-y-3.5 lg:space-y-4 [@media(max-height:560px)]:space-y-3" @submit.prevent="handleSubmit">
          <div>
            <label for="admin-email" class="mb-1.5 block text-xs font-medium text-foreground">管理员账号</label>
            <Input
              id="admin-email"
              :model-value="authStore.adminEmailInput"
              type="text"
              autocomplete="username"
              placeholder="operator@lattice.dev"
              class="h-11 rounded-xl border-input bg-muted/50 px-3.5 focus-visible:bg-card"
              @update:model-value="authStore.setAdminEmailInput($event as string)"
            />
          </div>

          <div>
            <label for="admin-password" class="mb-1.5 block text-xs font-medium text-foreground">管理员密码</label>
            <div class="relative">
              <Input
                id="admin-password"
                :model-value="authStore.adminPasswordInput"
                :type="authStore.isAdminPasswordVisible ? 'text' : 'password'"
                autocomplete="current-password"
                placeholder="至少 8 位"
                class="h-11 rounded-xl border-input bg-muted/50 px-3.5 pr-11 focus-visible:bg-card"
                @update:model-value="authStore.setAdminPasswordInput($event as string)"
              />
              <button
                type="button"
                class="absolute right-1 top-1/2 flex size-9 -translate-y-1/2 cursor-pointer items-center justify-center rounded-lg text-muted-foreground transition-colors duration-200 hover:text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                :aria-label="authStore.isAdminPasswordVisible ? '隐藏密码' : '显示密码'"
                @click="authStore.toggleAdminPasswordVisible()"
              >
                <EyeOff v-if="authStore.isAdminPasswordVisible" class="size-4" :stroke-width="1.75" />
                <Eye v-else class="size-4" :stroke-width="1.75" />
              </button>
            </div>
          </div>

          <div v-if="authStore.authError" role="alert" class="rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive">{{ authStore.authError }}</div>
          <TurnstileWidget action="admin_login" />
          <Button
            type="submit"
            size="lg"
            class="mt-1 h-11 w-full rounded-xl text-sm shadow-sm"
          >
            进入控制台
            <ArrowRight class="size-4" :stroke-width="2" />
          </Button>
        </form>

        <p class="mt-5 text-center text-xs text-muted-foreground lg:mt-8">
          不是管理员？
          <RouterLink
            :to="{ name: 'auth-login' }"
            class="font-semibold text-foreground underline underline-offset-4 transition-colors duration-200 hover:text-brand"
          >
            返回用户登录
          </RouterLink>
        </p>
      </div>
    </AuthFormShell>
  </div>
</template>