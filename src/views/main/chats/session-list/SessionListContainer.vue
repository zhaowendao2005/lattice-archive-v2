<script setup lang="ts">
import { Archive, ArrowLeft, ArrowLeftToLine } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import { useChatStore } from '@/stores/chat/stores/chatStore';
import SessionSearch from './SessionSearch.vue';
import SessionItem from './SessionItem.vue';
import SessionListState from './SessionListState.vue';

const chatStore = useChatStore();

function handleScroll(event: Event) {
  const target = event.currentTarget as HTMLElement;
  chatStore.handleSessionListScroll(target.scrollTop, target.scrollHeight, target.clientHeight);
}
</script>

<template>
  <section
    :inert="chatStore.isSessionListCollapsed"
    :aria-hidden="chatStore.isSessionListCollapsed"
    :class="[
      'absolute inset-y-0 left-0 z-20 md:static md:z-auto min-h-0 min-w-0 max-w-full shrink-0 overflow-hidden transition-[width] duration-300 ease-in-out motion-reduce:transition-none',
      chatStore.isSessionListCollapsed ? 'w-0' : 'w-80 shadow-xl md:shadow-none'
    ]"
  >
    <div class="h-full min-h-0 w-80 max-w-full flex flex-col border-r border-border bg-card">
      <div class="shrink-0 px-4 pt-4 pb-3 space-y-3">
        <div class="flex items-center justify-between gap-2">
          <div class="flex min-w-0 items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              class="size-8 shrink-0 text-muted-foreground"
              aria-label="收起会话列表"
              title="收起会话列表"
              @click="chatStore.toggleSessionList()"
            >
              <ArrowLeftToLine :stroke-width="1.75" />
            </Button>
            <Button
              v-if="chatStore.isArchiveView"
              variant="ghost"
              size="icon"
              class="size-8 shrink-0 text-muted-foreground"
              aria-label="返回会话列表"
              title="返回会话列表"
              @click="chatStore.closeArchiveFolder()"
            >
              <ArrowLeft :stroke-width="1.75" />
            </Button>
            <h1 class="truncate text-base font-semibold tracking-tight">{{ chatStore.isArchiveView ? '已归档会话' : '会话' }}</h1>
          </div>
          <span class="shrink-0 text-xs text-muted-foreground tabular-nums" title="已加载 / 会话总数">
            {{ chatStore.dialogCount ? (chatStore.currentFolderHasMore ? `${chatStore.dialogCount} / ${chatStore.currentFolderTotal}` : chatStore.dialogCount) : '' }}
          </span>
        </div>

        <!-- 同步状态：明确区分「仅本地缓存」与「已与 Telegram 校准」 -->
        <p class="flex min-w-0 items-center gap-2 text-xs text-muted-foreground" role="status">
          <span
            :class="[
              'size-1.5 shrink-0 rounded-full',
              chatStore.syncStatus.tone === 'ok' ? 'bg-brand' : chatStore.syncStatus.tone === 'error' ? 'bg-destructive' : 'bg-muted-foreground/50 animate-pulse'
            ]"
          />
          <span :class="['truncate', chatStore.syncStatus.tone === 'error' ? 'text-destructive' : '']">{{ chatStore.syncStatus.label }}</span>
          <span class="ml-auto max-w-28 shrink-0 truncate">{{ chatStore.accountLabel }}</span>
        </p>

        <SessionSearch />
      </div>

      <div class="flex-1 min-h-0 overflow-y-auto px-2 pb-2" @scroll.passive="handleScroll">
        <SessionListState v-if="chatStore.listState !== 'ready'" />
        <template v-else>
          <button
            v-if="chatStore.archiveEntry"
            type="button"
            class="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-accent/50 outline-none focus-visible:ring-2 focus-visible:ring-ring"
            @click="chatStore.openArchiveFolder()"
          >
            <span class="size-10 shrink-0 rounded-full bg-muted text-muted-foreground flex items-center justify-center">
              <Archive class="size-4" :stroke-width="1.75" />
            </span>
            <span class="flex-1 min-w-0">
              <span class="flex items-baseline justify-between gap-2">
                <span class="truncate text-sm font-medium">已归档会话</span>
                <span v-if="chatStore.archiveEntry.count" class="shrink-0 text-xs text-muted-foreground tabular-nums">{{ chatStore.archiveEntry.count }}</span>
              </span>
              <span class="mt-0.5 flex items-center gap-2">
                <span class="flex-1 truncate text-[13px] text-muted-foreground">{{ chatStore.archiveEntry.preview }}</span>
                <span
                  v-if="chatStore.archiveEntry.unreadCount > 0"
                  class="shrink-0 min-w-5 h-5 px-1.5 rounded-full bg-muted text-muted-foreground text-[11px] font-semibold tabular-nums flex items-center justify-center"
                >
                  {{ chatStore.archiveEntry.unreadCount > 99 ? '99+' : chatStore.archiveEntry.unreadCount }}
                </span>
              </span>
            </span>
          </button>
          <SessionItem v-for="item in chatStore.visibleSessionItems" :key="item.key" :item="item" />
          <p class="min-h-10 px-3 py-2 flex items-center justify-center text-center text-xs text-muted-foreground">{{ chatStore.listFooter }}</p>
        </template>
      </div>
    </div>
  </section>
</template>
