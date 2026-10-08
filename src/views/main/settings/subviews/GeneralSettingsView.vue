<script setup lang="ts">
import { useAuthStore } from '@/stores/auth/stores/authStore';

const authStore = useAuthStore();
</script>

<template>
  <div class="h-full overflow-y-auto">
    <div class="mx-auto max-w-2xl px-8 py-8 space-y-8">
      <header>
        <h2 class="text-lg font-semibold tracking-tight">通用设置</h2>
        <p class="mt-1 text-sm text-muted-foreground">当前登录用户身份、基础应用行为与快捷偏好</p>
      </header>

      <!-- 账户信息面板 -->
      <section class="space-y-3">
        <span class="text-sm font-medium">当前登录账户</span>
        <div class="p-4 rounded-xl border border-border bg-card flex items-center justify-between">
          <div class="flex items-center gap-3">
            <span class="size-11 rounded-full bg-brand-soft text-brand text-sm font-semibold flex items-center justify-center">
              {{ authStore.user?.initials ?? '?' }}
            </span>
            <div>
              <div class="text-sm font-medium">{{ authStore.user?.name ?? '尚未登录' }}</div>
              <p class="text-xs text-muted-foreground">{{ authStore.user?.email ?? '请先完成账户验证' }}</p>
            </div>
          </div>
          <button
            type="button"
            class="token-control-height px-3 rounded-lg border border-border text-xs font-medium hover:bg-muted transition-colors"
            @click="authStore.openModal('login')"
          >
            切换账号
          </button>
        </div>
      </section>

      <!-- 快捷键提示 -->
      <section class="space-y-3">
        <span class="text-sm font-medium">全局按键约定</span>
        <div class="rounded-xl border border-border bg-card divide-y divide-border overflow-hidden text-xs">
          <div class="flex items-center justify-between px-4 py-3">
            <span>发送消息</span>
            <kbd class="px-2 py-0.5 rounded bg-muted border border-border font-mono">Enter</kbd>
          </div>
          <div class="flex items-center justify-between px-4 py-3">
            <span>消息框内换行</span>
            <kbd class="px-2 py-0.5 rounded bg-muted border border-border font-mono">Shift + Enter</kbd>
          </div>
          <div class="flex items-center justify-between px-4 py-3">
            <span>侧边栏收起 / 展开</span>
            <span class="text-muted-foreground">底部面板图标</span>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>
