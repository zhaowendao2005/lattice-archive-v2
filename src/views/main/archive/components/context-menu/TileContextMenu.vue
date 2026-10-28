<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import {
  ExternalLink,
  FolderOpen,
  FolderPlus,
  Maximize2,
  Minimize2,
  Pencil,
  Plus,
  RotateCcw,
  Square,
  Trash2,
  UnfoldHorizontal,
} from '@lucide/vue';
import type { TileSize } from '../../types/tile';
import { useTileStore } from '../../store/tileStore';

const tileStore = useTileStore();
const menuRef = ref<HTMLElement | null>(null);

const activeTile = computed(() => {
  if (!tileStore.contextMenu.tileId) return null;
  return tileStore.getTileById(tileStore.contextMenu.tileId);
});

const activeGroup = computed(() => {
  if (tileStore.contextMenu.tileId || !tileStore.contextMenu.groupId) return null;
  return tileStore.groups.find(g => g.id === tileStore.contextMenu.groupId) || null;
});

const menuStyle = computed(() => {
  const x = Math.min(tileStore.contextMenu.x, window.innerWidth - 190);
  const y = Math.min(tileStore.contextMenu.y, window.innerHeight - 280);
  return {
    left: `${Math.max(10, x)}px`,
    top: `${Math.max(10, y)}px`,
  };
});

function handleResize(size: TileSize) {
  if (tileStore.contextMenu.tileId) {
    tileStore.resizeTile(tileStore.contextMenu.tileId, size);
  }
  tileStore.closeContextMenu();
}

function handleRename() {
  if (!activeTile.value) return;
  const newName = prompt('重命名磁贴：', activeTile.value.title);
  if (newName && newName.trim()) {
    tileStore.renameTile(activeTile.value.id, newName.trim());
  }
  tileStore.closeContextMenu();
}

function handleOpen() {
  if (!activeTile.value) return;
  if (activeTile.value.type === 'file') {
    tileStore.openFile(activeTile.value);
  } else if (activeTile.value.type === 'folder') {
    tileStore.openFolder(activeTile.value);
  }
  tileStore.closeContextMenu();
}

function handleDissolve() {
  if (!activeTile.value || activeTile.value.type !== 'folder') return;
  if (confirm(`确定要解散文件夹「${activeTile.value.title}」吗？`)) {
    tileStore.dissolveFolder(activeTile.value.id);
  }
  tileStore.closeContextMenu();
}

function handleDelete() {
  if (!activeTile.value) return;
  if (confirm(`确定要从开始屏幕移除磁贴「${activeTile.value.title}」吗？`)) {
    tileStore.deleteTile(activeTile.value.id);
  }
  tileStore.closeContextMenu();
}

function handleCreateGroup() {
  const name = prompt('请输入新分组（栏）名称：', '新建分组');
  if (name !== null) {
    tileStore.addNewGroup(name.trim() || '新建分组');
  }
  tileStore.closeContextMenu();
}

function handleRenameGroup() {
  if (!activeGroup.value) return;
  const newName = prompt('重命名分组：', activeGroup.value.title);
  if (newName && newName.trim()) {
    tileStore.renameGroup(activeGroup.value.id, newName.trim());
  }
  tileStore.closeContextMenu();
}

function handleDeleteGroup() {
  if (!activeGroup.value) return;
  if (confirm(`确定要删除分组「${activeGroup.value.title}」吗？组内磁贴将被移动至其他分组。`)) {
    tileStore.deleteGroup(activeGroup.value.id);
  }
  tileStore.closeContextMenu();
}

function handleSetGroupWidth(cols: number) {
  if (!activeGroup.value) return;
  tileStore.setGroupWidth(activeGroup.value.id, cols);
  tileStore.closeContextMenu();
}

function handleCreateFile() {
  const name = prompt('请输入新文件磁贴名称：', '新归档文档.md');
  if (name && name.trim()) {
    tileStore.addNewFile({ title: name.trim() }, tileStore.contextMenu.groupId || undefined);
  }
  tileStore.closeContextMenu();
}

function handleCreateFolder() {
  const name = prompt('请输入新文件夹名称：', '新建分类文件夹');
  if (name && name.trim()) {
    tileStore.addNewFolder(name.trim(), tileStore.contextMenu.groupId || undefined);
  }
  tileStore.closeContextMenu();
}

function handleReset() {
  if (confirm('确定要恢复默认 Windows 10 磁贴布局吗？当前自定义调整将被覆盖。')) {
    tileStore.resetToDefault();
  }
  tileStore.closeContextMenu();
}

function onClickOutside(event: MouseEvent) {
  if (menuRef.value && !menuRef.value.contains(event.target as Node)) {
    tileStore.closeContextMenu();
  }
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    tileStore.closeContextMenu();
  }
}

onMounted(() => {
  window.addEventListener('mousedown', onClickOutside);
  window.addEventListener('keydown', onKeydown);
});

onUnmounted(() => {
  window.removeEventListener('mousedown', onClickOutside);
  window.removeEventListener('keydown', onKeydown);
});
</script>

<template>
  <div
    v-if="tileStore.contextMenu.visible"
    ref="menuRef"
    class="fixed z-50 min-w-[175px] overflow-hidden rounded-md border border-white/20 bg-[#161a22]/95 py-1 text-xs text-white shadow-2xl backdrop-blur-2xl"
    :style="menuStyle"
  >
    <!-- 1. Tile Specific Actions -->
    <template v-if="activeTile">
      <!-- Title header -->
      <div class="px-3 py-1.5 text-[11px] font-semibold text-white/50 truncate border-b border-white/10">
        {{ activeTile.title }}
      </div>

      <!-- Resize Submenu -->
      <div class="px-1 py-1">
        <div class="px-2 py-1 text-[10px] uppercase tracking-wider text-white/40">调整大小</div>
        <div class="grid grid-cols-4 gap-1 px-1">
          <button
            type="button"
            class="flex flex-col items-center justify-center rounded p-1 text-[10px] hover:bg-white/10 transition-colors"
            :class="activeTile.size === 'small' ? 'bg-sky-500/30 text-sky-300 font-semibold' : 'text-white/70'"
            title="小 (1×1)"
            @click="handleResize('small')"
          >
            <Minimize2 class="size-3" />
            <span class="mt-0.5">小</span>
          </button>
          <button
            type="button"
            class="flex flex-col items-center justify-center rounded p-1 text-[10px] hover:bg-white/10 transition-colors"
            :class="activeTile.size === 'medium' ? 'bg-sky-500/30 text-sky-300 font-semibold' : 'text-white/70'"
            title="中 (2×2)"
            @click="handleResize('medium')"
          >
            <Square class="size-3" />
            <span class="mt-0.5">中</span>
          </button>
          <button
            type="button"
            class="flex flex-col items-center justify-center rounded p-1 text-[10px] hover:bg-white/10 transition-colors"
            :class="activeTile.size === 'wide' ? 'bg-sky-500/30 text-sky-300 font-semibold' : 'text-white/70'"
            title="宽 (4×2)"
            @click="handleResize('wide')"
          >
            <UnfoldHorizontal class="size-3" />
            <span class="mt-0.5">宽</span>
          </button>
          <button
            type="button"
            class="flex flex-col items-center justify-center rounded p-1 text-[10px] hover:bg-white/10 transition-colors"
            :class="activeTile.size === 'large' ? 'bg-sky-500/30 text-sky-300 font-semibold' : 'text-white/70'"
            title="大 (4×4)"
            @click="handleResize('large')"
          >
            <Maximize2 class="size-3" />
            <span class="mt-0.5">大</span>
          </button>
        </div>
      </div>

      <div class="my-1 border-t border-white/10" />

      <!-- Open / Preview -->
      <button
        type="button"
        class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-white/85 hover:bg-white/10 transition-colors"
        @click="handleOpen"
      >
        <ExternalLink class="size-3.5 text-white/60" />
        <span>{{ activeTile.type === 'folder' ? '展开文件夹' : '查看文件详情' }}</span>
      </button>

      <!-- Rename -->
      <button
        type="button"
        class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-white/85 hover:bg-white/10 transition-colors"
        @click="handleRename"
      >
        <Pencil class="size-3.5 text-white/60" />
        <span>重命名</span>
      </button>

      <!-- Dissolve (for folder) -->
      <button
        v-if="activeTile.type === 'folder'"
        type="button"
        class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-white/85 hover:bg-white/10 transition-colors"
        @click="handleDissolve"
      >
        <UnfoldHorizontal class="size-3.5 text-white/60" />
        <span>解散文件夹</span>
      </button>

      <div class="my-1 border-t border-white/10" />

      <!-- Delete / Unpin -->
      <button
        type="button"
        class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-rose-400 hover:bg-rose-500/20 transition-colors"
        @click="handleDelete"
      >
        <Trash2 class="size-3.5 text-rose-400" />
        <span>从磁贴板移除</span>
      </button>
    </template>

    <!-- 2. Group Header Context Actions -->
    <template v-else-if="activeGroup">
      <div class="px-3 py-1.5 text-[11px] font-semibold text-white/50 truncate border-b border-white/10">
        分组：{{ activeGroup.title }}
      </div>

      <button
        type="button"
        class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-white/85 hover:bg-white/10 transition-colors"
        @click="handleRenameGroup"
      >
        <Pencil class="size-3.5 text-white/60" />
        <span>重命名分组</span>
      </button>

      <button
        type="button"
        class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-white/85 hover:bg-white/10 transition-colors"
        @click="handleCreateFile"
      >
        <Plus class="size-3.5 text-sky-400" />
        <span>在此组新建文件</span>
      </button>

      <button
        type="button"
        class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-white/85 hover:bg-white/10 transition-colors"
        @click="handleCreateFolder"
      >
        <FolderOpen class="size-3.5 text-sky-400" />
        <span>在此组新建文件夹</span>
      </button>

      <!-- Group Width Setting -->
      <div class="my-1 border-t border-white/10" />
      <div class="px-3 py-1 text-[10px] uppercase tracking-wider text-white/40">栏宽度设置</div>
      <div class="grid grid-cols-3 gap-1 px-2 py-0.5">
        <button
          v-for="w in [4, 6, 8]"
          :key="w"
          type="button"
          class="rounded py-1 text-center text-[10px] transition-colors"
          :class="(activeGroup.widthColumns || 6) === w ? 'bg-sky-500/30 text-sky-300 font-semibold' : 'text-white/70 hover:bg-white/10'"
          @click="handleSetGroupWidth(w)"
        >
          {{ w }} 列
        </button>
      </div>

      <div class="my-1 border-t border-white/10" />

      <button
        type="button"
        class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-rose-400 hover:bg-rose-500/20 transition-colors"
        @click="handleDeleteGroup"
      >
        <Trash2 class="size-3.5 text-rose-400" />
        <span>删除此分组</span>
      </button>
    </template>

    <!-- 3. Empty Canvas / Board Actions -->
    <template v-else>
      <button
        type="button"
        class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-white/95 hover:bg-white/10 transition-colors"
        @click="handleCreateGroup"
      >
        <FolderPlus class="size-3.5 text-sky-400" />
        <span class="font-medium text-sky-300">新建分组（栏）</span>
      </button>

      <div class="my-1 border-t border-white/10" />

      <button
        type="button"
        class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-white/85 hover:bg-white/10 transition-colors"
        @click="handleCreateFile"
      >
        <Plus class="size-3.5 text-white/60" />
        <span>新建文件磁贴</span>
      </button>

      <button
        type="button"
        class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-white/85 hover:bg-white/10 transition-colors"
        @click="handleCreateFolder"
      >
        <FolderOpen class="size-3.5 text-white/60" />
        <span>新建文件夹</span>
      </button>

      <div class="my-1 border-t border-white/10" />

      <button
        type="button"
        class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-white/70 hover:bg-white/10 transition-colors"
        @click="handleReset"
      >
        <RotateCcw class="size-3.5 text-white/50" />
        <span>恢复默认布局</span>
      </button>
    </template>
  </div>
</template>
