<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue';
import { FolderPlus } from '@lucide/vue';
import { useAggregateSearchStore } from '@/stores/archive/stores/aggregateSearchStore';
import SearchCenterPane from './center-search/SearchCenterPane.vue';
import TileExplorerTree from './left-tree/TileExplorerTree.vue';
import SearchScopePane from './right-scope/SearchScopePane.vue';
import SearchModalHeader from './SearchModalHeader.vue';

const searchStore = useAggregateSearchStore();

const primaryDraggedItem = computed(() => searchStore.dragToTree.items[0] || null);
const draggedCount = computed(() => searchStore.dragToTree.items.length);

const dragGhostStyle = computed(() => {
  if (!searchStore.dragToTree.isDragging) return undefined;
  const x = searchStore.dragToTree.pointerX + 14;
  const y = searchStore.dragToTree.pointerY + 14;
  return {
    transform: `translate3d(${x}px, ${y}px, 0)`,
  };
});

function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    searchStore.closeModal();
  }
}

onMounted(() => {
  window.addEventListener('keydown', handleKeydown);
});

onUnmounted(() => {
  window.removeEventListener('keydown', handleKeydown);
});
</script>

<template>
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/25 p-2.5 backdrop-blur-[2px]"
    @click.self="searchStore.closeModal"
  >
    <!-- 聚合搜索对话框：轻盈高透亚克力 + 适度高斯模糊，保持通透感同时背景不串色 -->
    <div
      class="archive-modal-card relative flex h-[min(960px,95vh)] w-[min(1560px,97vw)] flex-col overflow-hidden rounded-[2px] border border-white/15 bg-[#0f172a]/70 text-white shadow-[inset_0_1px_0_0_rgba(255,255,255,0.14),0_24px_60px_-12px_rgba(0,0,0,0.55)] backdrop-blur-xl"
    >
      <!-- 顶栏 Header（控制左右两栏显隐与关闭） -->
      <SearchModalHeader />

      <!-- 三栏主体：左栏（文件树 Explorer） + 中栏（流式聚合搜索主栏） + 右栏（按会话控制搜索范围） -->
      <div class="flex min-h-0 flex-1 overflow-hidden">
        <TileExplorerTree />
        <SearchCenterPane />
        <SearchScopePane />
      </div>

      <!-- 跨栏拖拽幽灵浮层（硬件加速 translate3d 合成层） -->
      <div
        v-if="searchStore.dragToTree.isDragging && primaryDraggedItem"
        class="pointer-events-none fixed left-0 top-0 z-[90] flex w-[260px] items-center gap-2.5 rounded-[2px] border p-2 shadow-2xl backdrop-blur-xl will-change-transform"
        :class="
          searchStore.dragToTree.hoverTargetId
            ? 'border-sky-400 bg-sky-950/95 ring-1 ring-sky-400 shadow-[0_0_24px_rgba(56,189,248,0.5)]'
            : 'border-white/25 bg-[#0f172a]/95'
        "
        :style="dragGhostStyle"
      >
        <img
          :src="primaryDraggedItem.thumbnailUrl"
          :alt="primaryDraggedItem.title"
          class="size-10 shrink-0 rounded-[2px] border border-white/15 object-cover"
        />
        <div class="min-w-0 flex-1">
          <p class="truncate text-xs font-medium text-white">
            {{ primaryDraggedItem.title }}
          </p>
          <p
            class="mt-0.5 flex items-center gap-1 truncate text-[10px]"
            :class="searchStore.dragToTree.hoverTargetId ? 'text-sky-300 font-semibold' : 'text-white/55'"
          >
            <FolderPlus class="size-3 shrink-0" />
            <span>
              {{
                searchStore.dragToTree.hoverTargetTitle
                  ? `移入 · ${searchStore.dragToTree.hoverTargetTitle}`
                  : '拖至左侧 Explore 分组或文件夹'
              }}
            </span>
          </p>
        </div>
        <span
          v-if="draggedCount > 1"
          class="shrink-0 rounded-[2px] bg-sky-400 px-1.5 py-0.5 font-mono text-[10px] font-bold text-slate-950"
        >
          ×{{ draggedCount }}
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped>
:deep(.search-modal-scroll) {
  scrollbar-width: thin;
  scrollbar-color: rgba(255, 255, 255, 0.18) transparent;
}

:deep(.search-modal-scroll::-webkit-scrollbar) {
  width: 6px;
}

:deep(.search-modal-scroll::-webkit-scrollbar-track) {
  background: transparent;
}

:deep(.search-modal-scroll::-webkit-scrollbar-thumb) {
  background: rgba(255, 255, 255, 0.18);
}
</style>
