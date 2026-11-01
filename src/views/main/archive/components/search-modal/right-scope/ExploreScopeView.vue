<script setup lang="ts">
import { Check, ChevronRight, Folder, FolderOpen, MessageSquare } from '@lucide/vue';
import { useAggregateSearchStore } from '@/stores/archive/stores/aggregateSearchStore';

const searchStore = useAggregateSearchStore();

function isFolderAllSelected(sessionIds: string[]): boolean {
  if (sessionIds.length === 0) return false;
  return sessionIds.every(id => searchStore.selectedScopeSessionIds.includes(id));
}

function isFolderPartiallySelected(sessionIds: string[]): boolean {
  if (sessionIds.length === 0) return false;
  const count = sessionIds.filter(id => searchStore.selectedScopeSessionIds.includes(id)).length;
  return count > 0 && count < sessionIds.length;
}

function getFolderSelectedCount(sessionIds: string[]): number {
  return sessionIds.filter(id => searchStore.selectedScopeSessionIds.includes(id)).length;
}
</script>

<template>
  <div class="space-y-2">
    <!-- Explore 空间中归类的文件夹列表 -->
    <div
      v-for="folder in searchStore.exploreSessionFolders"
      :key="folder.id"
      class="rounded-[2px] border border-white/10 bg-white/[0.03] overflow-hidden transition-all duration-150"
      :class="isFolderAllSelected(folder.sessions.map(s => s.id)) ? 'border-sky-400/60 bg-sky-950/20' : ''"
    >
      <!-- 文件夹头部行：点击整行批量勾选此文件夹中全部会话 -->
      <div
        class="flex cursor-pointer select-none items-center justify-between p-2 hover:bg-white/[0.05] transition-colors"
        @click="searchStore.toggleExploreFolderSessions(folder.sessions.map(s => s.id))"
      >
        <div class="flex min-w-0 flex-1 items-center gap-2">
          <!-- 展开/折叠三角（阻止事件冒泡以免触发勾选） -->
          <button
            type="button"
            class="flex size-5 shrink-0 items-center justify-center rounded-[2px] text-white/40 hover:bg-white/10 hover:text-white"
            @click.stop="searchStore.toggleExploreFolderExpand(folder.id)"
          >
            <ChevronRight
              class="size-3 transition-transform duration-150"
              :class="searchStore.isExploreFolderExpanded(folder.id) ? 'rotate-90 text-amber-300' : ''"
            />
          </button>

          <span
            class="flex size-6 shrink-0 items-center justify-center rounded-[2px] border border-amber-400/30 bg-amber-500/15 text-amber-300"
          >
            <FolderOpen v-if="searchStore.isExploreFolderExpanded(folder.id)" class="size-3.5" />
            <Folder v-else class="size-3.5" />
          </span>

          <div class="min-w-0 flex-1">
            <p class="truncate text-[12px] font-medium text-white/95">
              {{ folder.title }}
            </p>
            <p class="font-mono text-[9px] text-white/40">
              {{ folder.groupTitle }} · {{ getFolderSelectedCount(folder.sessions.map(s => s.id)) }}/{{ folder.sessions.length }} 会话已选
            </p>
          </div>
        </div>

        <!-- 文件夹多选勾选框 -->
        <div
          class="ml-2 flex size-4 shrink-0 items-center justify-center rounded-[2px] border transition-colors"
          :class="[
            isFolderAllSelected(folder.sessions.map(s => s.id))
              ? 'border-sky-400 bg-sky-400 text-slate-950'
              : isFolderPartiallySelected(folder.sessions.map(s => s.id))
                ? 'border-sky-400 bg-sky-500/30 text-sky-200'
                : 'border-white/20 bg-black/30 text-transparent'
          ]"
        >
          <Check v-if="isFolderAllSelected(folder.sessions.map(s => s.id))" class="size-3" :stroke-width="2.5" />
          <span v-else-if="isFolderPartiallySelected(folder.sessions.map(s => s.id))" class="size-1.5 rounded-[1px] bg-sky-400" />
        </div>
      </div>

      <!-- 文件夹内部会话细分列表（可独立点选） -->
      <div
        v-if="searchStore.isExploreFolderExpanded(folder.id)"
        class="border-t border-white/[0.06] bg-black/20 p-1.5 space-y-1"
      >
        <div
          v-for="subSession in folder.sessions"
          :key="subSession.id"
          class="flex cursor-pointer select-none items-center justify-between rounded-[2px] px-2 py-1.5 transition-colors"
          :class="
            searchStore.selectedScopeSessionIds.includes(subSession.id)
              ? 'border border-sky-400/40 bg-sky-500/15 text-white'
              : 'border border-transparent text-white/70 hover:bg-white/[0.04] hover:text-white'
          "
          @click="searchStore.toggleScopeSession(subSession.id)"
        >
          <div class="flex min-w-0 flex-1 items-center gap-1.5">
            <MessageSquare class="size-3 shrink-0 text-sky-400/70" />
            <span class="truncate text-[11px] font-medium">{{ subSession.title }}</span>
          </div>
          <div
            class="flex size-3.5 shrink-0 items-center justify-center rounded-[2px] border transition-colors"
            :class="
              searchStore.selectedScopeSessionIds.includes(subSession.id)
                ? 'border-sky-400 bg-sky-400 text-slate-950'
                : 'border-white/20 bg-black/20 text-transparent'
            "
          >
            <Check class="size-2.5" :stroke-width="2.5" />
          </div>
        </div>
      </div>
    </div>

    <!-- Explore 空间直接位于分组下的独立会话链接 -->
    <div
      v-for="session in searchStore.exploreStandaloneSessions"
      :key="session.tileId"
      class="group relative flex cursor-pointer select-none items-center justify-between rounded-[2px] border p-2 transition-all duration-150"
      :class="
        searchStore.selectedScopeSessionIds.includes(session.id)
          ? 'border-sky-400/75 bg-sky-500/[0.16] ring-1 ring-sky-400/40'
          : 'border-white/10 bg-white/[0.03] hover:border-white/25 hover:bg-white/[0.06]'
      "
      @click="searchStore.toggleScopeSession(session.id)"
    >
      <div class="flex min-w-0 flex-1 items-center gap-2">
        <span
          class="flex size-6 shrink-0 items-center justify-center rounded-[2px] border border-sky-400/30 bg-sky-500/15 text-sky-300"
        >
          <MessageSquare class="size-3.5" />
        </span>
        <div class="min-w-0 flex-1">
          <p class="truncate text-[12px] font-medium text-white/92">
            {{ session.title }}
          </p>
          <p class="font-mono text-[9px] text-white/40">
            {{ session.groupTitle }} · 独立会话链接
          </p>
        </div>
      </div>
      <div
        class="flex size-4 shrink-0 items-center justify-center rounded-[2px] border transition-colors"
        :class="
          searchStore.selectedScopeSessionIds.includes(session.id)
            ? 'border-sky-400 bg-sky-400 text-slate-950'
            : 'border-white/20 bg-black/30 text-transparent group-hover:border-white/40'
        "
      >
        <Check class="size-3" :stroke-width="2.5" />
      </div>
    </div>

    <!-- 空态提示：若 Explore 中未归类任何会话 -->
    <div
      v-if="searchStore.exploreSessionFolders.length === 0 && searchStore.exploreStandaloneSessions.length === 0"
      class="rounded-[2px] border border-dashed border-white/15 p-4 text-center text-white/40 text-[11px]"
    >
      <p>Explore 虚拟文件系统中暂无归类的会话链接</p>
      <p class="mt-1 text-[10px] text-white/30">
        可在中栏搜索出「会话」后，向左拖拽入 Explore 分组或文件夹，即可在此一键控制范围。
      </p>
    </div>
  </div>
</template>
