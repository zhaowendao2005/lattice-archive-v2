<script setup lang="ts">
defineProps<{
  /** 顶部角标文案，用于区分用户端与管理员端 */
  badge?: string;
}>();
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col bg-card">
    <!-- 品牌区 -->
    <header class="flex shrink-0 items-center justify-between gap-4 px-6 pt-5 sm:px-10 lg:px-14 lg:pt-7 [@media(max-height:560px)]:pt-3">
      <RouterLink :to="{ name: 'auth-login' }" class="group flex items-center gap-2.5 outline-none">
        <span class="flex size-9 items-center justify-center rounded-xl bg-primary text-base font-semibold text-primary-foreground transition-colors duration-200 group-hover:bg-brand">
          L
        </span>
        <span class="text-base font-semibold tracking-tight text-foreground">
          Lattice<span class="text-brand">.</span>Archive
        </span>
      </RouterLink>

      <span class="rounded-full bg-muted px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
        {{ badge ?? 'Workspace v2.0' }}
      </span>
    </header>

    <!--
      表单正文。用 auto 外边距而非 justify-center 实现"有余量才居中"：
      justify-center 在内容高于容器时会把顶部推出滚动区、无法回滚，auto 外边距则会归零。
    -->
    <div class="min-h-0 flex-1 overflow-y-auto px-6 sm:px-10 lg:px-14">
      <div class="mx-auto flex min-h-full w-full max-w-sm flex-col py-6 lg:py-8">
        <div class="my-auto w-full">
          <slot />
        </div>
      </div>
    </div>

    <!-- 页脚：矮屏（横屏手机）下隐藏，把垂直空间留给表单 -->
    <footer class="flex shrink-0 items-center justify-between gap-4 border-t border-border px-6 py-4 text-[11px] text-muted-foreground sm:px-10 lg:px-14 [@media(max-height:560px)]:hidden">
      <span>© 2026 Lattice Archive</span>
      <span class="flex gap-4">
        <button type="button" class="cursor-pointer transition-colors duration-200 hover:text-foreground">隐私政策</button>
        <button type="button" class="cursor-pointer transition-colors duration-200 hover:text-foreground">服务条款</button>
      </span>
    </footer>
  </div>
</template>