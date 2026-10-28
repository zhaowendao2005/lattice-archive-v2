<script setup lang="ts">
import { computed } from 'vue';
import { Folder } from '@lucide/vue';
import type { FileCategory, FolderTileData } from '../../types/tile';
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

// 复用全站统一的文件视觉语言（实色小方块版本）
function getStyle(fileType: FileCategory) {
  const visual = getFileVisual(fileType);
  return { icon: visual.icon, bgClass: visual.solidBg, iconClass: visual.solidIcon };
}

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
    :title="`${folder.title} (${folder.children.length} 个项目)`"
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
          class="flex size-3.5 items-center justify-center rounded-[2px] shadow-sm"
          :class="getStyle(sub.fileType).bgClass"
          :title="sub.title"
        >
          <component
            :is="getStyle(sub.fileType).icon"
            class="size-2.5"
            :class="getStyle(sub.fileType).iconClass"
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
          class="flex size-[22px] items-center justify-center rounded-[3.5px] shadow-sm"
          :class="getStyle(sub.fileType).bgClass"
          :title="sub.title"
        >
          <component
            :is="getStyle(sub.fileType).icon"
            class="size-3.5"
            :class="getStyle(sub.fileType).iconClass"
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
          class="flex size-8 items-center justify-center rounded-[5px] shadow-sm"
          :class="getStyle(sub.fileType).bgClass"
          :title="sub.title"
        >
          <component
            :is="getStyle(sub.fileType).icon"
            class="size-5"
            :class="getStyle(sub.fileType).iconClass"
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

    <!-- 2x2 Medium Tile (Classic Win10 Live Folder Tile - Matching User Screenshot) -->
    <div
      v-else
      class="flex h-full w-full flex-col justify-between p-2.5"
    >
      <!-- Top: 3-column Grid of Child App/File Icons -->
      <div v-if="previewItems.length > 0" class="grid grid-cols-3 gap-2 px-0.5 pt-0.5">
        <div
          v-for="sub in previewItems"
          :key="sub.id"
          class="flex size-[22px] items-center justify-center rounded-[3.5px] shadow-sm transition-transform duration-150 group-hover:scale-105"
          :class="getStyle(sub.fileType).bgClass"
          :title="sub.title"
        >
          <component
            :is="getStyle(sub.fileType).icon"
            class="size-3.5"
            :class="getStyle(sub.fileType).iconClass"
            :stroke-width="1.9"
          />
        </div>
      </div>

      <!-- Empty State -->
      <div v-else class="my-auto flex items-center justify-center">
        <Folder class="size-6 text-white/30" :stroke-width="1.5" />
      </div>

      <!-- Bottom-Left: Folder Title (Native Windows 10 Segoe / YaHei style) -->
      <div class="min-w-0 px-0.5 pb-0.5">
        <p class="truncate text-[12px] font-normal leading-tight text-white/95 tracking-wide">
          {{ folder.title }}
        </p>
      </div>
    </div>
  </BaseTile>
</template>
