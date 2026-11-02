<script setup lang="ts">
import { watch } from 'vue';
import { useAppStore } from '@/stores/app/stores/appStore';
import { useDebugLoggerStore } from '@/stores/app/stores/debugLoggerStore';
import { useAuthStore } from '@/stores/auth/stores/authStore';
import AgentKeyManagerPanel from './developer/AgentKeyManagerPanel.vue';
import CloudDebugSnapshotPanel from './developer/CloudDebugSnapshotPanel.vue';
import DebugTerminalPanel from './developer/DebugTerminalPanel.vue';

const appStore = useAppStore();
const authStore = useAuthStore();
const debugLogger = useDebugLoggerStore();
debugLogger.initialize();
debugLogger.initializeCloudPanel();

// 设置页被 KeepAlive 缓存时，切换账号仍需重新绑定云端开关与快照列表。
watch(
  () => authStore.user?.id,
  () => debugLogger.initializeCloudPanel(),
);
</script>

<template>
  <div class="h-full overflow-y-auto">
    <div class="mx-auto max-w-4xl px-8 py-8 space-y-8">
      <header>
        <h2 class="text-lg font-semibold tracking-tight text-foreground">开发者选项与运行日志中心</h2>
        <p class="mt-1 text-sm text-muted-foreground">
          三端结构化时间轴终端、云端日志快照记录管理、按快照删除与 Agent 渐进式查询凭证
        </p>
      </header>

      <section class="space-y-3">
        <span class="text-sm font-medium text-foreground">调试模式总开关</span>
        <div class="rounded-xl border border-border bg-card divide-y divide-border overflow-hidden">
          <div class="flex items-center justify-between gap-6 px-4 py-3.5">
            <div>
              <div class="text-sm font-medium text-foreground">开发者模式</div>
              <p class="mt-0.5 text-xs text-muted-foreground">启用深层事件钩子、底层 MTProto 网关追踪与远端顺风车耗时采集</p>
            </div>
            <button
              type="button"
              role="switch"
              aria-label="开发者模式"
              :aria-checked="appStore.developerMode"
              :class="[
                'relative h-6 w-10 shrink-0 rounded-full transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/40',
                appStore.developerMode ? 'bg-brand' : 'bg-input'
              ]"
              @click="appStore.toggleDeveloperMode()"
            >
              <span
                :class="[
                  'absolute left-0.5 top-0.5 size-5 rounded-full bg-white shadow-sm transition-transform duration-150',
                  appStore.developerMode ? 'translate-x-4' : 'translate-x-0'
                ]"
              />
            </button>
          </div>
        </div>
      </section>

      <!-- 云端日志快照记录管理 -->
      <CloudDebugSnapshotPanel />

      <!-- 三端无圆角日志终端 + 时间轴视口拖拽器 -->
      <DebugTerminalPanel />

      <!-- Agent 访问密钥与生命周期管理 -->
      <AgentKeyManagerPanel />
    </div>
  </div>
</template>
