<script setup lang="ts">
import { computed } from 'vue';
import { Check, ChevronRight, Database, FolderPlus, LayoutGrid, MessageSquare, Search } from '@lucide/vue';
import { useAggregateSearchStore } from '@/stores/archive/stores/aggregateSearchStore';
import { useTileStore } from '@/stores/archive/stores/tileStore';
import type { FileTileData, FolderTileData, TileGroupData } from '../../../types/tile';
import { getFileVisual } from '../../tiles/fileVisuals';
import TreeFolderItem from './TreeFolderItem.vue';

const props = defineProps<{
  group: TileGroupData;
  selectableTarget?: boolean;
  selectedTargetType?: 'group' | 'folder';
  selectedTargetId?: string;
}>();

const emit = defineEmits<{
  (e: 'select-target', payload: { type: 'group' | 'folder'; id: string; groupId: string; title: string }): void;
}>();

const tileStore = useTileStore();
const searchStore = useAggregateSearchStore();

/** 传统资源管理器式行内重命名：自动聚焦并全选现有文本 */
const vFocusSelect = {
  mounted: (el: HTMLInputElement) => {
    el.focus();
    el.select();
  },
};

const groupTiles = computed(() =>
  tileStore.tiles.filter((t) => t.groupId === props.group.id),
);

const foldersInGroup = computed(
  () => groupTiles.value.filter((t): t is FolderTileData => t.type === 'folder'),
);

const filesInGroup = computed(
  () => groupTiles.value.filter((t): t is FileTileData => t.type === 'file'),
);

const isGroupOpen = computed(() => searchStore.isGroupExpanded(props.group.id));

const isSelectedTarget = computed(
  () =>
    props.selectableTarget &&
    props.selectedTargetType === 'group' &&
    props.selectedTargetId === props.group.id,
);

const isGroupDropHover = computed(
  () =>
    searchStore.dragToTree.isDragging &&
    searchStore.dragToTree.hoverTargetType === 'group' &&
    searchStore.dragToTree.hoverTargetId === props.group.id,
);

const isGroupJustImported = computed(
  () => searchStore.recentlyImportedTargetId === props.group.id,
);

function handleGroupClick() {
  searchStore.toggleGroupExpand(props.group.id);
  if (props.selectableTarget) {
    emit('select-target', {
      type: 'group',
      id: props.group.id,
      groupId: props.group.id,
      title: props.group.title,
    });
  }
}

function handleQuickFolderInGroup(event: MouseEvent) {
  event.stopPropagation();
  const created = searchStore.execTreeNewFolder(props.group.id);
  if (created && props.selectableTarget) {
    emit('select-target', {
      type: 'folder',
      id: created.id,
      groupId: created.groupId,
      title: created.title,
    });
  }
}

function onFilePointerDown(event: PointerEvent, file: FileTileData) {
  if (event.button !== 0 || file.undeletable || file.systemApp) return;
  if ((event.target as HTMLElement)?.closest('input,button')) return;
  const startX = event.clientX;
  const startY = event.clientY;
  let started = false;

  const cleanup = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
  };

  const onMove = (moveEv: PointerEvent) => {
    if (!started) {
      if (Math.abs(moveEv.clientX - startX) < 6 && Math.abs(moveEv.clientY - startY) < 6) return;
      started = true;
      searchStore.startInternalTreeNodeDrag(file.id, file.title, moveEv.clientX, moveEv.clientY);
    }
    searchStore.updateDragToTreePointer(moveEv.clientX, moveEv.clientY);
  };

  const onUp = () => {
    cleanup();
    if (started) {
      searchStore.finishDragToTree();
    }
  };

  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
}

function onGroupContextMenu(event: MouseEvent) {
  event.preventDefault();
  event.stopPropagation();
  searchStore.openTreeContextMenu({
    x: event.clientX,
    y: event.clientY,
    targetType: 'group',
    groupId: props.group.id,
    title: props.group.title,
  });
}

function onFileContextMenu(event: MouseEvent, file: FileTileData) {
  event.preventDefault();
  event.stopPropagation();
  searchStore.openTreeContextMenu({
    x: event.clientX,
    y: event.clientY,
    targetType: 'file',
    groupId: file.groupId,
    fileId: file.id,
    title: file.title,
    isUndeletable: Boolean(file.undeletable || file.systemApp),
  });
}
</script>

<template>
  <div class="select-none">
    <!-- L0: 分组节点 (Group Node - 可作为拖拽落点与右键上下文) -->
    <div
      :data-tree-drop-type="'group'"
      :data-tree-drop-id="group.id"
      :data-tree-drop-title="group.title"
      class="group/gnode relative flex cursor-pointer items-center gap-1.5 rounded-[2px] border px-2 py-1.5 transition-all duration-150"
      :class="[
        isGroupDropHover
          ? 'border-sky-400 bg-sky-950/85 text-white ring-1 ring-sky-400 shadow-[0_0_16px_rgba(56,189,248,0.4)]'
          : isSelectedTarget
            ? 'border-sky-400/70 bg-sky-500/20 text-sky-100 ring-1 ring-sky-400/40'
            : isGroupJustImported
              ? 'border-sky-400/60 bg-sky-500/20 text-sky-200'
              : 'border-transparent bg-white/[0.03] text-white/85 hover:border-white/10 hover:bg-white/[0.07]',
      ]"
      @click="handleGroupClick"
      @contextmenu="onGroupContextMenu"
    >
      <ChevronRight
        class="size-3.5 shrink-0 text-white/40 transition-transform duration-150"
        :class="isGroupOpen ? 'rotate-90 text-sky-400/80' : ''"
      />
      <span
        class="flex size-[18px] shrink-0 items-center justify-center rounded-[2px] border border-sky-400/25 bg-sky-500/15 text-sky-300"
      >
        <LayoutGrid class="size-3" :stroke-width="1.9" />
      </span>
      <template
        v-if="
          searchStore.editingTreeNode.isEditing &&
          searchStore.editingTreeNode.targetType === 'group' &&
          searchStore.editingTreeNode.id === group.id
        "
      >
        <input
          v-focus-select
          :value="searchStore.editingTreeNode.title"
          class="h-[22px] min-w-0 flex-1 rounded-[2px] border border-sky-400/80 bg-slate-900/90 px-1.5 py-0 text-[12px] font-medium text-white shadow-[0_0_8px_rgba(56,189,248,0.25)] outline-none ring-1 ring-sky-400"
          @input="searchStore.updateEditingTreeTitle(($event.target as HTMLInputElement).value)"
          @keydown.enter.prevent="searchStore.commitTreeInlineRename"
          @keydown.esc.prevent="searchStore.cancelTreeInlineRename"
          @blur="searchStore.commitTreeInlineRename"
          @click.stop
        />
      </template>
      <span v-else class="min-w-0 flex-1 truncate text-[12px] font-medium tracking-wide">
        {{ group.title }}
      </span>
      <button
        type="button"
        class="hidden size-4 shrink-0 items-center justify-center rounded-[2px] text-sky-300/70 transition-colors hover:bg-sky-500/20 hover:text-sky-200 group-hover/gnode:flex"
        title="在此分组下新建文件夹"
        @click="handleQuickFolderInGroup"
      >
        <FolderPlus class="size-3" />
      </button>
      <span
        v-if="isGroupDropHover"
        class="shrink-0 rounded-[2px] bg-sky-500 px-1.5 py-0.5 text-[10px] font-semibold text-white"
      >
        + 归入分组
      </span>
      <span
        v-else-if="isSelectedTarget"
        class="flex shrink-0 items-center gap-0.5 rounded-[2px] bg-sky-500/30 px-1 py-0.5 text-[9px] font-semibold text-sky-200"
      >
        <Check class="size-2.5" />
        <span>目标</span>
      </span>
      <span
        v-else
        class="shrink-0 rounded-[2px] border border-white/10 bg-white/[0.04] px-1 py-0.2 font-mono text-[10px] text-white/40"
      >
        {{ groupTiles.length }}
      </span>
    </div>

    <!-- L1: 分组下属递归文件夹树与顶层文件 -->
    <div
      class="grid transition-[grid-template-rows,opacity] duration-150 ease-out"
      :class="isGroupOpen ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0 pointer-events-none'"
    >
      <div class="overflow-hidden">
        <div
          class="relative ml-3.5 mt-1 space-y-0.5 border-l pl-2.5 transition-colors"
          :class="isGroupDropHover ? 'border-sky-400/60' : 'border-white/10'"
        >
          <!-- L1-A: 无限递归文件夹节点 -->
          <TreeFolderItem
            v-for="folder in foldersInGroup"
            :key="folder.id"
            :folder="folder"
            :selectable-target="selectableTarget"
            :selected-target-type="selectedTargetType"
            :selected-target-id="selectedTargetId"
            @select-target="emit('select-target', $event)"
          />

          <!-- L1-B: 分组下属顶层文件磁贴 -->
          <div
            v-for="file in filesInGroup"
            :key="file.id"
            :data-tree-drop-type="'group'"
            :data-tree-drop-id="group.id"
            :data-tree-drop-title="group.title"
            class="flex items-center gap-1.5 rounded-[2px] px-1.5 py-1 text-[11px] text-white/70 transition-colors hover:bg-white/[0.05] hover:text-white/95"
            :class="!file.undeletable && !file.systemApp ? 'cursor-grab active:cursor-grabbing' : ''"
            @pointerdown="onFilePointerDown($event, file)"
            @contextmenu="onFileContextMenu($event, file)"
          >
            <span class="size-3 shrink-0" />
            <span
              class="flex size-[18px] shrink-0 items-center justify-center rounded-[2px]"
              :class="
                file.systemApp === 'aggregate-search'
                  ? 'border border-sky-400/35 bg-sky-500/20 text-sky-300'
                  : file.systemApp === 'session-manager'
                    ? 'border border-teal-400/35 bg-teal-500/20 text-teal-300'
                    : file.isSessionLink || file.sessionId
                      ? 'border border-sky-400/35 bg-sky-500/20 text-sky-300'
                      : getFileVisual(file.fileType).tint
              "
            >
              <Search
                v-if="file.systemApp === 'aggregate-search'"
                class="size-3 text-sky-300"
                :stroke-width="2"
              />
              <Database
                v-else-if="file.systemApp === 'session-manager'"
                class="size-3 text-teal-300"
                :stroke-width="2"
              />
              <MessageSquare
                v-else-if="file.isSessionLink || file.sessionId"
                class="size-3 text-sky-300"
                :stroke-width="2"
              />
              <component
                v-else
                :is="getFileVisual(file.fileType).icon"
                class="size-3"
                :class="getFileVisual(file.fileType).color"
                :stroke-width="1.8"
              />
            </span>
            <template
              v-if="
                searchStore.editingTreeNode.isEditing &&
                searchStore.editingTreeNode.targetType === 'file' &&
                searchStore.editingTreeNode.id === file.id
              "
            >
              <input
                v-focus-select
                :value="searchStore.editingTreeNode.title"
                class="h-[20px] min-w-0 flex-1 rounded-[2px] border border-sky-400/80 bg-slate-900/90 px-1.5 py-0 text-[11px] text-white shadow-[0_0_8px_rgba(56,189,248,0.25)] outline-none ring-1 ring-sky-400"
                @input="searchStore.updateEditingTreeTitle(($event.target as HTMLInputElement).value)"
                @keydown.enter.prevent="searchStore.commitTreeInlineRename"
                @keydown.esc.prevent="searchStore.cancelTreeInlineRename"
                @blur="searchStore.commitTreeInlineRename"
                @click.stop
              />
            </template>
            <span v-else class="min-w-0 flex-1 truncate">{{ file.title }}</span>
            <!-- 会话磁贴三态状态圆点 -->
            <span
              v-if="file.sessionCredentialState === 'joined'"
              class="size-1.5 shrink-0 rounded-full bg-emerald-400"
              title="已加入会话"
            />
            <span
              v-else-if="file.sessionCredentialState === 'temp_ephemeral'"
              class="size-1.5 shrink-0 rounded-full bg-amber-400"
              title="临时凭据（无续期）"
            />
            <span
              v-else-if="file.sessionCredentialState === 'temp_auto_renew'"
              class="size-1.5 shrink-0 rounded-full bg-purple-400"
              title="临时凭据（自动续期）"
            />
            <span
              class="shrink-0 font-mono text-[9px] uppercase"
              :class="
                file.systemApp
                  ? 'text-sky-400/70'
                  : file.isSessionLink || file.sessionId
                    ? 'text-sky-300 font-semibold'
                    : 'text-white/30'
              "
            >
              {{ file.systemApp ? 'SYS' : file.isSessionLink || file.sessionId ? 'SESSION' : file.extension || file.fileType }}
            </span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
