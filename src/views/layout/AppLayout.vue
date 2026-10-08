<script setup lang="ts">
import { useAppStore } from '@/stores/app/stores/appStore';
import AppSidebar from './AppSidebar.vue';
import ChatsView from '@/views/main/chats/ChatsView.vue';
import ArchivePlaceholderView from '@/views/main/archive/ArchivePlaceholderView.vue';
import SettingsView from '@/views/main/settings/SettingsView.vue';
import AuthModal from '@/views/auth/AuthModal.vue';

const appStore = useAppStore();
</script>

<template>
  <div class="h-screen min-h-0 w-screen flex bg-background text-foreground antialiased pt-[var(--safe-top)] pb-[var(--safe-bottom)] overflow-hidden">
    <AppSidebar />

    <!-- 内容面板：铺满高度的白色工作区 -->
    <div class="flex-1 min-w-0 min-h-0 flex my-3 mr-3 rounded-2xl border border-border bg-card shadow-sm overflow-hidden">
      <ChatsView v-if="appStore.activeTab === 'chats'" />
      <ArchivePlaceholderView v-else-if="appStore.activeTab === 'archive'" />
      <SettingsView v-else-if="appStore.activeTab === 'settings'" />
    </div>

    <AuthModal />
  </div>
</template>
