<script setup lang="ts">
import { computed } from 'vue';
import { Layers, Lock, MessageSquare, ShieldCheck } from '@lucide/vue';
import { useChatStore } from '@/stores/chat/stores/chatStore';
import { useChatMediaStore } from '@/stores/chat/stores/chatMediaStore';
import { useTileStore } from '@/stores/archive/stores/tileStore';
import type { TgPeerKey } from '@/stores/chat/types';
import type { FileTileData } from '../../types/tile';
import BaseTile from './BaseTile.vue';
import { getFileVisual } from './fileVisuals';
import { isTelegramMediaTile } from '../../utils/tilePresentation';

const props = defineProps<{
  file: FileTileData;
  isDragging?: boolean;
  isDropTarget?: boolean;
  isPreview?: boolean;
}>();

const emit = defineEmits<{
  (e: 'click', file: FileTileData): void;
  (e: 'contextmenu', event: MouseEvent, file: FileTileData): void;
  (e: 'dragstart', event: PointerEvent, file: FileTileData, grabOffset?: { x: number; y: number }): void;
}>();

const chatStore = useChatStore();
const chatMediaStore = useChatMediaStore();
const tileStore = useTileStore();

const currentConfig = computed(() => getFileVisual(props.file.fileType));

const isSessionTile = computed(() =>
  Boolean(
    props.file.isSessionLink ||
      props.file.sessionCredentialState ||
      props.file.extension?.toLowerCase() === 'tg',
  ),
);

const sessionPeerKey = computed(() => props.file.peerKey || props.file.sessionId || '');

const extBadge = computed(() => {
  if (isSessionTile.value) return 'SESSION';
  if (isTelegramMediaTile(props.file, tileStore.resources)) return 'TG MEDIA';
  return props.file.extension ? props.file.extension.toUpperCase() : currentConfig.value.badge;
});

const thumbSrc = computed(() => {
  // 只有当磁贴本身是「会话磁贴」（isSessionTile）时，才优先使用会话头像；
  // 非会话内容（视频、图片、文件）必须优先展示该视频/图片/文件自身的缩略图！
  if (isSessionTile.value) {
    const key = sessionPeerKey.value;
    // 磁贴自身已持久化的高清缩略图优先，避免被聊天域的 stripped 模糊头像覆盖
    const persisted = props.file.thumb?.objectUrl;
    if (persisted) return persisted;
    if (key) {
      const liveAvatar = chatMediaStore.dialogAvatarUrl(key);
      if (liveAvatar) return liveAvatar;
      const dialog = chatStore.dialogs[key as TgPeerKey];
      if (dialog?.avatar?.thumb) {
        return dialog.avatar.thumb;
      }
    }
  }
  return props.file.thumb?.objectUrl || props.file.thumb?.strippedDataUrl || '';
});

const isHighResThumb = computed(() => {
  if (isSessionTile.value) {
    const key = sessionPeerKey.value;
    if (key && chatMediaStore.dialogAvatarUrl(key)) return true;
  }
  return Boolean(props.file.thumb?.objectUrl);
});

/**
 * 会话磁贴三态视觉标识（遵循架构规范 §5.2）：
 * - joined: 🟢 已加入
 * - temp_ephemeral: 🟠 临时（若有 peekExpiresAt 则精确显示剩余分钟）
 * - temp_auto_renew: 🟣 临时 · 自动续期
 */
const sessionStateBadge = computed(() => {
  const st = props.file.sessionCredentialState;
  if (!st) return null;
  if (st === 'joined') {
    return {
      dotClass: 'bg-emerald-400',
      pillClass: 'border-emerald-400/35 bg-emerald-950/75 text-emerald-200',
      borderOverlay: 'ring-1 ring-inset ring-emerald-400/30',
      label: '已加入',
    };
  }
  if (st === 'temp_auto_renew') {
    return {
      dotClass: 'bg-purple-400',
      pillClass: 'border-purple-400/40 bg-purple-950/75 text-purple-200',
      borderOverlay: 'border-dashed border-purple-400/35',
      label: '自动续期',
    };
  }
  let remainLabel = '临时凭据';
  if (props.file.peekExpiresAt) {
    const diffMin = Math.max(0, Math.round((props.file.peekExpiresAt - Date.now()) / 60000));
    remainLabel = diffMin > 0 ? `剩余 ${diffMin}m` : '已过期';
  }
  return {
    dotClass: 'bg-amber-400',
    pillClass: 'border-amber-400/40 bg-amber-950/75 text-amber-200',
    borderOverlay: 'border-dashed border-amber-400/35',
    label: remainLabel,
  };
});
</script>

<template>
  <BaseTile
    :tile="file"
    :is-dragging="isDragging"
    :is-drop-target="isDropTarget"
    :is-preview="isPreview"
    :title="file.title"
    @click="emit('click', file)"
    @contextmenu="emit('contextmenu', $event, file)"
    @dragstart="(event, _tile, grabOffset) => emit('dragstart', event, file, grabOffset)"
  >
    <!-- 单层全画幅缩略图封面（绝不重复嵌套缩小层） -->
    <img
      v-if="thumbSrc"
      :src="thumbSrc"
      alt=""
      class="pointer-events-none absolute inset-0 size-full object-cover opacity-90 transition-opacity duration-200 group-hover:opacity-100"
      :class="isHighResThumb ? 'blur-0' : 'blur-[0.5px] scale-102'"
    />
    <div
      v-if="thumbSrc"
      class="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/90 via-black/35 to-black/20"
    />

    <!-- 1x1 Small Tile -->
    <div
      v-if="file.size === 'small'"
      class="relative z-10 flex h-full w-full items-center justify-center p-1"
      :class="[thumbSrc ? '' : isSessionTile ? 'bg-sky-500/20' : currentConfig.tint, sessionStateBadge?.borderOverlay]"
    >
      <span
        v-if="sessionStateBadge"
        class="absolute left-1 top-1 z-20 size-2 rounded-full"
        :class="sessionStateBadge.dotClass"
        :title="sessionStateBadge.label"
      />
      <!-- 若无单层封面，才展示占位图标；有封面时全画幅呈现 -->
      <template v-if="!thumbSrc">
        <MessageSquare
          v-if="isSessionTile"
          class="size-5 text-sky-300 transition-transform duration-150 group-hover:scale-110"
          :stroke-width="1.9"
        />
        <component
          v-else
          :is="currentConfig.icon"
          class="size-6 transition-transform duration-150 group-hover:scale-110"
          :class="currentConfig.color"
          :stroke-width="1.8"
        />
      </template>
    </div>

    <!-- 2x2 Medium Tile -->
    <div
      v-else-if="file.size === 'medium'"
      class="relative z-10 flex h-full w-full flex-col justify-between p-2"
      :class="[thumbSrc ? '' : isSessionTile ? 'bg-sky-500/15' : currentConfig.tint, sessionStateBadge?.borderOverlay]"
    >
      <div class="flex items-start justify-between gap-1">
        <!-- 左上角：会话三态徽标 或 保险库/防转发/套图角标 -->
        <div class="flex items-center gap-1">
          <span
            v-if="sessionStateBadge"
            class="inline-flex items-center gap-1 rounded-[2px] border px-1 py-0.5 text-[9px] font-medium leading-none"
            :class="sessionStateBadge.pillClass"
          >
            <span class="size-1.5 rounded-full" :class="sessionStateBadge.dotClass" />
            <span>{{ sessionStateBadge.label }}</span>
          </span>
          <span
            v-if="file.hasVaultCopy"
            class="inline-flex items-center rounded-[2px] bg-emerald-500/25 p-0.5 text-emerald-300"
            title="已备份至共享私密保险库群"
          >
            <ShieldCheck class="size-2.5" />
          </span>
          <span
            v-if="file.noforwards"
            class="inline-flex items-center rounded-[2px] bg-amber-500/25 p-0.5 text-amber-300"
            title="限制转发保护 (noforwards)"
          >
            <Lock class="size-2.5" />
          </span>
          <span
            v-if="file.groupedId && (file.albumCount || 0) > 1"
            class="inline-flex items-center gap-0.5 rounded-[2px] bg-sky-500/25 px-1 py-0.5 font-mono text-[8px] text-sky-200"
            title="原子相册套图"
          >
            <Layers class="size-2.5" />
            <span>{{ file.albumCount }}</span>
          </span>
        </div>

        <span class="rounded-sm bg-black/55 px-1 py-0.5 text-[9px] font-mono tracking-wider text-white/90 shadow-xs">
          {{ extBadge }}
        </span>
      </div>

      <!-- 中间区域：若已有单层封面背景，则不重复放置缩小版图片 -->
      <div class="flex flex-1 items-center justify-center">
        <template v-if="!thumbSrc">
          <div
            v-if="isSessionTile"
            class="flex size-10 items-center justify-center rounded-[3px] border border-sky-400/35 bg-sky-500/25 text-sm font-semibold text-sky-200 shadow-sm"
          >
            {{ file.title.slice(0, 1) || 'S' }}
          </div>
          <component
            v-else
            :is="currentConfig.icon"
            class="size-8 transition-transform duration-150 group-hover:scale-105"
            :class="currentConfig.color"
            :stroke-width="1.8"
          />
        </template>
      </div>

      <div class="min-w-0">
        <p class="truncate text-[11px] font-medium leading-tight text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.85)]">
          {{ file.title }}
        </p>
      </div>
    </div>

    <!-- 4x2 Wide Tile -->
    <div
      v-else-if="file.size === 'wide'"
      class="relative z-10 flex h-full w-full items-center gap-3 p-3"
      :class="[thumbSrc ? '' : isSessionTile ? 'bg-sky-500/15' : currentConfig.tint, sessionStateBadge?.borderOverlay]"
    >
      <div
        v-if="!thumbSrc"
        class="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-[3px] border border-white/15 bg-white/10"
      >
        <MessageSquare
          v-if="isSessionTile"
          class="size-6 text-sky-300"
          :stroke-width="1.9"
        />
        <component
          v-else
          :is="currentConfig.icon"
          class="size-7"
          :class="currentConfig.color"
          :stroke-width="1.8"
        />
      </div>

      <div class="flex min-w-0 flex-1 flex-col justify-center">
        <div class="flex items-center gap-1.5">
          <span
            v-if="sessionStateBadge"
            class="inline-flex shrink-0 items-center gap-1 rounded-[2px] border px-1 py-0.5 text-[9px]"
            :class="sessionStateBadge.pillClass"
          >
            <span class="size-1.5 rounded-full" :class="sessionStateBadge.dotClass" />
            <span>{{ sessionStateBadge.label }}</span>
          </span>
          <span class="rounded-sm bg-black/55 px-1 py-0.5 text-[9px] font-mono text-white/90 shadow-xs">
            {{ extBadge }}
          </span>
          <p class="truncate text-xs font-semibold text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.85)]">
            {{ file.title }}
          </p>
        </div>
        <p v-if="file.description" class="mt-1 line-clamp-2 text-[11px] leading-relaxed text-white/80 drop-shadow-[0_1px_1px_rgba(0,0,0,0.8)]">
          {{ file.description }}
        </p>
      </div>
    </div>

    <!-- 4x4 Large Tile -->
    <div
      v-else
      class="relative z-10 flex h-full w-full flex-col justify-between p-4"
      :class="[thumbSrc ? '' : isSessionTile ? 'bg-sky-500/15' : currentConfig.tint, sessionStateBadge?.borderOverlay]"
    >
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-1.5">
          <span
            v-if="sessionStateBadge"
            class="inline-flex items-center gap-1 rounded-[2px] border px-1.5 py-0.5 text-[10px]"
            :class="sessionStateBadge.pillClass"
          >
            <span class="size-1.5 rounded-full" :class="sessionStateBadge.dotClass" />
            <span>{{ sessionStateBadge.label }}</span>
          </span>
          <span class="rounded-sm bg-black/55 px-1.5 py-0.5 text-[10px] font-mono font-medium text-white/90 shadow-xs">
            {{ extBadge }}
          </span>
        </div>
        <span class="text-[10px] text-white/70 drop-shadow-[0_1px_1px_rgba(0,0,0,0.8)]">{{ file.updatedAt }}</span>
      </div>

      <div class="my-auto flex flex-col items-center justify-center text-center">
        <!-- 若已有单层封面背景，则不重复放置缩小版图片 -->
        <component
          v-if="!thumbSrc"
          :is="currentConfig.icon"
          class="size-12"
          :class="currentConfig.color"
          :stroke-width="1.8"
        />
        <h3 class="mt-2 text-sm font-semibold text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.9)]">
          {{ file.title }}
        </h3>
        <p v-if="file.description" class="mt-1 max-w-[190px] line-clamp-3 text-xs leading-relaxed text-white/80 drop-shadow-[0_1px_1px_rgba(0,0,0,0.8)]">
          {{ file.description }}
        </p>
      </div>

      <div class="text-[11px] text-white/60">
        {{ file.tags?.join(' · ') || '已归档' }}
      </div>
    </div>
  </BaseTile>
</template>
