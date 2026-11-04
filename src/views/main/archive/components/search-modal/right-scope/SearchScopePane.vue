<script setup lang="ts">
import { FolderTree, KeyRound, Radar, RotateCcw, Users } from '@lucide/vue';
import { useAggregateSearchStore } from '@/stores/archive/stores/aggregateSearchStore';
import ExploreScopeView from './ExploreScopeView.vue';
import ScopeSessionItem from './ScopeSessionItem.vue';

const searchStore = useAggregateSearchStore();

function handleApplyScopeSearch() {
  void searchStore.executeStreamingSearch();
}
</script>

<template>
  <!-- 右栏：搜索范围控制（按会话维度），严格遵循无突变折叠规范 -->
  <aside
    class="flex min-h-0 shrink-0 flex-col overflow-hidden bg-black/15 transition-[width,max-width,opacity] duration-180 ease-out"
    :class="
      searchStore.isRightPaneOpen
        ? 'w-[308px] max-w-[308px] border-l border-white/10 opacity-100'
        : 'w-0 max-w-0 border-l-0 opacity-0 pointer-events-none'
    "
  >
    <div class="flex h-full w-[308px] min-w-[308px] flex-col">
      <!-- 右栏专属 Header：标题 + 两类会话切换 -->
      <header class="shrink-0 border-b border-white/10 px-3.5 py-2.5">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-1.5">
            <Radar class="size-3.5 text-sky-400" :stroke-width="1.8" />
            <span class="text-[11px] font-semibold tracking-wider text-white/85">
              搜索范围控制 · 按会话
            </span>
          </div>
          <span class="font-mono text-[10px] text-white/40">
            {{
              searchStore.selectedScopeSessionIds.length > 0
                ? `已限定 ${searchStore.selectedScopeSessionIds.length} 项`
                : '默认全部会话'
            }}
          </span>
        </div>

        <!-- Header 内三类会话分段切换：1. 已加入  2. 只有凭据  3. Explore -->
        <div class="mt-2.5 grid grid-cols-3 gap-1 rounded-[2px] border border-white/10 bg-black/30 p-0.5">
          <button
            type="button"
            class="flex items-center justify-center gap-1 rounded-[2px] py-1.5 text-[11px] font-medium transition-colors"
            :class="
              searchStore.activeScopeTab === 'joined'
                ? 'bg-sky-500/25 text-sky-200 border border-sky-400/40'
                : 'border border-transparent text-white/50 hover:text-white/85'
            "
            @click="searchStore.setScopeTab('joined')"
          >
            <Users class="size-3" :stroke-width="1.9" />
            <span>已加入</span>
            <span
              class="rounded-[2px] px-1 font-mono text-[9px]"
              :class="
                searchStore.selectedJoinedCount > 0
                  ? 'bg-sky-400 text-slate-950 font-semibold'
                  : 'bg-white/10 text-white/50'
              "
            >
              {{
                searchStore.selectedJoinedCount > 0
                  ? `${searchStore.selectedJoinedCount}/${searchStore.joinedScopeSessions.length}`
                  : searchStore.joinedScopeSessions.length
              }}
            </span>
          </button>

          <button
            type="button"
            class="flex items-center justify-center gap-1 rounded-[2px] py-1.5 text-[11px] font-medium transition-colors"
            :class="
              searchStore.activeScopeTab === 'credential_only'
                ? 'bg-amber-500/20 text-amber-200 border border-amber-400/40'
                : 'border border-transparent text-white/50 hover:text-white/85'
            "
            @click="searchStore.setScopeTab('credential_only')"
          >
            <KeyRound class="size-3" :stroke-width="1.9" />
            <span>只有凭据</span>
            <span
              class="rounded-[2px] px-1 font-mono text-[9px]"
              :class="
                searchStore.selectedCredentialCount > 0
                  ? 'bg-amber-400 text-slate-950 font-semibold'
                  : 'bg-white/10 text-white/50'
              "
            >
              {{
                searchStore.selectedCredentialCount > 0
                  ? `${searchStore.selectedCredentialCount}/${searchStore.credentialOnlyScopeSessions.length}`
                  : searchStore.credentialOnlyScopeSessions.length
              }}
            </span>
          </button>

          <button
            type="button"
            class="flex items-center justify-center gap-1 rounded-[2px] py-1.5 text-[11px] font-medium transition-colors"
            :class="
              searchStore.activeScopeTab === 'explore'
                ? 'bg-sky-500/25 text-sky-200 border border-sky-400/40'
                : 'border border-transparent text-white/50 hover:text-white/85'
            "
            @click="searchStore.setScopeTab('explore')"
          >
            <FolderTree class="size-3" :stroke-width="1.9" />
            <span>Explore</span>
            <span
              class="rounded-[2px] px-1 font-mono text-[9px]"
              :class="
                searchStore.selectedExploreCount > 0
                  ? 'bg-sky-400 text-slate-950 font-semibold'
                  : 'bg-white/10 text-white/50'
              "
            >
              {{
                searchStore.selectedExploreCount > 0
                  ? `${searchStore.selectedExploreCount}/${searchStore.allExploreSessionIds.length}`
                  : searchStore.allExploreSessionIds.length
              }}
            </span>
          </button>
        </div>
      </header>

      <!-- 分类说明与批量选择工具条 -->
      <div class="flex shrink-0 items-center justify-between border-b border-white/[0.06] bg-white/[0.02] px-3.5 py-1.5 text-[10px]">
        <span class="truncate text-white/45">
          {{
            searchStore.activeScopeTab === 'joined'
              ? '已加入会话'
              : searchStore.activeScopeTab === 'credential_only'
                ? '凭据会话'
                : 'Explore 归类'
          }}
        </span>
        <div class="flex shrink-0 items-center gap-2">
          <button
            type="button"
            class="text-sky-300/80 transition-colors hover:text-sky-300"
            @click="searchStore.selectAllCurrentTabSessions"
          >
            全选本类
          </button>
          <button
            type="button"
            class="text-white/45 transition-colors hover:text-white/80"
            @click="searchStore.clearCurrentTabSessions"
          >
            清空本类
          </button>
        </div>
      </div>

      <!-- 会话范围列表滚动容器（变高虚拟窗口：凭据过期行更高，用前缀偏移定位） -->
      <div
        :ref="searchStore.bindScopeViewport"
        class="search-modal-scroll min-h-0 flex-1 overflow-y-auto p-2.5 [overflow-anchor:none]"
      >
        <ExploreScopeView v-if="searchStore.activeScopeTab === 'explore'" />
        <div
          v-else
          :style="{ paddingTop: `${searchStore.scopePaddingTop}px`, paddingBottom: `${searchStore.scopePaddingBottom}px` }"
        >
          <div
            v-for="session in searchStore.virtualScopeSessions"
            :key="session.id"
            class="pb-2"
            :style="{ height: `${searchStore.scopeRowHeightOf(session)}px` }"
          >
            <ScopeSessionItem
              :session="session"
              :selected="searchStore.selectedScopeSessionIds.includes(session.id)"
              :avatar-url="searchStore.scopeAvatarUrls[session.id]"
              @toggle="searchStore.toggleScopeSession"
            />
          </div>
        </div>
      </div>

      <!-- 右栏底部：立即按所选会话范围检索与重置 -->
      <div class="flex shrink-0 items-center gap-2 border-t border-white/10 p-2.5">
        <button
          type="button"
          class="flex h-8 flex-1 items-center justify-center rounded-[2px] bg-sky-500/85 px-3 text-[11px] font-medium text-white transition-colors hover:bg-sky-500"
          @click="handleApplyScopeSearch"
        >
          按此会话范围重新搜索
        </button>
        <button
          type="button"
          class="flex size-8 shrink-0 items-center justify-center rounded-[2px] border border-white/10 text-white/50 transition-colors hover:border-white/25 hover:text-white"
          title="清空全部会话范围限定"
          @click="searchStore.clearAllScopeSessions"
        >
          <RotateCcw class="size-3.5" />
        </button>
      </div>
    </div>
  </aside>
</template>
