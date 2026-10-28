<script setup lang="ts">
import { computed, ref } from 'vue';
import { Folder, Plus, UnfoldHorizontal, X } from '@lucide/vue';
import type { FileTileData, FolderTileData } from '../../types/tile';
import { useTileStore } from '../../store/tileStore';
import { getFileVisual } from '../tiles/fileVisuals';

const props = defineProps<{
  folder: FolderTileData;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const tileStore = useTileStore();
const isEditingTitle = ref(false);
const titleInput = ref(props.folder.title);

const groupTitle = computed(
  () => tileStore.groups.find(g => g.id === props.folder.groupId)?.title ?? '未分组',
);

function saveTitle() {
  if (titleInput.value.trim()) {
    tileStore.renameTile(props.folder.id, titleInput.value.trim());
  }
  isEditingTitle.value = false;
}

function handleDissolve() {
  if (confirm(`确定要解散文件夹「${props.folder.title}」吗？其中的文件将移入当前分组。`)) {
    tileStore.dissolveFolder(props.folder.id);
  }
}

function handleRemoveFile(file: FileTileData) {
  tileStore.removeFileFromFolder(props.folder.id, file.id);
}

function handleFileContextMenu(event: MouseEvent, file: FileTileData) {
  event.preventDefault();
  event.stopPropagation();
  // Open context menu with remove-from-folder capability
  tileStore.openContextMenu(event.clientX, event.clientY, file, props.folder.groupId);
}

function handleAddFileQuick() {
  const name = prompt('请输入新添加的文件名称：', '新建备忘文档.md');
  if (name && name.trim()) {
    const ext = name.includes('.') ? name.split('.').pop() : 'txt';
    const newFile: FileTileData = {
      id: `file-${Date.now()}`,
      type: 'file',
      title: name.trim(),
      size: 'medium',
      groupId: props.folder.groupId,
      x: 0,
      y: 0,
      fileType: ext === 'pdf' ? 'pdf' : ext === 'md' || ext === 'doc' ? 'doc' : 'text',
      extension: ext,
      createdAt: new Date().toISOString().slice(0, 10),
      updatedAt: new Date().toISOString().slice(0, 10),
    };
    props.folder.children.push(newFile);
    tileStore.saveState();
  }
}

let suppressClick = false;

function handleOpenFile(file: FileTileData) {
  if (suppressClick) {
    suppressClick = false;
    return;
  }
  tileStore.openFile(file);
}

/**
 * 按住卡片拖动超过阈值 → 从文件夹“拖出”：弹窗关闭，拖拽交给磁贴板接管。
 */
function onFilePointerDown(event: PointerEvent, file: FileTileData) {
  if (event.button !== 0) return;
  // 卡片内的按钮（如移出按钮）不参与拖出
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

    tileStore.beginFolderChildDrag(
      file,
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
    <!-- 文件夹详情：与文件详情同一套大面板语言 -->
    <div
      class="archive-modal-card relative flex h-[min(860px,90vh)] w-[min(1280px,94vw)] flex-col overflow-hidden border border-white/15 bg-[#0f172a]/70 text-white shadow-[inset_0_1px_0_0_rgba(255,255,255,0.14),0_24px_60px_-12px_rgba(0,0,0,0.6)] backdrop-blur-2xl"
    >
      <!-- 顶栏 -->
      <header class="flex shrink-0 items-center gap-2.5 border-b border-white/10 px-4 py-3">
        <span
          class="flex size-[26px] shrink-0 items-center justify-center border border-white/10 bg-white/[0.04]"
        >
          <Folder class="size-4 text-white/55" :stroke-width="1.75" />
        </span>

        <div v-if="!isEditingTitle" class="flex min-w-0 items-baseline gap-2">
          <h2
            class="cursor-text truncate text-[14px] font-medium tracking-wide text-white/90 transition-colors hover:text-white"
            title="点击重命名文件夹"
            @click="isEditingTitle = true"
          >
            {{ folder.title }}
          </h2>
          <span class="shrink-0 font-mono text-[10px] text-white/35">
            {{ folder.children.length }} 项
          </span>
        </div>

        <div v-else class="flex min-w-0 items-center">
          <input
            v-model="titleInput"
            type="text"
            class="h-7 w-56 max-w-full border border-white/25 bg-black/40 px-2 text-xs text-white outline-none focus:border-sky-400/70"
            @keydown.enter="saveTitle"
            @blur="saveTitle"
            autofocus
          />
        </div>

        <div class="ml-auto flex shrink-0 items-center gap-1">
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
        <!-- 左：迷你磁贴网格 -->
        <section class="folder-modal-scroll min-h-0 overflow-y-auto p-4 md:p-6">
          <div class="grid grid-cols-[repeat(auto-fill,minmax(84px,1fr))] gap-2">
            <div
              v-for="subFile in folder.children"
              :key="subFile.id"
              class="group/sub relative flex aspect-square cursor-grab select-none flex-col items-center justify-center gap-1.5 border border-white/10 bg-white/[0.04] px-1.5 pb-1.5 pt-2 transition-colors hover:border-white/25 hover:bg-white/[0.09] active:cursor-grabbing"
              @pointerdown="onFilePointerDown($event, subFile)"
              @click="handleOpenFile(subFile)"
              @contextmenu="handleFileContextMenu($event, subFile)"
            >
              <button
                type="button"
                class="absolute right-0 top-0 flex size-5 items-center justify-center text-white/20 opacity-0 transition-opacity hover:text-rose-400 group-hover/sub:opacity-100"
                title="移出文件夹"
                @click.stop="handleRemoveFile(subFile)"
              >
                <X class="size-2.5" />
              </button>

              <component
                :is="getFileVisual(subFile.fileType).icon"
                class="size-5 shrink-0"
                :class="getFileVisual(subFile.fileType).color"
                :stroke-width="1.8"
              />

              <p class="w-full truncate text-center text-[10px] leading-tight text-white/70">
                {{ subFile.title }}
              </p>
            </div>

            <!-- 添加文件：和磁贴组一致的「+」空格子 -->
            <button
              type="button"
              class="flex aspect-square items-center justify-center border border-dashed border-white/15 text-white/30 transition-colors hover:border-white/30 hover:bg-white/[0.04] hover:text-white/70"
              title="添加文件"
              @click="handleAddFileQuick"
            >
              <Plus class="size-4" :stroke-width="1.75" />
            </button>
          </div>

          <p
            v-if="folder.children.length === 0"
            class="mt-4 text-center text-[11px] text-white/35"
          >
            拖入磁贴，或点击 + 新建
          </p>
        </section>

        <!-- 右：文件夹属性与操作 -->
        <aside class="flex min-h-0 flex-col border-t border-white/10 md:border-l md:border-t-0">
          <div class="folder-modal-scroll min-h-0 flex-1 overflow-y-auto px-5 py-6">
            <p class="text-[10px] uppercase tracking-[0.18em] text-white/30">文件夹</p>

            <dl class="mt-2 divide-y divide-white/[0.06] text-[11px]">
              <div class="flex items-center justify-between gap-3 py-2">
                <dt class="text-white/40">项目数量</dt>
                <dd class="font-mono text-white/75">{{ folder.children.length }}</dd>
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
