<script setup lang="ts">
import { onMounted } from 'vue';
import AppCredentialsCard from './AppCredentialsCard.vue';
import BoundAccountsList from './BoundAccountsList.vue';
import TgLoginModal from './TgLoginModal.vue';
import { useTelegramStore } from '@/stores/telegram/stores/telegramStore';

const telegramStore = useTelegramStore();
onMounted(() => { void telegramStore.refreshBindingView(); });
</script>

<template>
  <div class="h-full overflow-y-auto">
    <div class="mx-auto max-w-3xl px-8 py-8 space-y-8">
      <header>
        <h2 class="text-lg font-semibold tracking-tight">账户与绑定</h2>
        <p class="mt-1 text-sm text-muted-foreground">配置 Telegram 应用凭据，并管理每台设备的独立授权。</p>
      </header>
      <p v-if="telegramStore.error" class="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">{{ telegramStore.error }}</p>
      <AppCredentialsCard />
      <BoundAccountsList />
    </div>
  </div>
  <TgLoginModal />
</template>
