<script setup lang="ts">
import { computed } from 'vue';
import {
  FolderPlus,
  Image,
  LayoutGrid,
  Plus,
  RotateCcw,
  Search,
  X,
} from '@lucide/vue';
import { useTileStore } from './store/tileStore';
import TileBoard from './components/board/TileBoard.vue';
import TileFolderModal from './components/folder-modal/TileFolderModal.vue';
import FileDetailModal from './components/file-modal/FileDetailModal.vue';
import TileContextMenu from './components/context-menu/TileContextMenu.vue';

const tileStore = useTileStore();

const totalTilesCount = computed(() => tileStore.tiles.length);

function handleResetLayout() {
  if (confirm('确定要恢复默认 Windows 10 开始屏幕磁贴布局吗？')) {
    tileStore.resetToDefault();
  }
}

function handleCreateFile() {
  const name = prompt('请输入新文件磁贴名称：', '新归档文档.md');
  if (name && name.trim()) {
    tileStore.addNewFile({ title: name.trim() });
  }
}

function handleCreateFolder() {
  const name = prompt('请输入新文件夹名称：', '新建分类文件夹');
  if (name && name.trim()) {
    tileStore.addNewFolder(name.trim());
  }
}

function clearSearch() {
  tileStore.searchQuery = '';
}

function handleChangeWallpaper() {
  const url = prompt('输入壁纸图片 URL 或路径：', tileStore.wallpaper);
  if (url && url.trim()) {
    tileStore.wallpaper = url.trim();
    tileStore.saveState();
  }
}
</script>

<template>
  <main
    class="relative flex h-full w-full min-w-0 flex-1 flex-col overflow-hidden select-none bg-[#0a0d14]"
    :style="{
      backgroundImage: `url(${tileStore.wallpaper})`,
      backgroundSize: 'cover',
      backgroundPosition: 'center',
    }"
  >
    <!-- Crisp clear wallpaper background with slight tint for contrast (No blur on wallpaper!) -->
    <div
      class="absolute inset-0 z-0 bg-black/15 pointer-events-none"
    />

    <!-- Top Minimalist Acrylic Header -->
    <header class="relative z-10 flex shrink-0 items-center justify-between border-b border-white/10 bg-black/20 px-6 py-3.5 backdrop-blur-md">
      <!-- Title & Branding -->
      <div class="flex items-center gap-3">
        <div class="flex size-8 items-center justify-center rounded-[2px] bg-sky-500/20 text-sky-400 border border-sky-400/30">
          <LayoutGrid class="size-4" :stroke-width="2" />
        </div>
        <div class="flex items-baseline gap-2">
          <h1 class="text-sm font-semibold tracking-wide text-white/95">
            磁贴归档
          </h1>
          <span class="text-[11px] text-white/40">
            {{ totalTilesCount }} 项 · 支持随心直拖与右键调谐
          </span>
        </div>
      </div>

      <!-- Center Search Bar (Glassmorphic) -->
      <div class="flex max-w-sm flex-1 items-center px-4">
        <div class="relative w-full">
          <Search class="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-white/40" />
          <input
            v-model="tileStore.searchQuery"
            type="text"
            placeholder="快速检索磁贴标题、格式或描述..."
            class="h-8 w-full rounded border border-white/15 bg-white/10 pl-8 pr-7 text-xs text-white placeholder-white/40 outline-none transition-colors focus:border-sky-400/80 focus:bg-white/15"
          />
          <button
            v-if="tileStore.searchQuery"
            type="button"
            class="absolute right-2 top-1/2 -translate-y-1/2 text-white/40 hover:text-white"
            @click="clearSearch"
          >
            <X class="size-3.5" />
          </button>
        </div>
      </div>

      <!-- Quick Action Buttons -->
      <div class="flex items-center gap-2">
        <button
          type="button"
          class="flex items-center gap-1.5 rounded-[2px] border border-white/15 bg-white/10 px-2.5 py-1 text-xs text-white/80 hover:bg-white/20 hover:text-white transition-colors"
          title="新建文件磁贴"
          @click="handleCreateFile"
        >
          <Plus class="size-3.5" />
          <span>新建文件</span>
        </button>

        <button
          type="button"
          class="flex items-center gap-1.5 rounded-[2px] border border-white/15 bg-white/10 px-2.5 py-1 text-xs text-white/80 hover:bg-white/20 hover:text-white transition-colors"
          title="新建文件夹"
          @click="handleCreateFolder"
        >
          <FolderPlus class="size-3.5" />
          <span>新建文件夹</span>
        </button>

        <button
          type="button"
          class="flex items-center justify-center rounded-[2px] border border-white/10 p-1.5 text-white/50 hover:bg-white/10 hover:text-white transition-colors"
          title="更换背景壁纸"
          @click="handleChangeWallpaper"
        >
          <Image class="size-3.5" />
        </button>

        <button
          type="button"
          class="flex items-center justify-center rounded-[2px] border border-white/10 p-1.5 text-white/50 hover:bg-white/10 hover:text-white transition-colors"
          title="恢复默认磁贴布局"
          @click="handleResetLayout"
        >
          <RotateCcw class="size-3.5" />
        </button>
      </div>
    </header>

    <!-- Main Tile Board -->
    <div class="relative z-10 flex-1 min-h-0 overflow-hidden">
      <TileBoard />
    </div>

    <!-- Option B: Folder Floating Acrylic Modal -->
    <Transition name="archive-pop">
      <TileFolderModal
        v-if="tileStore.activeFolder"
        :folder="tileStore.activeFolder"
        @close="tileStore.closeFolder"
      />
    </Transition>

    <!-- File Detail Preview Modal -->
    <Transition name="archive-pop">
      <FileDetailModal
        v-if="tileStore.selectedFile"
        :file="tileStore.selectedFile"
        @close="tileStore.closeFile"
      />
    </Transition>

    <!-- Windows 10 Context Menu -->
    <TileContextMenu />
  </main>
</template>

<style scoped>
/* 档案弹窗（文件夹 / 文件详情）：轻微放大淡入，关闭反向收拢 */
.archive-pop-enter-active,
.archive-pop-leave-active {
  transition: opacity 150ms ease;
}

.archive-pop-enter-from,
.archive-pop-leave-to {
  opacity: 0;
}

.archive-pop-enter-active :deep(.archive-modal-card) {
  transition: transform 160ms cubic-bezier(0.16, 1, 0.3, 1);
}

.archive-pop-enter-from :deep(.archive-modal-card) {
  transform: scale(0.94);
}

.archive-pop-leave-active :deep(.archive-modal-card) {
  transition: transform 120ms ease-in;
}

.archive-pop-leave-to :deep(.archive-modal-card) {
  transform: scale(0.97);
}
</style>
