<!--
  ============================================================================
  单个会话条目（左栏一行）
  ============================================================================
  展示层次（从外到内）：
  头像（v-avatar-visible 指令按可见性拉取头像） → 标题 + 时间 → 预览 + 归档按钮 + 未读/置顶。
  注意：归档按钮只在 hover / focus-within 时出现，点击用 .stop.prevent
  避免触发外层 RouterLink 跳转。
-->
<script setup lang="ts">
import { Archive, ArchiveRestore, BellOff, Loader2, Pin } from '@lucide/vue';
import { useChatStore } from '@/stores/chat/stores/chatStore';
import { useChatMediaStore } from '@/stores/chat/stores/chatMediaStore';
import { vAvatarVisible } from '../conversation/media/mediaVisible';
import type { SessionListItem } from '@/stores/chat/types';

const props = defineProps<{ item: SessionListItem }>();
const chatStore = useChatStore();
const mediaStore = useChatMediaStore();
</script>

<template>
  <RouterLink
    :to="{ name: 'chats', params: { chatKey: props.item.key } }"
    :class="[
      'group relative flex w-full gap-3 rounded-lg px-3 py-2.5 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring',
      chatStore.activeChatKey === props.item.key ? 'bg-accent' : 'hover:bg-accent/50'
    ]"
    :aria-current="chatStore.activeChatKey === props.item.key ? 'page' : undefined"
  >
    <span
      v-avatar-visible="props.item.avatarKey ? props.item.key : undefined"
      class="relative size-10 shrink-0 overflow-hidden rounded-full bg-brand-soft text-brand text-xs font-semibold flex items-center justify-center"
    >
      <img
        v-if="mediaStore.avatarUrl(props.item.avatarKey, props.item.avatarThumb)"
        :src="mediaStore.avatarUrl(props.item.avatarKey, props.item.avatarThumb)"
        :alt="props.item.title"
        :class="[
          'size-full object-cover',
          !mediaStore.isAvatarLoaded(props.item.avatarKey) && props.item.avatarThumb ? 'scale-110 blur-[2px]' : ''
        ]"
        loading="lazy"
      />
      <span v-else>{{ props.item.initials }}</span>
    </span>

    <span class="flex-1 min-w-0">
      <span class="flex items-baseline justify-between gap-2">
        <span class="flex min-w-0 items-center gap-1">
          <span class="truncate text-sm font-medium">{{ props.item.title }}</span>
          <BellOff v-if="props.item.muted" class="size-3.5 shrink-0 text-muted-foreground" :stroke-width="1.75" aria-label="已静音" />
        </span>
        <span class="shrink-0 text-xs text-muted-foreground tabular-nums">{{ props.item.timeLabel }}</span>
      </span>
      <span class="mt-0.5 flex items-center gap-2">
        <span class="flex-1 truncate text-[13px] text-muted-foreground">{{ props.item.preview }}</span>
        <button
          v-if="props.item.canArchive"
          type="button"
          class="hidden group-hover:inline-flex group-focus-within:inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring"
          :aria-label="props.item.folderId === 1 ? '取消归档' : '归档会话'"
          :title="props.item.folderId === 1 ? '取消归档' : '归档会话'"
          @click.stop.prevent="chatStore.toggleArchive(props.item.key)"
        >
          <Loader2 v-if="chatStore.archivingKeys[props.item.key]" class="size-3.5 animate-spin" :stroke-width="1.75" />
          <ArchiveRestore v-else-if="props.item.folderId === 1" class="size-3.5" :stroke-width="1.75" />
          <Archive v-else class="size-3.5" :stroke-width="1.75" />
        </button>
        <span
          v-if="props.item.unreadCount > 0 || props.item.unreadMark"
          :class="[
            'shrink-0 min-w-5 h-5 px-1.5 rounded-full text-[11px] font-semibold tabular-nums flex items-center justify-center',
            props.item.muted ? 'bg-muted text-muted-foreground' : 'bg-brand text-brand-foreground'
          ]"
        >
          {{ props.item.unreadCount > 99 ? '99+' : props.item.unreadCount || '' }}
        </span>
        <Pin v-else-if="props.item.pinned" class="size-3.5 shrink-0 rotate-45 text-muted-foreground" :stroke-width="1.75" aria-label="已置顶" />
      </span>
    </span>
  </RouterLink>
</template>
