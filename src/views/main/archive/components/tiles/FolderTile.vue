<script setup lang="ts">
import { computed } from 'vue';
import { Folder, MessageSquare } from '@lucide/vue';
import { useChatStore } from '@/stores/chat/stores/chatStore';
import { useChatMediaStore } from '@/stores/chat/stores/chatMediaStore';
import type { TgPeerKey } from '@/stores/chat/types';
import type { FolderTileData, TileData } from '../../types/tile';
import { countFolderItemsRecursive } from '@/stores/archive/stores/tileStore';
import BaseTile from './BaseTile.vue';
import { getFileVisual } from './fileVisuals';

const props = defineProps<{
  folder: FolderTileData;
  isDragging?: boolean;
  isDropTarget?: boolean;
  isPreview?: boolean;
}>();

const emit = defineEmits<{
  (e: 'click', folder: FolderTileData): void;
  (e: 'contextmenu', event: MouseEvent, folder: FolderTileData): void;
  (e: 'dragstart', event: PointerEvent, folder: FolderTileData, grabOffset?: { x: number; y: number }): void;
}>();

const chatStore = useChatStore();
const chatMediaStore = useChatMediaStore();

function isChildSession(sub: TileData): boolean {
  return (
    sub.type === 'file' &&
    Boolean(
      sub.isSessionLink ||
        sub.sessionCredentialState ||
        sub.extension?.toLowerCase() === 'tg',
    )
  );
}

function getChildThumb(sub: TileData): string {
  if (sub.type === 'file' && isChildSession(sub)) {
    const persisted = sub.thumb?.objectUrl;
    if (persisted) return persisted;
    const key = sub.peerKey || sub.sessionId;
    if (key) {
      const liveAvatar = chatMediaStore.dialogAvatarUrl(key);
      if (liveAvatar) return liveAvatar;
      const dialog = chatStore.dialogs[key as TgPeerKey];
      if (dialog?.avatar?.thumb) return dialog.avatar.thumb;
    }
  }
  return sub.thumb?.objectUrl || sub.thumb?.strippedDataUrl || '';
}

function getChildStyle(sub: TileData) {
  if (sub.type === 'folder') {
    return {
      icon: Folder,
      bgClass: 'bg-amber-600/85',
      iconClass: 'text-amber-100',
    };
  }
  if (isChildSession(sub)) {
    return {
      icon: MessageSquare,
      bgClass: 'bg-sky-600/85',
      iconClass: 'text-sky-100',
    };
  }
  const visual = getFileVisual(sub.fileType);
  return { icon: visual.icon, bgClass: visual.solidBg, iconClass: visual.solidIcon };
}

const totalCount = computed(() => countFolderItemsRecursive(props.folder));

const maxPreviews = computed(() => {
  switch (props.folder.size) {
    case 'small':
      return 4;
    case 'wide':
      return 12;
    case 'large':
      return 12;
    case 'medium':
    default:
      return 6;
  }
});

const previewItems = computed(() => {
  return props.folder.children.slice(0, maxPreviews.value);
});
</script>

<template>
  <BaseTile
    :tile="folder"
    :is-dragging="isDragging"
    :is-drop-target="isDropTarget"
    :is-preview="isPreview"
    :title="`${folder.title} (${totalCount} 个项目)`"
    @click="emit('click', folder)"
    @contextmenu="emit('contextmenu', $event, folder)"
    @dragstart="(event, _tile, grabOffset) => emit('dragstart', event, folder, grabOffset)"
  >
    <!-- 1x1 Small Tile -->
    <div
      v-if="folder.size === 'small'"
      class="flex h-full w-full items-center justify-center p-1.5"
    >
      <div v-if="previewItems.length > 0" class="grid grid-cols-2 gap-1">
        <div
          v-for="sub in previewItems"
          :key="sub.id"
          class="flex size-3.5 items-center justify-center overflow-hidden rounded-[2px] shadow-sm"
          :class="getChildStyle(sub).bgClass"
          :title="sub.title"
        >
          <img
            v-if="getChildThumb(sub)"
            :src="getChildThumb(sub)"
            alt=""
            class="size-full object-cover"
          />
          <component
            v-else
            :is="getChildStyle(sub).icon"
            class="size-2.5"
            :class="getChildStyle(sub).iconClass"
            :stroke-width="1.8"
          />
        </div>
      </div>
      <Folder v-else class="size-5 text-white/40" :stroke-width="1.5" />
    </div>

    <!-- 4x2 Wide Tile -->
    <div
      v-else-if="folder.size === 'wide'"
      class="flex h-full w-full flex-col justify-between p-2.5"
    >
      <div v-if="previewItems.length > 0" class="grid grid-cols-6 gap-2 px-0.5 pt-0.5">
        <div
          v-for="sub in previewItems"
          :key="sub.id"
          class="flex size-[22px] items-center justify-center overflow-hidden rounded-[3.5px] shadow-sm"
          :class="getChildStyle(sub).bgClass"
          :title="sub.title"
        >
          <img
            v-if="getChildThumb(sub)"
            :src="getChildThumb(sub)"
            alt=""
            class="size-full object-cover"
          />
          <component
            v-else
            :is="getChildStyle(sub).icon"
            class="size-3.5"
            :class="getChildStyle(sub).iconClass"
            :stroke-width="1.9"
          />
        </div>
      </div>
      <div v-else class="my-auto flex items-center justify-center">
        <Folder class="size-6 text-white/30" :stroke-width="1.5" />
      </div>

      <div class="min-w-0 px-0.5 pb-0.5">
        <p class="truncate text-[12px] font-normal leading-tight text-white/95 tracking-wide">
          {{ folder.title }}
        </p>
      </div>
    </div>

    <!-- 4x4 Large Tile -->
    <div
      v-else-if="folder.size === 'large'"
      class="flex h-full w-full flex-col justify-between p-3.5"
    >
      <div v-if="previewItems.length > 0" class="grid grid-cols-4 gap-3 px-1 pt-1">
        <div
          v-for="sub in previewItems"
          :key="sub.id"
          class="flex size-8 items-center justify-center overflow-hidden rounded-[5px] shadow-sm"
          :class="getChildStyle(sub).bgClass"
          :title="sub.title"
        >
          <img
            v-if="getChildThumb(sub)"
            :src="getChildThumb(sub)"
            alt=""
            class="size-full object-cover"
          />
          <component
            v-else
            :is="getChildStyle(sub).icon"
            class="size-5"
            :class="getChildStyle(sub).iconClass"
            :stroke-width="1.8"
          />
        </div>
      </div>
      <div v-else class="my-auto flex items-center justify-center">
        <Folder class="size-10 text-white/30" :stroke-width="1.5" />
      </div>

      <div class="min-w-0 px-1 pb-1">
        <p class="truncate text-sm font-normal leading-tight text-white/95 tracking-wide">
          {{ folder.title }}
        </p>
      </div>
    </div>

    <!-- 2x2 Medium Tile -->
    <div
      v-else
      class="flex h-full w-full flex-col justify-between p-2.5"
    >
      <div v-if="previewItems.length > 0" class="grid grid-cols-3 gap-2 px-0.5 pt-0.5">
        <div
          v-for="sub in previewItems"
          :key="sub.id"
          class="flex size-[22px] items-center justify-center overflow-hidden rounded-[3.5px] shadow-sm transition-transform duration-150 group-hover:scale-105"
          :class="getChildStyle(sub).bgClass"
          :title="sub.title"
        >
          <img
            v-if="getChildThumb(sub)"
            :src="getChildThumb(sub)"
            alt=""
            class="size-full object-cover"
          />
          <component
            v-else
            :is="getChildStyle(sub).icon"
            class="size-3.5"
            :class="getChildStyle(sub).iconClass"
            :stroke-width="1.9"
          />
        </div>
      </div>

      <div v-else class="my-auto flex items-center justify-center">
        <Folder class="size-6 text-white/30" :stroke-width="1.5" />
      </div>

      <div class="flex items-baseline justify-between gap-1 px-0.5 pb-0.5">
        <p class="min-w-0 flex-1 truncate text-[12px] font-normal leading-tight text-white/95 tracking-wide">
          {{ folder.title }}
        </p>
        <span v-if="totalCount > 0" class="shrink-0 font-mono text-[9px] text-white/40">
          {{ totalCount }}
        </span>
      </div>
    </div>
  </BaseTile>
</template>
