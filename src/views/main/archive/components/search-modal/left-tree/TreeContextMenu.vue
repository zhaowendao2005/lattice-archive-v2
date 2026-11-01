<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue';
import { useAggregateSearchStore } from '@/stores/archive/stores/aggregateSearchStore';

const searchStore = useAggregateSearchStore();

const menuStyle = computed(() => {
  const x = Math.min(searchStore.treeContextMenu.x, window.innerWidth - 150);
  const y = Math.min(searchStore.treeContextMenu.y, window.innerHeight - 170);
  return {
    left: `${Math.max(8, x)}px`,
    top: `${Math.max(8, y)}px`,
  };
});

function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && searchStore.treeContextMenu.isOpen) {
    searchStore.closeTreeContextMenu();
  }
}

function handlePointerDown(event: PointerEvent) {
  if (!searchStore.treeContextMenu.isOpen) return;
  const target = event.target as HTMLElement | null;
  if (!target?.closest('.macos-tree-context-menu')) {
    searchStore.closeTreeContextMenu();
  }
}

onMounted(() => {
  window.addEventListener('keydown', handleKeydown);
  window.addEventListener('pointerdown', handlePointerDown);
});

onUnmounted(() => {
  window.removeEventListener('keydown', handleKeydown);
  window.removeEventListener('pointerdown', handlePointerDown);
});
</script>

<template>
  <!-- macOS Finder 极简右键菜单：Teleport 至 body 彻底摆脱弹窗 transform/backdrop-filter 容器限制，零位置偏移 -->
  <Teleport to="body">
    <div
      v-if="searchStore.treeContextMenu.isOpen"
      class="macos-tree-context-menu fixed z-[9999] min-w-[136px] select-none rounded-lg border border-white/15 bg-[#182234]/95 p-1 text-[12px] text-white/90 shadow-2xl backdrop-blur-xl"
      :style="menuStyle"
    >
      <!-- 分组 (Group) 目标菜单项 -->
      <template v-if="searchStore.treeContextMenu.targetType === 'group'">
        <div
          class="flex cursor-pointer items-center justify-between rounded-[4px] px-2.5 py-1.5 transition-colors duration-100 hover:bg-sky-500 hover:text-white"
          @click="searchStore.execTreeNewFolder(searchStore.treeContextMenu.groupId)"
        >
          <span>新建文件夹</span>
        </div>
        <div
          class="flex cursor-pointer items-center justify-between rounded-[4px] px-2.5 py-1.5 transition-colors duration-100 hover:bg-sky-500 hover:text-white"
          @click="searchStore.execTreeRename"
        >
          <span>重新命名</span>
        </div>
        <div class="my-1 border-t border-white/10" />
        <div
          class="flex cursor-pointer items-center justify-between rounded-[4px] px-2.5 py-1.5 transition-colors duration-100 hover:bg-rose-500 hover:text-white text-rose-300"
          @click="searchStore.execTreeDelete"
        >
          <span>删除</span>
        </div>
      </template>

      <!-- 文件夹 (Folder) 目标菜单项 -->
      <template v-else-if="searchStore.treeContextMenu.targetType === 'folder'">
        <div
          class="flex cursor-pointer items-center justify-between rounded-[4px] px-2.5 py-1.5 transition-colors duration-100 hover:bg-sky-500 hover:text-white"
          @click="searchStore.execTreeNewFolder(searchStore.treeContextMenu.groupId)"
        >
          <span>新建文件夹</span>
        </div>
        <div
          class="flex cursor-pointer items-center justify-between rounded-[4px] px-2.5 py-1.5 transition-colors duration-100 hover:bg-sky-500 hover:text-white"
          @click="searchStore.execTreeRename"
        >
          <span>重新命名</span>
        </div>
        <div class="my-1 border-t border-white/10" />
        <div
          class="flex cursor-pointer items-center justify-between rounded-[4px] px-2.5 py-1.5 transition-colors duration-100 hover:bg-rose-500 hover:text-white text-rose-300"
          @click="searchStore.execTreeDelete"
        >
          <span>删除</span>
        </div>
      </template>

      <!-- 文件 / 会话链接 / 项目 (File / SubFile) 目标菜单项 -->
      <template v-else-if="searchStore.treeContextMenu.targetType === 'file' || searchStore.treeContextMenu.targetType === 'subfile'">
        <template v-if="searchStore.treeContextMenu.isUndeletable">
          <div class="px-2.5 py-1.5 text-white/35 italic">
            系统项 · 常驻
          </div>
        </template>
        <template v-else>
          <div
            class="flex cursor-pointer items-center justify-between rounded-[4px] px-2.5 py-1.5 transition-colors duration-100 hover:bg-sky-500 hover:text-white"
            @click="searchStore.execTreeRename"
          >
            <span>重新命名</span>
          </div>
          <div class="my-1 border-t border-white/10" />
          <div
            class="flex cursor-pointer items-center justify-between rounded-[4px] px-2.5 py-1.5 transition-colors duration-100 hover:bg-rose-500 hover:text-white text-rose-300"
            @click="searchStore.execTreeDelete"
          >
            <span>删除</span>
          </div>
        </template>
      </template>

      <!-- 空白区目标菜单项 -->
      <template v-else>
        <div
          class="flex cursor-pointer items-center justify-between rounded-[4px] px-2.5 py-1.5 transition-colors duration-100 hover:bg-sky-500 hover:text-white"
          @click="searchStore.execTreeNewFolder()"
        >
          <span>新建文件夹</span>
        </div>
      </template>
    </div>
  </Teleport>
</template>
