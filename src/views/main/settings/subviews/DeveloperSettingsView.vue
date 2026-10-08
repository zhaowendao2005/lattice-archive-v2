<script setup lang="ts">
import { useAppStore } from '@/stores/app/stores/appStore';

const appStore = useAppStore();
</script>

<template>
  <div class="h-full overflow-y-auto">
    <div class="mx-auto max-w-2xl px-8 py-8 space-y-8">
      <header>
        <h2 class="text-lg font-semibold tracking-tight">开发者选项</h2>
        <p class="mt-1 text-sm text-muted-foreground">运行时调试参数、底层引擎状态与系统构架信息</p>
      </header>

      <section class="space-y-3">
        <span class="text-sm font-medium">调试与高级功能</span>
        <div class="rounded-xl border border-border bg-card divide-y divide-border overflow-hidden">
          <div class="flex items-center justify-between gap-6 px-4 py-3.5">
            <div>
              <div class="text-sm font-medium">开发者模式</div>
              <p class="mt-0.5 text-xs text-muted-foreground">启用深层事件钩子与底层交互日志</p>
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

          <dl v-if="appStore.developerMode" class="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 bg-muted/60 px-4 py-3.5 font-mono text-xs">
            <dt class="text-muted-foreground">STATUS</dt>
            <dd class="text-brand font-semibold">DEVELOPER HOOKS ACTIVE</dd>
            <dt class="text-muted-foreground">BUILD</dt>
            <dd>v2.0.0-alpha</dd>
            <dt class="text-muted-foreground">DESIGN TOKEN</dt>
            <dd>Swiss Tech Blue (Modern Rounded)</dd>
            <dt class="text-muted-foreground">STORAGE</dt>
            <dd>SQLite Local Engine (Better-SQLite3)</dd>
          </dl>
        </div>
      </section>
    </div>
  </div>
</template>
