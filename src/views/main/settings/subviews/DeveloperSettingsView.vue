<script setup lang="ts">
import { watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAppStore } from '@/stores/app/stores/appStore';
import DeveloperSubNav from './developer/nav/DeveloperSubNav.vue';

const appStore = useAppStore();
const route = useRoute();
const router = useRouter();

// 关闭开发者模式时，运行监控页不可再停留，回到日志页。
watch(
  () => appStore.developerMode,
  (enabled) => {
    if (!enabled && route.name === 'settings-developer-telegram') void router.replace({ name: 'settings-developer-logs' });
  },
);
</script>

<template>
  <div class="h-full flex min-h-0 overflow-hidden">
    <DeveloperSubNav />
    <div class="flex-1 min-w-0 min-h-0">
      <RouterView v-slot="{ Component }">
        <KeepAlive :max="2">
          <component :is="Component" />
        </KeepAlive>
      </RouterView>
    </div>
  </div>
</template>
