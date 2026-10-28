<script setup lang="ts">
import AuthFormShell from './components/AuthFormShell.vue';
import AuthWallpaperPanel from './components/AuthWallpaperPanel.vue';
</script>

<template>
  <!--
    左右分栏：左图右表单，中间一道发丝分界线。
    - >=1024px：横向分栏，图片面板占 54%；
    - <1024px：纵向堆叠，图片收成图带，表单占余下空间并可独立滚动；
    - 矮屏（横屏手机 / 窄窗口）：图带压到 88px 只保留品牌氛围，避免把表单挤到折叠线以下。
  -->
  <div class="flex h-dvh w-full flex-col overflow-hidden bg-card lg:flex-row">
    <AuthWallpaperPanel
      class="h-[26dvh] min-h-[140px] w-full shrink-0 [@media(max-height:560px)]:h-[64px] [@media(max-height:560px)]:min-h-0 lg:h-auto lg:min-h-0 lg:w-[54%]"
    />

    <!-- 分界线：桌面为竖线，窄屏自动转为横线 -->
    <div class="relative shrink-0 bg-border max-lg:h-px max-lg:w-full lg:h-full lg:w-px">
      <!-- 品牌高光段，避免分界线沦为一条死板的灰线 -->
      <span
        class="pointer-events-none absolute inset-0 bg-gradient-to-r from-transparent via-brand/45 to-transparent lg:bg-gradient-to-b"
      />
    </div>

    <AuthFormShell class="min-h-0 flex-1">
      <Transition name="auth-page" mode="out-in">
        <RouterView />
      </Transition>
    </AuthFormShell>
  </div>
</template>

<style scoped>
/* 登录 ↔ 注册切换：轻微上浮淡入，与壁纸轮替的节奏区分开 */
.auth-page-enter-active,
.auth-page-leave-active {
  transition: opacity 220ms ease, transform 220ms cubic-bezier(0.16, 1, 0.3, 1);
}
.auth-page-enter-from { opacity: 0; transform: translateY(10px); }
.auth-page-leave-to { opacity: 0; transform: translateY(-8px); }

@media (prefers-reduced-motion: reduce) {
  .auth-page-enter-active,
  .auth-page-leave-active { transition-duration: 1ms; }
}
</style>