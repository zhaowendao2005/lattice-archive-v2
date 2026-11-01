<script setup lang="ts">
import { computed } from 'vue';
import { ChevronsDownUp, ChevronsUpDown, FolderPlus, FolderTree } from '@lucide/vue';
import { useAggregateSearchStore } from '@/stores/archive/stores/aggregateSearchStore';
import { useTileStore } from '../../../store/tileStore';
import TreeBranchNode from './TreeBranchNode.vue';
import TreeContextMenu from './TreeContextMenu.vue';

const tileStore = useTileStore();
const searchStore = useAggregateSearchStore();

const orderedGroups = computed(() =>
  [...tileStore.groups].sort((a, b) => (a.column ?? 0) - (b.column ?? 0) || a.order - b.order),
);

const totalFolderCount = computed(
  () => tileStore.tiles.filter(t => t.type === 'folder').length,
);

function handleQuickCreateFolder() {
  searchStore.execTreeNewFolder();
}

function handleBlankContextMenu(event: MouseEvent) {
  // 仅在空白区右键时触发全局新建菜单
  if ((event.target as HTMLElement)?.closest('[data-tree-drop-type]')) return;
  event.preventDefault();
  searchStore.openTreeContextMenu({
    x: event.clientX,
    y: event.clientY,
    targetType: 'blank',
    title: 'Explore',
  });
}
</script>

<template>
  <!-- 左栏：遵守无突变折叠规范，DOM 始终常驻 -->
  <aside
    class="flex min-h-0 shrink-0 flex-col overflow-hidden bg-black/15 transition-[width,max-width,opacity] duration-180 ease-out"
    :class="
      searchStore.isLeftPaneOpen
        ? 'w-[268px] max-w-[268px] border-r border-white/10 opacity-100'
        : 'w-0 max-w-0 border-r-0 opacity-0 pointer-events-none'
    "
  >
    <div class="flex h-full w-[268px] min-w-[268px] flex-col">
      <!-- 左栏次级 Header -->
      <div class="flex shrink-0 items-center justify-between border-b border-white/10 px-3.5 py-2.5">
        <div class="flex items-center gap-1.5">
          <FolderTree class="size-3.5 text-sky-400/85" :stroke-width="1.8" />
          <span class="text-[11px] font-semibold tracking-wider text-white/80">
            Explore 树状视图
          </span>
          <span class="font-mono text-[10px] text-white/35">
            {{ orderedGroups.length }}组 · {{ totalFolderCount }}夹
          </span>
        </div>

        <div class="flex items-center gap-1">
          <button
            type="button"
            class="flex size-5 items-center justify-center rounded-[2px] text-white/40 transition-colors hover:bg-white/10 hover:text-white"
            title="展开全部节点"
            @click="searchStore.expandAllTreeNodes"
          >
            <ChevronsUpDown class="size-3" />
          </button>
          <button
            type="button"
            class="flex size-5 items-center justify-center rounded-[2px] text-white/40 transition-colors hover:bg-white/10 hover:text-white"
            title="收起全部节点"
            @click="searchStore.collapseAllTreeNodes"
          >
            <ChevronsDownUp class="size-3" />
          </button>
          <button
            type="button"
            class="flex size-5 items-center justify-center rounded-[2px] text-sky-400/80 transition-colors hover:bg-sky-500/20 hover:text-sky-300"
            title="新建文件夹"
            @click="handleQuickCreateFolder"
          >
            <FolderPlus class="size-3" />
          </button>
        </div>
      </div>

      <!-- 树形目录滚动区（右键空白处弹出新建文件夹菜单） -->
      <div
        class="search-modal-scroll min-h-0 flex-1 space-y-1.5 overflow-y-auto p-2.5"
        @contextmenu="handleBlankContextMenu"
      >
        <TreeBranchNode
          v-for="group in orderedGroups"
          :key="group.id"
          :group="group"
        />
      </div>

      <!-- macOS 风格上下文菜单挂载点（零本地 ref，由 store 响应式驱动） -->
      <TreeContextMenu />

      <!-- 底部拖拽引导状态条 -->
      <div
        class="shrink-0 border-t px-3 py-2 text-[11px] transition-colors duration-150"
        :class="
          searchStore.dragToTree.isDragging
            ? 'border-sky-400/50 bg-sky-500/20 text-sky-200'
            : 'border-white/10 bg-white/[0.02] text-white/40'
        "
      >
        <p class="truncate text-center">
          {{
            searchStore.dragToTree.isDragging
              ? searchStore.dragToTree.hoverTargetTitle
                ? `松手归入「${searchStore.dragToTree.hoverTargetTitle}」`
                : '将卡片拖至上方任意分组或文件夹节点'
              : '支持将右侧选中结果拖入分组或文件夹'
          }}
        </p>
      </div>
    </div>
  </aside>
</template>
