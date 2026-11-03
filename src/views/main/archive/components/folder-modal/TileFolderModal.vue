<script setup lang="ts">
import { computed } from 'vue';
import {
  Check,
  ChevronRight,
  Folder,
  FolderPlus,
  MessageSquare,
  Plus,
  RefreshCw,
  UnfoldHorizontal,
  X,
} from '@lucide/vue';
import { useChatStore } from '@/stores/chat/stores/chatStore';
import { useChatMediaStore } from '@/stores/chat/stores/chatMediaStore';
import type { TgPeerKey } from '@/stores/chat/types';
import type { FileTileData, FolderTileData, TileData } from '../../types/tile';
import { countFolderItemsRecursive, useTileStore } from '@/stores/archive/stores/tileStore';
import { getFileVisual } from '../tiles/fileVisuals';

const props = defineProps<{
  folder: FolderTileData;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const tileStore = useTileStore();
const chatStore = useChatStore();
const chatMediaStore = useChatMediaStore();

function isChildSession(child: TileData): boolean {
  return (
    child.type === 'file' &&
    Boolean(
      child.isSessionLink ||
        child.sessionCredentialState ||
        child.extension?.toLowerCase() === 'tg',
    )
  );
}

function getChildThumb(child: TileData): string {
  if (child.type === 'file' && isChildSession(child)) {
    const key = child.peerKey || child.sessionId;
    if (key) {
      const liveAvatar = chatMediaStore.dialogAvatarUrl(key);
      if (liveAvatar) return liveAvatar;
      const dialog = chatStore.dialogs[key as TgPeerKey];
      if (dialog?.avatar?.thumb) return dialog.avatar.thumb;
    }
  }
  return child.thumb?.objectUrl || child.thumb?.strippedDataUrl || '';
}

function isChildSelected(childId: string): boolean {
  return tileStore.folderSelectedTileIds.includes(childId);
}

const folderMarqueeRectStyle = computed(() => {
  const m = tileStore.folderMarqueeState;
  if (!m.isSelecting) return null;
  const left = Math.min(m.startX, m.currentX);
  const top = Math.min(m.startY, m.currentY);
  const width = Math.abs(m.currentX - m.startX);
  const height = Math.abs(m.currentY - m.startY);
  if (width < 4 && height < 4) return null;
  return {
    left: `${left}px`,
    top: `${top}px`,
    width: `${width}px`,
    height: `${height}px`,
  };
});

const groupTitle = computed(
  () => tileStore.groups.find((g) => g.id === props.folder.groupId)?.title ?? '未分组',
);

const totalRecursiveCount = computed(() => countFolderItemsRecursive(props.folder));

function startEditingTitle() {
  tileStore.folderModalTitleDraft = props.folder.title;
  tileStore.isEditingFolderModalTitle = true;
}

function saveTitle() {
  if (tileStore.folderModalTitleDraft.trim()) {
    tileStore.renameTile(props.folder.id, tileStore.folderModalTitleDraft.trim());
  }
  tileStore.isEditingFolderModalTitle = false;
}

function handleDissolve() {
  if (confirm(`确定要解散文件夹「${props.folder.title}」吗？其中的项目将移至上一级。`)) {
    tileStore.dissolveFolder(props.folder.id);
  }
}

function handleRemoveItem(item: TileData) {
  tileStore.removeFileFromFolder(props.folder.id, item.id);
}

function handleItemContextMenu(event: MouseEvent, item: TileData) {
  event.preventDefault();
  event.stopPropagation();
  if (
    tileStore.folderSelectedTileIds.length > 0 &&
    !tileStore.folderSelectedTileIds.includes(item.id)
  ) {
    tileStore.setFolderSelectedTileIds([item.id]);
  }
  tileStore.openContextMenu(
    event.clientX,
    event.clientY,
    item,
    props.folder.groupId,
    false,
    props.folder.id,
  );
}

function handleFolderBlankContextMenu(event: MouseEvent) {
  const target = event.target as HTMLElement | null;
  if (target?.closest('[data-folder-tile-id]')) return;
  event.preventDefault();
  event.stopPropagation();
  tileStore.openContextMenu(
    event.clientX,
    event.clientY,
    null,
    props.folder.groupId,
    false,
    props.folder.id,
  );
}

function handleAddSubFolderQuick() {
  const name = prompt('请输入新建子文件夹名称：', '新建子文件夹');
  if (name && name.trim()) {
    tileStore.addSubFolder(props.folder.id, name.trim());
  }
}

function handleAddFileQuick() {
  const name = prompt('请输入新添加的文件名称：', '新建备忘文档.md');
  if (name && name.trim()) {
    const ext = name.includes('.') ? name.split('.').pop() : 'txt';
    tileStore.addNewFile(
      {
        title: name.trim(),
        fileType: ext === 'pdf' ? 'pdf' : ext === 'md' || ext === 'doc' ? 'doc' : 'text',
        extension: ext,
      },
      props.folder.groupId,
      props.folder.id,
    );
  }
}

let suppressClick = false;

function handleOpenChild(event: MouseEvent, item: TileData) {
  if (suppressClick) {
    suppressClick = false;
    return;
  }
  if (event.ctrlKey || event.metaKey || event.shiftKey || tileStore.folderSelectedTileIds.length > 0) {
    tileStore.toggleSelectFolderChildTile(item.id, true);
    return;
  }
  if (item.type === 'folder') {
    tileStore.openFolder(item);
  } else {
    tileStore.openFile(item as FileTileData);
  }
}

/**
 * 在文件夹网格空白处按住左键拖拽 → 启动框选 (Marquee Selection)
 */
function onFolderSectionPointerDown(event: PointerEvent) {
  if (event.button !== 0) return;
  const target = event.target as HTMLElement | null;
  if (!target) return;
  if (
    target.closest('[data-folder-tile-id]') ||
    target.closest('button') ||
    target.closest('input') ||
    target.closest('[data-folder-batch-bar]')
  ) {
    return;
  }

  const startX = event.clientX;
  const startY = event.clientY;
  const additive = event.ctrlKey || event.metaKey || event.shiftKey;
  const baseSelectedIds = additive ? [...tileStore.folderSelectedTileIds] : [];
  let hasMovedMarquee = false;

  const updateHits = (currX: number, currY: number) => {
    const boxLeft = Math.min(startX, currX);
    const boxRight = Math.max(startX, currX);
    const boxTop = Math.min(startY, currY);
    const boxBottom = Math.max(startY, currY);

    const tileEls = Array.from(document.querySelectorAll('[data-folder-tile-id]')) as HTMLElement[];
    const hitIds = new Set<string>(baseSelectedIds);
    for (const el of tileEls) {
      const tid = el.getAttribute('data-folder-tile-id');
      if (!tid) continue;
      const r = el.getBoundingClientRect();
      const intersects =
        r.left < boxRight &&
        r.right > boxLeft &&
        r.top < boxBottom &&
        r.bottom > boxTop;
      if (intersects) {
        hitIds.add(tid);
      }
    }
    tileStore.setFolderSelectedTileIds(Array.from(hitIds));
  };

  const onMove = (moveEvent: PointerEvent) => {
    const dx = Math.abs(moveEvent.clientX - startX);
    const dy = Math.abs(moveEvent.clientY - startY);
    if (!hasMovedMarquee && dx < 5 && dy < 5) return;

    if (!hasMovedMarquee) {
      hasMovedMarquee = true;
      tileStore.folderMarqueeState = {
        isSelecting: true,
        startX,
        startY,
        currentX: moveEvent.clientX,
        currentY: moveEvent.clientY,
        additive,
        baseSelectedIds,
      };
    } else {
      tileStore.folderMarqueeState.currentX = moveEvent.clientX;
      tileStore.folderMarqueeState.currentY = moveEvent.clientY;
    }
    updateHits(moveEvent.clientX, moveEvent.clientY);
  };

  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);

    if (!hasMovedMarquee && !additive && tileStore.folderSelectedTileIds.length > 0) {
      tileStore.clearFolderSelectedTiles();
    }
    tileStore.folderMarqueeState.isSelecting = false;
  };

  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
}

/**
 * 按住卡片拖动超过阈值 → 从文件夹“拖出”：弹窗关闭，拖拽交给磁贴板接管。
 */
function onItemPointerDown(event: PointerEvent, item: TileData) {
  if (event.button !== 0) return;
  if ((event.target as HTMLElement)?.closest('button')) return;

  const startX = event.clientX;
  const startY = event.clientY;
  let started = false;

  const cleanup = () => {
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', cleanup);
    window.removeEventListener('pointercancel', cleanup);
  };

  const onPointerMove = (moveEvent: PointerEvent) => {
    if (started) return;
    if (
      Math.abs(moveEvent.clientX - startX) < 6 &&
      Math.abs(moveEvent.clientY - startY) < 6
    ) {
      return;
    }

    started = true;
    cleanup();

    suppressClick = true;
    window.setTimeout(() => {
      suppressClick = false;
    }, 0);

    if (
      tileStore.folderSelectedTileIds.length > 1 &&
      tileStore.folderSelectedTileIds.includes(item.id)
    ) {
      tileStore.setSelectedTileIds([...tileStore.folderSelectedTileIds]);
    }

    tileStore.beginFolderChildDrag(
      item,
      props.folder,
      moveEvent.clientX,
      moveEvent.clientY,
    );
  };

  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', cleanup);
  window.addEventListener('pointercancel', cleanup);
}
</script>

<template>
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/25 p-4 backdrop-blur-[1px]"
    @click.self="emit('close')"
  >
    <!-- 文件夹详情：支持无限嵌套面包屑下钻与返回 -->
    <div
      class="archive-modal-card relative flex h-[min(860px,90vh)] w-[min(1280px,94vw)] flex-col overflow-hidden border border-white/15 bg-[#0f172a]/70 text-white shadow-[inset_0_1px_0_0_rgba(255,255,255,0.14),0_24px_60px_-12px_rgba(0,0,0,0.6)] backdrop-blur-2xl"
    >
      <!-- 顶栏 + 面包屑路径条 -->
      <header class="flex shrink-0 flex-wrap items-center gap-2 border-b border-white/10 px-4 py-3">
        <span
          class="flex size-[26px] shrink-0 items-center justify-center border border-amber-400/25 bg-amber-500/15 text-amber-300"
        >
          <Folder class="size-4" :stroke-width="1.75" />
        </span>

        <!-- 面包屑导航栈 -->
        <nav class="flex min-w-0 items-center gap-1 overflow-x-auto text-[12px]">
          <span class="shrink-0 text-white/45">{{ groupTitle }}</span>
          <template v-for="(crumb, idx) in tileStore.folderPathStack" :key="crumb.id">
            <ChevronRight class="size-3.5 shrink-0 text-white/30" />
            <button
              v-if="idx < tileStore.folderPathStack.length - 1"
              type="button"
              class="shrink-0 rounded px-1.5 py-0.5 text-sky-300/90 transition-colors hover:bg-white/10 hover:text-white"
              @click="tileStore.navigateToBreadcrumbFolder(crumb.id)"
            >
              {{ crumb.title }}
            </button>
          </template>
        </nav>

        <div v-if="!tileStore.isEditingFolderModalTitle" class="flex min-w-0 items-baseline gap-2">
          <h2
            class="cursor-text truncate text-[14px] font-medium tracking-wide text-white/95 transition-colors hover:text-white"
            title="点击重命名当前文件夹"
            @click="startEditingTitle"
          >
            {{ folder.title }}
          </h2>
          <span class="shrink-0 font-mono text-[10px] text-white/40">
            {{ folder.children.length }} 直属 · 共 {{ totalRecursiveCount }} 项
          </span>
        </div>

        <div v-else class="flex min-w-0 items-center">
          <input
            :value="tileStore.folderModalTitleDraft"
            type="text"
            class="h-7 w-56 max-w-full border border-white/25 bg-black/40 px-2 text-xs text-white outline-none focus:border-sky-400/70"
            autofocus
            @input="tileStore.folderModalTitleDraft = ($event.target as HTMLInputElement).value"
            @keydown.enter="saveTitle"
            @blur="saveTitle"
          />
        </div>

        <div class="ml-auto flex shrink-0 items-center gap-1.5">
          <!-- 封面重载状态横幅 -->
          <div
            v-if="tileStore.coverRefreshBannerText"
            class="flex items-center gap-1.5 rounded-[2px] border border-emerald-400/40 bg-emerald-500/15 px-2 py-0.5 text-[11px] text-emerald-200"
          >
            <RefreshCw
              class="size-3 shrink-0 text-emerald-400"
              :class="tileStore.isRefreshingTileCovers ? 'animate-spin' : ''"
            />
            <span class="max-w-[260px] truncate">{{ tileStore.coverRefreshBannerText }}</span>
          </div>

          <button
            type="button"
            class="flex h-[26px] items-center gap-1 border border-emerald-400/30 bg-emerald-500/15 px-2 text-[11px] text-emerald-200 transition-colors hover:bg-emerald-500/25"
            title="重新载入当前文件夹内加载失败或缺失的贴图"
            @click="tileStore.reloadMissingOrFailedTileCovers(folder.id)"
          >
            <RefreshCw class="size-3.5" :class="tileStore.isRefreshingTileCovers ? 'animate-spin' : ''" />
            <span>重载缺失贴图</span>
          </button>

          <button
            type="button"
            class="flex h-[26px] items-center gap-1 border border-amber-400/30 bg-amber-500/15 px-2 text-[11px] text-amber-200 transition-colors hover:bg-amber-500/25"
            title="在当前文件夹内新建子文件夹"
            @click="handleAddSubFolderQuick"
          >
            <FolderPlus class="size-3.5" />
            <span>新建子文件夹</span>
          </button>
          <button
            type="button"
            class="flex size-[26px] items-center justify-center border border-white/10 text-white/45 transition-colors hover:border-white/25 hover:text-white"
            title="关闭"
            @click="emit('close')"
          >
            <X class="size-3.5" :stroke-width="1.75" />
          </button>
        </div>
      </header>

      <!-- 主体 -->
      <div class="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[1fr_300px]">
        <!-- 左：迷你磁贴网格（同时渲染子文件夹与子文件，支持空白区域右键菜单与拖拽框选） -->
        <section
          class="folder-modal-scroll relative min-h-0 overflow-y-auto select-none p-4 md:p-6"
          @pointerdown="onFolderSectionPointerDown"
          @contextmenu="handleFolderBlankContextMenu"
        >
          <div class="grid grid-cols-[repeat(auto-fill,minmax(92px,1fr))] gap-2.5">
            <div
              v-for="child in folder.children"
              :key="child.id"
              :data-folder-tile-id="child.id"
              class="group/sub relative flex aspect-square cursor-grab select-none flex-col items-center justify-center gap-1.5 overflow-hidden border px-1.5 pb-1.5 pt-2 transition-all active:cursor-grabbing"
              :class="[
                isChildSelected(child.id)
                  ? 'border-sky-400 bg-sky-500/20 ring-2 ring-sky-400/70 shadow-[0_0_14px_rgba(56,189,248,0.3)]'
                  : child.type === 'folder'
                    ? 'border-amber-400/25 bg-amber-500/10 hover:border-amber-400/50 hover:bg-amber-500/18'
                    : 'border-white/10 bg-white/[0.04] hover:border-white/25 hover:bg-white/[0.09]',
              ]"
              @pointerdown="onItemPointerDown($event, child)"
              @click="handleOpenChild($event, child)"
              @contextmenu="handleItemContextMenu($event, child)"
            >
              <!-- 缩略图背景（单层封面全画幅呈现） -->
              <img
                v-if="getChildThumb(child)"
                :src="getChildThumb(child)"
                alt=""
                class="pointer-events-none absolute inset-0 size-full object-cover opacity-85 transition-opacity duration-150 group-hover/sub:opacity-100"
              />
              <div
                v-if="getChildThumb(child)"
                class="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/90 via-black/35 to-black/15"
              />

              <!-- 左上角多选勾选框 -->
              <button
                type="button"
                class="absolute left-1 top-1 z-20 flex size-4 items-center justify-center rounded-[2px] border transition-all"
                :class="
                  isChildSelected(child.id)
                    ? 'border-sky-300 bg-sky-500 text-white opacity-100 shadow-sm'
                    : 'border-white/30 bg-black/45 text-transparent opacity-0 group-hover/sub:opacity-100 hover:border-sky-300'
                "
                title="选择 / 取消选择此磁贴"
                @pointerdown.stop
                @click.stop="tileStore.toggleSelectFolderChildTile(child.id, true)"
              >
                <Check class="size-2.5" :stroke-width="3" />
              </button>

              <button
                type="button"
                class="absolute right-0 top-0 z-10 flex size-5 items-center justify-center text-white/30 opacity-0 transition-opacity hover:text-rose-400 group-hover/sub:opacity-100"
                title="移出到磁贴板"
                @click.stop="handleRemoveItem(child)"
              >
                <X class="size-2.5" />
              </button>

              <!-- 子文件夹图标 -->
              <template v-if="child.type === 'folder'">
                <Folder class="relative z-10 size-6 shrink-0 text-amber-300" :stroke-width="1.8" />
                <span class="relative z-10 font-mono text-[9px] text-amber-200/75">
                  {{ child.children.length }} 项
                </span>
              </template>

              <!-- 子文件或会话图标 -->
              <template v-else>
                <!-- 若已有单层封面背景，绝不再重复嵌套缩小版图片！仅在无封面时展示类型占位图标 -->
                <template v-if="!getChildThumb(child)">
                  <MessageSquare
                    v-if="isChildSession(child)"
                    class="relative z-10 size-5 shrink-0 text-sky-300"
                    :stroke-width="1.9"
                  />
                  <component
                    v-else
                    :is="getFileVisual(child.fileType).icon"
                    class="relative z-10 size-5 shrink-0"
                    :class="getFileVisual(child.fileType).color"
                    :stroke-width="1.8"
                  />
                </template>
                <!-- 会话三态角标 -->
                <span
                  v-if="child.sessionCredentialState"
                  class="absolute bottom-1.5 right-1.5 z-10 size-2 rounded-full"
                  :class="
                    child.sessionCredentialState === 'joined'
                      ? 'bg-emerald-400'
                      : child.sessionCredentialState === 'temp_auto_renew'
                        ? 'bg-purple-400'
                        : 'bg-amber-400'
                  "
                />
              </template>

              <p class="relative z-10 w-full truncate text-center text-[10px] font-medium leading-tight text-white/95 drop-shadow-[0_1px_2px_rgba(0,0,0,0.9)]">
                {{ child.title }}
              </p>
            </div>

            <!-- 添加子文件夹 -->
            <button
              type="button"
              class="flex aspect-square flex-col items-center justify-center gap-1 border border-dashed border-amber-400/20 text-amber-300/50 transition-colors hover:border-amber-400/45 hover:bg-amber-500/[0.06] hover:text-amber-200"
              title="新建子文件夹"
              @click="handleAddSubFolderQuick"
            >
              <FolderPlus class="size-4" :stroke-width="1.75" />
              <span class="text-[9px]">子文件夹</span>
            </button>

            <!-- 添加文件 -->
            <button
              type="button"
              class="flex aspect-square flex-col items-center justify-center gap-1 border border-dashed border-white/15 text-white/35 transition-colors hover:border-white/30 hover:bg-white/[0.04] hover:text-white/75"
              title="添加文件"
              @click="handleAddFileQuick"
            >
              <Plus class="size-4" :stroke-width="1.75" />
              <span class="text-[9px]">添加文件</span>
            </button>
          </div>

          <p
            v-if="folder.children.length === 0"
            class="mt-4 text-center text-[11px] text-white/35"
          >
            拖入磁贴，或在空白处右键新建子文件夹 / 文件 / 重载贴图
          </p>
        </section>

        <!-- 右：文件夹属性与操作 -->
        <aside class="flex min-h-0 flex-col border-t border-white/10 md:border-l md:border-t-0">
          <div class="folder-modal-scroll min-h-0 flex-1 overflow-y-auto px-5 py-6">
            <p class="text-[10px] uppercase tracking-[0.18em] text-white/30">文件夹层级属性</p>

            <dl class="mt-2 divide-y divide-white/[0.06] text-[11px]">
              <div class="flex items-center justify-between gap-3 py-2">
                <dt class="text-white/40">直属子项</dt>
                <dd class="font-mono text-white/75">{{ folder.children.length }}</dd>
              </div>
              <div class="flex items-center justify-between gap-3 py-2">
                <dt class="text-white/40">递归总计</dt>
                <dd class="font-mono text-white/75">{{ totalRecursiveCount }}</dd>
              </div>
              <div class="flex items-center justify-between gap-3 py-2">
                <dt class="text-white/40">嵌套深度</dt>
                <dd class="font-mono text-sky-300">L{{ tileStore.folderPathStack.length }}</dd>
              </div>
              <div class="flex items-center justify-between gap-3 py-2">
                <dt class="text-white/40">所在分组</dt>
                <dd class="truncate text-white/75">{{ groupTitle }}</dd>
              </div>
              <div class="flex items-center justify-between gap-3 py-2">
                <dt class="text-white/40">创建日期</dt>
                <dd class="font-mono text-white/75">{{ folder.createdAt }}</dd>
              </div>
              <div class="flex items-center justify-between gap-3 py-2">
                <dt class="text-white/40">更新时间</dt>
                <dd class="font-mono text-white/75">{{ folder.updatedAt }}</dd>
              </div>
            </dl>
          </div>

          <div class="shrink-0 space-y-2 border-t border-white/10 p-3">
            <button
              type="button"
              class="flex w-full items-center justify-center gap-1.5 border border-emerald-400/30 bg-emerald-500/15 py-2 text-[11px] text-emerald-200 transition-colors hover:bg-emerald-500/25"
              @click="tileStore.reloadMissingOrFailedTileCovers(folder.id)"
            >
              <RefreshCw class="size-3.5" :class="tileStore.isRefreshingTileCovers ? 'animate-spin' : ''" :stroke-width="1.75" />
              <span>重新载入缺失/失败的贴图</span>
            </button>

            <button
              type="button"
              class="flex w-full items-center justify-center gap-1.5 border border-amber-400/30 bg-amber-500/15 py-2 text-[11px] text-amber-200 transition-colors hover:bg-amber-500/25"
              @click="handleAddSubFolderQuick"
            >
              <FolderPlus class="size-3.5" :stroke-width="1.75" />
              <span>新建子文件夹</span>
            </button>

            <button
              type="button"
              class="flex w-full items-center justify-center gap-1.5 bg-white/10 py-2 text-[11px] text-white/85 transition-colors hover:bg-white/15"
              @click="handleAddFileQuick"
            >
              <Plus class="size-3.5" :stroke-width="1.75" />
              <span>添加文件</span>
            </button>

            <button
              type="button"
              class="flex w-full items-center justify-center gap-1.5 border border-white/10 py-2 text-[11px] text-white/55 transition-colors hover:border-white/25 hover:text-white"
              @click="handleDissolve"
            >
              <UnfoldHorizontal class="size-3.5" :stroke-width="1.75" />
              <span>解散文件夹</span>
            </button>
          </div>
        </aside>
      </div>

      <!-- 文件夹内部拖拽框选半透明矩形框（通过 Teleport 挂载到 body，彻底消除包含块 backdrop-blur-2xl 引发的 fixed 视口坐标偏移） -->
      <Teleport to="body">
        <div
          v-if="folderMarqueeRectStyle"
          class="pointer-events-none fixed z-[9999] rounded-[2px] border border-sky-400/90 bg-sky-500/20 shadow-[0_0_16px_rgba(56,189,248,0.28)]"
          :style="folderMarqueeRectStyle"
        />
      </Teleport>
    </div>
  </div>
</template>

<style scoped>
.folder-modal-scroll {
  scrollbar-width: thin;
  scrollbar-color: rgba(255, 255, 255, 0.18) transparent;
}

.folder-modal-scroll::-webkit-scrollbar {
  width: 6px;
}

.folder-modal-scroll::-webkit-scrollbar-track {
  background: transparent;
}

.folder-modal-scroll::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.18);
}
</style>
