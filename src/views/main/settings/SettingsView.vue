<script setup lang="ts">
import SettingsNav from './nav/SettingsNav.vue';
</script>

<template>
  <main class="flex-1 min-w-0 flex overflow-hidden">
    <!-- 设置内侧子栏导航 -->
    <SettingsNav />

    <!-- 设置子页面内容容器 (一子页一独立 Vue 组件) -->
    <section class="flex-1 min-w-0 flex flex-col bg-card overflow-hidden">
      <RouterView v-slot="{ Component }">
        <KeepAlive :max="5">
          <component :is="Component" />
        </KeepAlive>
      </RouterView>
    </section>
  </main>
</template>
