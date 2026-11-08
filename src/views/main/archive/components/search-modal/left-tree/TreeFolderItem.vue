<script setup lang="ts">
import { computed } from 'vue';
import { Check, ChevronRight, Folder, FolderOpen, FolderPlus, MessageSquare } from '@lucide/vue';
import { useAggregateSearchStore } from '@/stores/archive/stores/aggregateSearchStore';
import { countFolderItemsRecursive } from '@/stores/archive/stores/tileStore';
import { isSessionTile } from '@/stores/archive/utils/resourceManifest';
import type { FileTileData, FolderTileData } from '../../../types/tile';
import { getFileVisual } from '../../tiles/fileVisuals';

defineOptions({
  name: 'TreeFolderItem',
});

const props = defineProps<{
  folder: FolderTileData;
  selectableTarget?: boolean;
  selectedTargetType?: 'group' | 'folder';
  selectedTargetId?: string;
  sessionOnly?: boolean;
}>();

const emit = defineEmits<{
  (e: 'select-target', payload: { type: 'group' | 'folder'; id: string; groupId: string; title: string }): void;
}>();

const searchStore = useAggregateSearchStore();

const vFocusSelect = {
  mounted: (el: HTMLInputElement) => {
    el.focus();
    el.select();
  },
};

const isExpanded = computed(() => searchStore.isFolderExpanded(props.folder.id));

const isSelectedTarget = computed(
  () =>
    props.selectableTarget &&
    props.selectedTargetType === 'folder' &&
    props.selectedTargetId === props.folder.id,
);

const isDropHover = computed(
  () =>
    searchStore.dragToTree.isDragging &&
    searchStore.dragToTree.hoverTargetType === 'folder' &&
    searchStore.dragToTree.hoverTargetId === props.folder.id,
);

const totalCount = computed(() => {
  if (props.sessionOnly) {
    return countFolderItemsRecursive(
      props.folder,
      (item) => item.type === 'file' && isSessionTile(item as FileTileData) && !item.systemApp,
    );
  }
  return countFolderItemsRecursive(props.folder);
});

const subFolders = computed(
  () => props.folder.children.filter((c): c is FolderTileData => c.type === 'folder'),
);

const subFiles = computed(() => {
  const all = props.folder.children.filter((c): c is FileTileData => c.type === 'file');
  if (props.sessionOnly) {
    return all.filter((c) => !c.systemApp && isSessionTile(c));
  }
  return all;
});

function handleFolderClick() {
  searchStore.toggleFolderExpand(props.folder.id);
  if (props.selectableTarget) {
    emit('select-target', {
      type: 'folder',
      id: props.folder.id,
      groupId: props.folder.groupId,
      title: props.folder.title,
    });
  }
}

function handleQuickSubFolder(event: MouseEvent) {
  event.stopPropagation();
  const created = searchStore.execTreeNewSubFolder(props.folder.id);
  if (created && props.selectableTarget) {
    emit('select-target', {
      type: 'folder',
      id: created.id,
      groupId: created.groupId,
      title: created.title,
    });
  }
}

function onNodePointerDown(event: PointerEvent, tileId: string, title: string) {
  if (event.button !== 0) return;
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
      searchStore.startInternalTreeNodeDrag(tileId, title, moveEv.clientX, moveEv.clientY);
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

function onFolderContextMenu(event: MouseEvent) {
  event.preventDefault();
  event.stopPropagation();
  searchStore.openTreeContextMenu({
    x: event.clientX,
    y: event.clientY,
    targetType: 'folder',
    groupId: props.folder.groupId,
    folderId: props.folder.id,
    title: props.folder.title,
  });
}

function onSubFileContextMenu(event: MouseEvent, subFile: FileTileData) {
  event.preventDefault();
  event.stopPropagation();
  searchStore.openTreeContextMenu({
    x: event.clientX,
    y: event.clientY,
    targetType: 'subfile',
    groupId: props.folder.groupId,
    folderId: props.folder.id,
    fileId: subFile.id,
    title: subFile.title,
    isUndeletable: Boolean(subFile.undeletable || subFile.systemApp),
  });
}
</script>

<template>
  <div class="space-y-0.5">
    <div
      :data-tree-drop-type="'folder'"
      :data-tree-drop-id="folder.id"
      :data-tree-drop-title="folder.title"
      class="group/fnode flex cursor-pointer items-center gap-1.5 rounded-[2px] border px-1.5 py-1 transition-all duration-150"
      :class="[
        isDropHover
          ? 'border-sky-400 bg-sky-950/90 text-white ring-1 ring-sky-400 shadow-[0_0_14px_rgba(56,189,248,0.45)]'
          : isSelectedTarget
            ? 'border-amber-400/70 bg-amber-500/20 text-amber-100 ring-1 ring-amber-400/40'
            : searchStore.recentlyImportedTargetId === folder.id
              ? 'border-sky-400/60 bg-sky-500/20 text-sky-200'
              : 'border-transparent text-white/80 hover:border-white/10 hover:bg-white/[0.05]',
      ]"
      @pointerdown="onNodePointerDown($event, folder.id, folder.title)"
      @click="handleFolderClick"
      @contextmenu="onFolderContextMenu"
    >
      <ChevronRight
        class="size-3 shrink-0 text-white/35 transition-transform duration-150"
        :class="isExpanded ? 'rotate-90 text-amber-300/80' : ''"
      />
      <span
        class="flex size-[18px] shrink-0 items-center justify-center rounded-[2px] border border-amber-400/30 bg-amber-500/15 text-amber-300"
      >
        <FolderOpen v-if="isExpanded" class="size-3" :stroke-width="1.8" />
        <Folder v-else class="size-3" :stroke-width="1.8" />
      </span>

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
      <button
        type="button"
        class="hidden size-4 shrink-0 items-center justify-center rounded-[2px] text-amber-300/70 transition-colors hover:bg-amber-500/20 hover:text-amber-200 group-hover/fnode:flex"
        title="新建子文件夹"
        @click="handleQuickSubFolder"
      >
        <FolderPlus class="size-2.5" />
      </button>
      <span
        v-if="isDropHover"
        class="shrink-0 rounded-[2px] bg-sky-500 px-1.5 py-0.5 text-[10px] font-semibold text-white"
      >
        + 移入文件夹
      </span>
      <span
        v-else-if="isSelectedTarget"
        class="flex shrink-0 items-center gap-0.5 rounded-[2px] bg-amber-500/30 px-1 py-0.5 text-[9px] font-semibold text-amber-200"
      >
        <Check class="size-2.5" />
        <span>目标</span>
      </span>
      <span v-else class="shrink-0 font-mono text-[10px] text-white/35">
        {{ totalCount }}
      </span>
    </div>

    <!-- 递归子文件夹与子文件列表 -->
    <div
      class="grid transition-[grid-template-rows,opacity] duration-150 ease-out"
      :class="
        isExpanded
          ? 'grid-rows-[1fr] opacity-100'
          : 'grid-rows-[0fr] opacity-0 pointer-events-none'
      "
    >
      <div class="overflow-hidden">
        <div class="ml-3.5 space-y-0.5 border-l border-white/[0.08] py-0.5 pl-2">
          <!-- 递归嵌套子文件夹 -->
          <TreeFolderItem
            v-for="subFolder in subFolders"
            :key="subFolder.id"
            :folder="subFolder"
            :selectable-target="selectableTarget"
            :selected-target-type="selectedTargetType"
            :selected-target-id="selectedTargetId"
            :session-only="sessionOnly"
            @select-target="emit('select-target', $event)"
          />

          <!-- 子文件 -->
          <div
            v-for="subFile in subFiles"
            :key="subFile.id"
            :data-tree-drop-type="'folder'"
            :data-tree-drop-id="folder.id"
            :data-tree-drop-title="folder.title"
            class="flex cursor-grab items-center gap-1.5 rounded-[2px] px-1.5 py-1 text-[11px] text-white/65 transition-colors hover:bg-white/[0.05] hover:text-white/90 active:cursor-grabbing"
            @pointerdown="onNodePointerDown($event, subFile.id, subFile.title)"
            @contextmenu="onSubFileContextMenu($event, subFile)"
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
            <!-- 会话三态呼吸圆点提示 -->
            <span
              v-if="subFile.sessionCredentialState === 'joined'"
              class="size-1.5 shrink-0 rounded-full bg-emerald-400"
              title="已加入会话"
            />
            <span
              v-else-if="subFile.sessionCredentialState === 'temp_ephemeral'"
              class="size-1.5 shrink-0 rounded-full bg-amber-400"
              title="临时凭据（无续期）"
            />
            <span
              v-else-if="subFile.sessionCredentialState === 'temp_auto_renew'"
              class="size-1.5 shrink-0 rounded-full bg-purple-400"
              title="临时凭据（自动续期）"
            />
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
</template>
