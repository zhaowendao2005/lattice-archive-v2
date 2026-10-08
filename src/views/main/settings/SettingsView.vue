<script setup lang="ts">
import { useAppStore } from '@/stores/app/stores/appStore';
import SettingsNav from './nav/SettingsNav.vue';
import PlatformSettingsView from './subviews/PlatformSettingsView.vue';
import AppearanceSettingsView from './subviews/AppearanceSettingsView.vue';
import GeneralSettingsView from './subviews/GeneralSettingsView.vue';
import DeveloperSettingsView from './subviews/DeveloperSettingsView.vue';
import StorageSettingsView from './subviews/StorageSettingsView.vue';

const appStore = useAppStore();
</script>

<template>
  <main class="flex-1 min-w-0 flex overflow-hidden">
    <!-- 设置内侧子栏导航 -->
    <SettingsNav />

    <!-- 设置子页面内容容器 (一子页一独立 Vue 组件) -->
    <section class="flex-1 min-w-0 flex flex-col bg-card overflow-hidden">
      <PlatformSettingsView v-if="appStore.activeSettingsTab === 'platform'" />
      <AppearanceSettingsView v-else-if="appStore.activeSettingsTab === 'appearance'" />
      <GeneralSettingsView v-else-if="appStore.activeSettingsTab === 'general'" />
      <DeveloperSettingsView v-else-if="appStore.activeSettingsTab === 'developer'" />
      <StorageSettingsView v-else-if="appStore.activeSettingsTab === 'storage'" />
    </section>
  </main>
</template>
