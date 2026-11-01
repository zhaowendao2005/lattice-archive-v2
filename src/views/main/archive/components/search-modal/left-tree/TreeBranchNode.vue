<script setup lang="ts">
import { computed } from 'vue';
import { ChevronRight, Folder, FolderOpen, LayoutGrid, MessageSquare, Search } from '@lucide/vue';
import { useAggregateSearchStore } from '@/stores/archive/stores/aggregateSearchStore';
import { useTileStore } from '../../../store/tileStore';
import type { FileTileData, FolderTileData, TileGroupData } from '../../../types/tile';
import { getFileVisual } from '../../tiles/fileVisuals';

const props = defineProps<{
  group: TileGroupData;
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
  tileStore.tiles.filter(t => t.groupId === props.group.id),
);

const foldersInGroup = computed(
  () => groupTiles.value.filter(t => t.type === 'folder') as FolderTileData[],
);

const filesInGroup = computed(
  () => groupTiles.value.filter(t => t.type === 'file') as FileTileData[],
);

const isGroupOpen = computed(() => searchStore.isGroupExpanded(props.group.id));

const isGroupDropHover = computed(
  () =>
    searchStore.dragToTree.isDragging &&
    searchStore.dragToTree.hoverTargetType === 'group' &&
    searchStore.dragToTree.hoverTargetId === props.group.id,
);

const isGroupJustImported = computed(
  () => searchStore.recentlyImportedTargetId === props.group.id,
);

function isFolderDropHover(folderId: string): boolean {
  return (
    searchStore.dragToTree.isDragging &&
    searchStore.dragToTree.hoverTargetType === 'folder' &&
    searchStore.dragToTree.hoverTargetId === folderId
  );
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

function onFolderContextMenu(event: MouseEvent, folder: FolderTileData) {
  event.preventDefault();
  event.stopPropagation();
  searchStore.openTreeContextMenu({
    x: event.clientX,
    y: event.clientY,
    targetType: 'folder',
    groupId: folder.groupId,
    folderId: folder.id,
    title: folder.title,
  });
}

function onSubFileContextMenu(event: MouseEvent, folder: FolderTileData, subFile: FileTileData) {
  event.preventDefault();
  event.stopPropagation();
  searchStore.openTreeContextMenu({
    x: event.clientX,
    y: event.clientY,
    targetType: 'subfile',
    groupId: folder.groupId,
    folderId: folder.id,
    fileId: subFile.id,
    title: subFile.title,
    isUndeletable: subFile.undeletable || subFile.systemApp === 'aggregate-search',
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
    isUndeletable: file.undeletable || file.systemApp === 'aggregate-search',
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
          : isGroupJustImported
            ? 'border-sky-400/60 bg-sky-500/20 text-sky-200'
            : 'border-transparent bg-white/[0.03] text-white/85 hover:border-white/10 hover:bg-white/[0.07]',
      ]"
      @click="searchStore.toggleGroupExpand(group.id)"
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
      <!-- 传统资源管理器式行内重命名输入框 vs 标题文本 -->
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
      <span
        v-if="isGroupDropHover"
        class="shrink-0 rounded-[2px] bg-sky-500 px-1.5 py-0.5 text-[10px] font-semibold text-white"
      >
        + 归入分组
      </span>
      <span
        v-else
        class="shrink-0 rounded-[2px] border border-white/10 bg-white/[0.04] px-1 py-0.2 font-mono text-[10px] text-white/40"
      >
        {{ groupTiles.length }}
      </span>
    </div>

    <!-- L1: 分组下属文件夹与顶层文件（无突变折叠容器） -->
    <div
      class="grid transition-[grid-template-rows,opacity] duration-150 ease-out"
      :class="isGroupOpen ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0 pointer-events-none'"
    >
      <div class="overflow-hidden">
        <div
          class="relative ml-3.5 mt-1 space-y-0.5 border-l pl-2.5 transition-colors"
          :class="isGroupDropHover ? 'border-sky-400/60' : 'border-white/10'"
        >
          <!-- L1-A: 文件夹节点 (Folder Node - 可作为拖拽落点与右键上下文) -->
          <div v-for="folder in foldersInGroup" :key="folder.id" class="space-y-0.5">
            <div
              :data-tree-drop-type="'folder'"
              :data-tree-drop-id="folder.id"
              :data-tree-drop-title="folder.title"
              class="flex cursor-pointer items-center gap-1.5 rounded-[2px] border px-1.5 py-1 transition-all duration-150"
              :class="[
                isFolderDropHover(folder.id)
                  ? 'border-sky-400 bg-sky-950/90 text-white ring-1 ring-sky-400 shadow-[0_0_14px_rgba(56,189,248,0.45)]'
                  : searchStore.recentlyImportedTargetId === folder.id
                    ? 'border-sky-400/60 bg-sky-500/20 text-sky-200'
                    : 'border-transparent text-white/80 hover:border-white/10 hover:bg-white/[0.05]',
              ]"
              @click="searchStore.toggleFolderExpand(folder.id)"
              @contextmenu="onFolderContextMenu($event, folder)"
            >
              <ChevronRight
                class="size-3 shrink-0 text-white/35 transition-transform duration-150"
                :class="searchStore.isFolderExpanded(folder.id) ? 'rotate-90 text-amber-300/80' : ''"
              />
              <span
                class="flex size-[18px] shrink-0 items-center justify-center rounded-[2px] border border-amber-400/30 bg-amber-500/15 text-amber-300"
              >
                <FolderOpen
                  v-if="searchStore.isFolderExpanded(folder.id)"
                  class="size-3"
                  :stroke-width="1.8"
                />
                <Folder v-else class="size-3" :stroke-width="1.8" />
              </span>
              <!-- 传统资源管理器式行内重命名输入框 vs 文件夹标题文本 -->
              <template
                v-if="
                  searchStore.editingTreeNode.isEditing &&
                  searchStore.editingTreeNode.targetType === 'folder' &&
                  searchStore.editingTreeNode.id === folder.id
                "
              >
                <input
                  v-focus-select
                  :value="searchStore.editingTreeNode.title"
                  class="h-[22px] min-w-0 flex-1 rounded-[2px] border border-sky-400/80 bg-slate-900/90 px-1.5 py-0 text-[11px] font-medium text-white shadow-[0_0_8px_rgba(56,189,248,0.25)] outline-none ring-1 ring-sky-400"
                  @input="searchStore.updateEditingTreeTitle(($event.target as HTMLInputElement).value)"
                  @keydown.enter.prevent="searchStore.commitTreeInlineRename"
                  @keydown.esc.prevent="searchStore.cancelTreeInlineRename"
                  @blur="searchStore.commitTreeInlineRename"
                  @click.stop
                />
              </template>
              <span v-else class="min-w-0 flex-1 truncate text-[11px] font-medium">
                {{ folder.title }}
              </span>
              <span
                v-if="isFolderDropHover(folder.id)"
                class="shrink-0 rounded-[2px] bg-sky-500 px-1.5 py-0.5 text-[10px] font-semibold text-white"
              >
                + 移入文件夹
              </span>
              <span v-else class="shrink-0 font-mono text-[10px] text-white/35">
                {{ folder.children.length }}
              </span>
            </div>

            <!-- L2: 文件夹内部子文件列表（无突变折叠） -->
            <div
              class="grid transition-[grid-template-rows,opacity] duration-150 ease-out"
              :class="
                searchStore.isFolderExpanded(folder.id)
                  ? 'grid-rows-[1fr] opacity-100'
                  : 'grid-rows-[0fr] opacity-0 pointer-events-none'
              "
            >
              <div class="overflow-hidden">
                <div class="ml-3.5 space-y-0.5 border-l border-white/[0.08] py-0.5 pl-2">
                  <div
                    v-for="subFile in folder.children"
                    :key="subFile.id"
                    :data-tree-drop-type="'folder'"
                    :data-tree-drop-id="folder.id"
                    :data-tree-drop-title="folder.title"
                    class="flex items-center gap-1.5 rounded-[2px] px-1.5 py-1 text-[11px] text-white/65 transition-colors hover:bg-white/[0.05] hover:text-white/90"
                    @contextmenu="onSubFileContextMenu($event, folder, subFile)"
                  >
                    <span
                      class="flex size-4 shrink-0 items-center justify-center rounded-[2px]"
                      :class="
                        subFile.isSessionLink || subFile.sessionId
                          ? 'border border-sky-400/35 bg-sky-500/20 text-sky-300'
                          : getFileVisual(subFile.fileType).tint
                      "
                    >
                      <MessageSquare
                        v-if="subFile.isSessionLink || subFile.sessionId"
                        class="size-2.5 text-sky-300"
                        :stroke-width="2"
                      />
                      <component
                        v-else
                        :is="getFileVisual(subFile.fileType).icon"
                        class="size-2.5"
                        :class="getFileVisual(subFile.fileType).color"
                        :stroke-width="1.9"
                      />
                    </span>
                    <!-- 传统资源管理器式行内重命名输入框 vs 子文件标题文本 -->
                    <template
                      v-if="
                        searchStore.editingTreeNode.isEditing &&
                        searchStore.editingTreeNode.targetType === 'subfile' &&
                        searchStore.editingTreeNode.id === subFile.id
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
                    <span v-else class="min-w-0 flex-1 truncate">{{ subFile.title }}</span>
                    <span
                      class="shrink-0 font-mono text-[9px] uppercase"
                      :class="subFile.isSessionLink || subFile.sessionId ? 'text-sky-300 font-semibold' : 'text-white/30'"
                    >
                      {{ subFile.isSessionLink || subFile.sessionId ? 'SESSION' : subFile.extension || subFile.fileType }}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- L1-B: 分组下属顶层文件磁贴 -->
          <div
            v-for="file in filesInGroup"
            :key="file.id"
            :data-tree-drop-type="'group'"
            :data-tree-drop-id="group.id"
            :data-tree-drop-title="group.title"
            class="flex items-center gap-1.5 rounded-[2px] px-1.5 py-1 text-[11px] text-white/70 transition-colors hover:bg-white/[0.05] hover:text-white/95"
            @contextmenu="onFileContextMenu($event, file)"
          >
            <span class="size-3 shrink-0" />
            <span
              class="flex size-[18px] shrink-0 items-center justify-center rounded-[2px]"
              :class="
                file.systemApp === 'aggregate-search'
                  ? 'border border-sky-400/35 bg-sky-500/20 text-sky-300'
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
            <!-- 传统资源管理器式行内重命名输入框 vs 文件标题文本 -->
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
