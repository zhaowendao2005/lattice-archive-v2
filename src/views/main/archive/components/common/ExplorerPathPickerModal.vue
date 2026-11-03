<script setup lang="ts">
import { computed } from 'vue';
import { Check, FolderInput, FolderPlus, FolderTree, X } from '@lucide/vue';
import { useAggregateSearchStore } from '@/stores/archive/stores/aggregateSearchStore';
import { useTileStore } from '@/stores/archive/stores/tileStore';
import TileExplorerTree from '../search-modal/left-tree/TileExplorerTree.vue';

const tileStore = useTileStore();
const searchStore = useAggregateSearchStore();

const picker = computed(() => tileStore.explorerPickerState);

const targetTitleLabel = computed(() => {
  const { selectedTargetType, selectedTargetId } = picker.value;
  if (selectedTargetType === 'folder') {
    const folder = tileStore.allFoldersFlat.find((f) => f.id === selectedTargetId);
    if (folder) return folder.pathLabel;
  }
  const group = tileStore.groups.find((g) => g.id === selectedTargetId);
  return group ? `${group.title} (分组根目录)` : '未选择';
});

function handleSelectTarget(payload: {
  type: 'group' | 'folder';
  id: string;
  groupId: string;
  title: string;
}) {
  tileStore.selectExplorerTarget(payload.type, payload.id);
}

function handleCreateNewFolderHere() {
  const { selectedTargetType, selectedTargetId } = picker.value;
  if (selectedTargetType === 'folder' && selectedTargetId) {
    const sub = searchStore.execTreeNewSubFolder(selectedTargetId);
    if (sub) {
      tileStore.selectExplorerTarget('folder', sub.id);
    }
    return;
  }
  const groupId = selectedTargetId || tileStore.groups[0]?.id || 'group-common';
  const folder = searchStore.execTreeNewFolder(groupId);
  if (folder) {
    tileStore.selectExplorerTarget('folder', folder.id);
  }
}

function handleConfirmMove() {
  tileStore.confirmExplorerPickerMove();
}
</script>

<template>
  <Transition name="archive-pop">
    <div
      v-if="picker.isOpen"
      class="fixed inset-0 z-[9500] flex items-center justify-center bg-black/45 p-4 backdrop-blur-[2px] select-none"
      @click.self="tileStore.closeExplorerPicker"
    >
      <div
        class="archive-modal-card flex h-[min(640px,86vh)] w-[min(560px,94vw)] flex-col overflow-hidden rounded-[2px] border border-white/15 bg-[#0f172a]/85 text-white shadow-[inset_0_1px_0_0_rgba(255,255,255,0.14),0_28px_72px_-12px_rgba(0,0,0,0.75)] backdrop-blur-2xl"
      >
        <!-- Header -->
        <header class="flex shrink-0 items-center justify-between border-b border-white/10 bg-black/25 px-4 py-3">
          <div class="flex items-center gap-2.5">
            <span class="flex size-7 items-center justify-center rounded-[2px] border border-sky-400/35 bg-sky-500/20 text-sky-300">
              <FolderTree class="size-4" :stroke-width="1.85" />
            </span>
            <div>
              <h2 class="text-[13px] font-semibold tracking-wide text-white/95">
                Explore 资源管理器 · 选择目标归档位置
              </h2>
              <p class="text-[11px] text-white/45">
                准备移动 {{ picker.tileIds.length }} 项磁贴 · 支持直接新建文件夹、行内重命名与拖拽调整
              </p>
            </div>
          </div>

          <button
            type="button"
            class="flex size-7 items-center justify-center rounded-[2px] border border-white/10 text-white/45 transition-colors hover:border-white/25 hover:bg-white/10 hover:text-white"
            title="关闭"
            @click="tileStore.closeExplorerPicker"
          >
            <X class="size-3.5" />
          </button>
        </header>

        <!-- Universal Explorer Tree Body -->
        <div class="flex min-h-0 flex-1 flex-col overflow-hidden">
          <TileExplorerTree
            :is-open="true"
            :full-width="true"
            :selectable-target="true"
            :selected-target-type="picker.selectedTargetType"
            :selected-target-id="picker.selectedTargetId"
            footer-hint="单击分组或文件夹设为目标路径 · 右键或点击 + 可新建文件夹"
            class="flex-1"
            @select-target="handleSelectTarget"
          />
        </div>

        <!-- Footer -->
        <footer class="flex shrink-0 items-center justify-between gap-3 border-t border-white/10 bg-black/30 px-4 py-3">
          <button
            type="button"
            class="flex items-center gap-1.5 rounded-[2px] border border-amber-400/35 bg-amber-500/15 px-2.5 py-1.5 text-xs font-medium text-amber-200 transition-colors hover:bg-amber-500/25 hover:text-white"
            @click="handleCreateNewFolderHere"
          >
            <FolderPlus class="size-3.5" />
            <span>在此处新建文件夹</span>
          </button>

          <div class="flex items-center gap-2">
            <button
              type="button"
              class="rounded-[2px] border border-white/15 bg-white/5 px-3 py-1.5 text-xs text-white/70 transition-colors hover:bg-white/10 hover:text-white"
              @click="tileStore.closeExplorerPicker"
            >
              取消
            </button>
            <button
              type="button"
              class="flex items-center gap-1.5 rounded-[2px] border border-sky-400/50 bg-sky-500/30 px-3.5 py-1.5 text-xs font-semibold text-white shadow-[0_0_14px_rgba(56,189,248,0.25)] transition-colors hover:bg-sky-500/45"
              :title="`移入：${targetTitleLabel}`"
              @click="handleConfirmMove"
            >
              <FolderInput v-if="picker.selectedTargetType === 'folder'" class="size-3.5 text-sky-200" />
              <Check v-else class="size-3.5 text-sky-200" />
              <span>确认移入 ({{ picker.tileIds.length }} 项)</span>
            </button>
          </div>
        </footer>
      </div>
    </div>
  </Transition>
</template>
