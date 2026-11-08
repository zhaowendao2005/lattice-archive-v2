<script setup lang="ts">
/**
 * [VIEW] 搜索机器人会话解析与收藏弹窗 (BotHarvestCandidateModal)
 * 严格遵循：
 * 1. 零本地 ref / reactive 与零直接 fetch 约束；主操作按钮永不置灰；
 * 2. 与会话管理中心 (SessionManagerModal) 及聚合搜索 (AggregateSearchModal) 完全一致的深色高透亚克力设计语言；
 * 3. 左栏搭载通用磁贴资源管理器 (TileExplorerTree)，支持点选任意分组/文件夹作为收藏目标路径、即时新建文件夹与跨栏拖拽收藏；
 * 4. 解析阶段已将群组/频道凭据存入会话管理中心（默认不自动续签），本窗口的收藏操作纯本地执行，零敏感 API 重复请求。
 */
import { computed, onMounted, onUnmounted } from 'vue';
import {
  Bot,
  Check,
  CheckCircle2,
  ExternalLink,
  Folder,
  FolderPlus,
  GripVertical,
  Info,
  KeyRound,
  LayoutGrid,
  PanelLeft,
  Search,
  Sparkles,
  Trash2,
  Users,
  X,
} from '@lucide/vue';
import { useBotHarvesterStore } from '@/stores/chat/stores/botHarvesterStore';
import { useAggregateSearchStore } from '@/stores/archive/stores/aggregateSearchStore';
import { useTileStore } from '@/stores/archive/stores/tileStore';
import type { BotHarvestCandidateItem } from '@/types/botHarvest';
import TileExplorerTree from '@/views/main/archive/components/search-modal/left-tree/TileExplorerTree.vue';

const harvesterStore = useBotHarvesterStore();
const searchStore = useAggregateSearchStore();
const tileStore = useTileStore();

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

/** 当前选中的目标路径是否为文件夹 */
const isFolderTargetSelected = computed(() => {
  if (!harvesterStore.targetExploreFolderId) return false;
  const folder = tileStore.getTileById(harvesterStore.targetExploreFolderId);
  return Boolean(folder && folder.type === 'folder');
});

/** 当前选中的收藏目标路径展示文案 */
const currentTargetPathLabel = computed(() => {
  const group =
    tileStore.groups.find((g) => g.id === harvesterStore.targetExploreGroupId) ??
    tileStore.groups[0];
  if (!group) return '默认分组';
  if (harvesterStore.targetExploreFolderId) {
    const folder = tileStore.getTileById(harvesterStore.targetExploreFolderId);
    if (folder && folder.type === 'folder') {
      return `${group.title} / ${folder.title}`;
    }
  }
  return `${group.title}（分组根目录）`;
});

function resolveKindLabel(kind?: BotHarvestCandidateItem['peerKind']): string {
  if (kind === 'channel') return '频道';
  if (kind === 'supergroup') return '超级群';
  return '群组';
}

let suppressNextCardClick = false;

function onCandidateCardClick(index: number, key: string, event: MouseEvent) {
  if (suppressNextCardClick) {
    suppressNextCardClick = false;
    return;
  }
  harvesterStore.handleCandidateCardClick(index, key, event);
}

function onCandidateCardPointerDown(item: BotHarvestCandidateItem, event: PointerEvent) {
  if (event.button !== 0) return;
  const target = event.target as HTMLElement | null;
  if (target?.closest('button, input, a, select')) return;
  const startX = event.clientX;
  const startY = event.clientY;
  let dragStarted = false;

  const cleanup = () => {
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerUp);
  };

  const onPointerMove = (moveEvent: PointerEvent) => {
    if (!dragStarted) {
      if (
        Math.abs(moveEvent.clientX - startX) < 5 &&
        Math.abs(moveEvent.clientY - startY) < 5
      ) {
        return;
      }
      dragStarted = true;
      suppressNextCardClick = true;
      window.setTimeout(() => {
        suppressNextCardClick = false;
      }, 0);
      harvesterStore.startDragCandidatesToTree(item, moveEvent.clientX, moveEvent.clientY);
    }
    searchStore.updateDragToTreePointer(moveEvent.clientX, moveEvent.clientY);
  };

  const onPointerUp = () => {
    cleanup();
    if (dragStarted) {
      searchStore.finishDragToTree();
    }
  };

  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && harvesterStore.isCandidateModalOpen) {
    harvesterStore.closeCandidateModal();
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
  <Teleport to="body">
    <Transition name="fade">
      <div
        v-if="harvesterStore.isCandidateModalOpen"
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/25 p-2.5 backdrop-blur-[2px]"
        @click.self="harvesterStore.closeCandidateModal()"
      >
        <!-- 会话解析与收藏面板：与会话管理中心和聚合搜索一致的深色高透亚克力面板 -->
        <div
          role="dialog"
          aria-modal="true"
          aria-label="已解析的群组与频道"
          class="archive-modal-card relative flex h-[min(960px,95vh)] w-[min(1560px,97vw)] flex-col overflow-hidden rounded-[2px] border border-white/15 bg-[#0f172a]/70 text-white shadow-[inset_0_1px_0_0_rgba(255,255,255,0.14),0_24px_60px_-12px_rgba(0,0,0,0.55)] backdrop-blur-xl"
        >
          <!-- 顶部 Header（与 SessionManagerModal / SearchModalHeader 保持视觉统一） -->
          <header class="flex shrink-0 flex-wrap items-center gap-2.5 border-b border-white/10 bg-black/20 px-4 py-2.5">
            <!-- 应用方角徽标 -->
            <span
              class="flex size-[26px] shrink-0 items-center justify-center rounded-[2px] border border-sky-400/35 bg-sky-500/15 text-sky-300 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.18)]"
            >
              <Bot class="size-3.5" :stroke-width="2" />
            </span>

            <!-- 标题与操作提示 -->
            <div class="flex min-w-0 items-center gap-2">
              <h2 class="truncate text-[14px] font-medium tracking-wide text-white/92">
                已解析的群组 / 频道 ({{ harvesterStore.candidates.length }})
              </h2>

              <span
                class="hidden sm:inline-flex items-center gap-1 rounded-[2px] border border-emerald-400/35 bg-emerald-500/15 px-1.5 py-0.5 font-mono text-[10px] text-emerald-300"
              >
                <KeyRound class="size-2.5" />
                <span>凭据已入会话管理中心 · 收藏零重复申领</span>
              </span>

              <div class="group relative flex items-center">
                <button
                  type="button"
                  class="flex size-5 items-center justify-center rounded-[2px] text-white/40 transition-colors hover:bg-white/10 hover:text-white/80 focus:outline-none"
                  title="操作提示"
                  aria-label="操作提示"
                >
                  <Info class="size-3.5" :stroke-width="1.8" />
                </button>

                <div
                  class="pointer-events-none absolute left-0 top-full z-[100] mt-1.5 hidden w-88 rounded-[4px] border border-white/15 bg-[#141e30]/95 p-2.5 shadow-2xl backdrop-blur-xl group-hover:block transition-all duration-150"
                >
                  <div class="flex items-center gap-1.5 text-[11px] font-medium text-sky-300">
                    <Info class="size-3" />
                    <span>零重复申领与 Explore 收藏提示</span>
                  </div>
                  <p class="mt-1 font-mono text-[10px] leading-relaxed text-white/70">
                    解析完成的群组/频道已自动存入会话管理中心（默认不自动续签） · 点击左栏任意分组或文件夹指定收藏位置 · 支持 Shift 连续多选与直接向左拖拽卡片归入目录
                  </p>
                </div>
              </div>
            </div>

            <!-- 收藏结果或进度横幅 -->
            <div
              v-if="harvesterStore.harvestNotice || searchStore.lastImportBannerText"
              class="flex items-center gap-1.5 rounded-[2px] border border-sky-400/40 bg-sky-500/15 px-2 py-0.5 text-[11px] text-sky-200"
            >
              <CheckCircle2 class="size-3 shrink-0 text-sky-400" />
              <span class="max-w-[360px] truncate">
                {{ harvesterStore.harvestNotice || searchStore.lastImportBannerText }}
              </span>
            </div>

            <!-- 右侧左栏 Explore 显隐控制与关闭按钮 -->
            <div class="ml-auto flex shrink-0 items-center gap-1.5">
              <button
                type="button"
                class="flex h-[26px] items-center gap-1.5 rounded-[2px] border px-2 text-[11px] transition-colors"
                :class="
                  harvesterStore.isLeftTreeOpen
                    ? 'border-sky-400/45 bg-sky-500/20 text-sky-200'
                    : 'border-white/10 bg-white/[0.03] text-white/45 hover:border-white/25 hover:text-white/85'
                "
                title="显示/隐藏左栏 Explore 磁贴目录树"
                @click="harvesterStore.toggleLeftTree()"
              >
                <PanelLeft class="size-3.5" :stroke-width="1.8" />
                <span class="hidden md:inline">Explore 目录树</span>
              </button>

              <div class="mx-0.5 h-3.5 w-px bg-white/10" />

              <button
                type="button"
                class="flex size-[26px] items-center justify-center rounded-[2px] border border-white/10 text-white/45 transition-colors hover:border-white/25 hover:bg-white/10 hover:text-white"
                title="关闭窗口 (Esc)"
                @click="harvesterStore.closeCandidateModal()"
              >
                <X class="size-3.5" :stroke-width="1.75" />
              </button>
            </div>
          </header>

          <!-- 主体双栏区：左栏通用磁贴资源管理器 (Explore) + 右侧候选会话主栏 -->
          <div class="flex min-h-0 flex-1 overflow-hidden">
            <TileExplorerTree
              :is-open="harvesterStore.isLeftTreeOpen"
              :selectable-target="true"
              :selected-target-type="harvesterStore.targetExploreFolderId ? 'folder' : 'group'"
              :selected-target-id="harvesterStore.targetExploreFolderId || harvesterStore.targetExploreGroupId"
              footer-hint="单击分组或文件夹设为收藏位置 · 支持将右侧会话卡片拖入目录"
              @select-target="harvesterStore.selectTargetFromExplorer"
            />

            <main class="flex min-w-0 flex-1 flex-col bg-black/10">
              <!-- 顶部筛选与收藏目标路径工具栏 -->
              <div class="shrink-0 border-b border-white/10 bg-white/[0.02] px-4 py-3 space-y-2.5">
                <!-- 第一行：搜索框 + 去重状态说明 + 全选/清空 -->
                <div class="flex flex-wrap items-center justify-between gap-2.5">
                  <div class="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                    <div
                      class="flex h-8 w-64 items-center gap-2 rounded-[2px] border border-white/15 bg-black/35 px-2.5 focus-within:border-sky-400/60"
                    >
                      <Search class="size-3.5 shrink-0 text-white/40" />
                      <input
                        :value="harvesterStore.candidateFilterKeyword"
                        type="text"
                        placeholder="筛选群组/频道标题或 @username…"
                        class="w-full bg-transparent text-xs text-white placeholder-white/35 outline-none"
                        @input="harvesterStore.candidateFilterKeyword = ($event.target as HTMLInputElement).value"
                      />
                    </div>

                    <span class="rounded-[2px] border border-white/10 bg-white/[0.03] px-2 py-1 text-[11px] text-white/60">
                      按真实 Telegram peer 去重 · 消息与媒体仅作为来源链接
                    </span>
                  </div>

                  <div class="flex items-center gap-1.5 text-[11px]">
                    <span class="font-mono text-white/45">
                      已选 <strong class="text-sky-300">{{ harvesterStore.selectedCandidates.length }}</strong> / {{ harvesterStore.filteredCandidates.length }}
                    </span>
                    <button
                      type="button"
                      class="h-7 rounded-[2px] border border-white/12 bg-white/[0.04] px-2.5 text-white/75 transition-colors hover:border-white/25 hover:bg-white/[0.08] hover:text-white"
                      @click="harvesterStore.selectAllFiltered()"
                    >
                      全选当前 ({{ harvesterStore.filteredCandidates.length }})
                    </button>
                    <button
                      v-if="harvesterStore.selectedCandidates.length > 0"
                      type="button"
                      class="h-7 rounded-[2px] border border-white/12 bg-white/[0.04] px-2.5 text-white/55 transition-colors hover:border-white/25 hover:text-white"
                      @click="harvesterStore.clearSelection()"
                    >
                      取消全选
                    </button>
                    <button
                      v-if="harvesterStore.candidates.length > 0"
                      type="button"
                      class="flex h-7 items-center gap-1 rounded-[2px] border border-rose-400/35 bg-rose-500/10 px-2.5 text-rose-300 transition-colors hover:bg-rose-500/20 hover:text-white"
                      @click="harvesterStore.clearPool()"
                    >
                      <Trash2 class="size-3" />
                      <span>清空列表</span>
                    </button>
                  </div>
                </div>

                <!-- 第二行：目标收藏路径指示器（联动左栏 Explore，严格区分分组与文件夹图标）+ 凭据续签策略 + 一键收藏按钮 -->
                <div class="flex flex-wrap items-center justify-between gap-2.5 border-t border-white/8 pt-2.5 text-[11px]">
                  <div class="flex flex-wrap items-center gap-2.5">
                    <!-- 当前目标路径指示器：分组使用青蓝色 LayoutGrid，文件夹使用琥珀色 Folder -->
                    <div
                      class="flex h-7 items-center gap-1.5 rounded-[2px] border px-2.5"
                      :class="
                        isFolderTargetSelected
                          ? 'border-amber-400/40 bg-amber-500/15 text-amber-100'
                          : 'border-sky-400/35 bg-sky-500/10 text-sky-200'
                      "
                      title="在左侧 Explore 目录树中点击任意分组或文件夹即可切换收藏落位路径，也可直接在左栏新建文件夹"
                    >
                      <Folder v-if="isFolderTargetSelected" class="size-3.5 shrink-0 text-amber-300" />
                      <LayoutGrid v-else class="size-3.5 shrink-0 text-sky-300" />
                      <span class="text-white/55">目标路径：</span>
                      <span class="max-w-[240px] truncate font-medium">{{ currentTargetPathLabel }}</span>
                    </div>

                    <!-- 快捷分组下拉切换 -->
                    <select
                      :value="harvesterStore.targetExploreGroupId"
                      class="h-7 rounded-[2px] border border-white/12 bg-black/40 px-2 text-[11px] text-white/85 outline-none focus:border-sky-400/50"
                      @change="
                        harvesterStore.targetExploreGroupId = ($event.target as HTMLSelectElement).value;
                        harvesterStore.targetExploreFolderId = '';
                      "
                    >
                      <option v-for="g in tileStore.groups" :key="g.id" :value="g.id" class="bg-slate-900 text-white">
                        分组：{{ g.title }}
                      </option>
                    </select>

                    <!-- 本地凭据续签策略（不触发新 RPC，仅更新凭据池属性） -->
                    <select
                      :value="harvesterStore.placementMode"
                      class="h-7 rounded-[2px] border border-white/12 bg-black/40 px-2 text-[11px] text-white/85 outline-none focus:border-sky-400/50"
                      @change="harvesterStore.placementMode = ($event.target as HTMLSelectElement).value as any"
                    >
                      <option value="temp_ephemeral" class="bg-slate-900 text-white">🟡 默认凭据 · 不自动续签 (推荐)</option>
                      <option value="temp_auto_renew" class="bg-slate-900 text-white">🔵 开启后台自动续签 (Auto-Renew)</option>
                    </select>
                  </div>

                  <div class="flex items-center gap-2">
                    <button
                      type="button"
                      class="flex h-7 items-center gap-1.5 rounded-[2px] border border-sky-400/60 bg-sky-500/25 px-3 text-[11px] font-medium text-sky-100 shadow-[inset_0_1px_0_0_rgba(56,189,248,0.3)] transition-colors hover:bg-sky-500/35"
                      @click="harvesterStore.commitSelectedCandidates()"
                    >
                      <FolderPlus class="size-3.5 text-sky-300" />
                      <span>
                        {{
                          harvesterStore.isCommitting
                            ? '正在收藏…'
                            : `一键收藏至目标路径 (${harvesterStore.selectedCandidates.length})`
                        }}
                      </span>
                    </button>
                  </div>
                </div>
              </div>

              <!-- 候选会话单列卡片流（与 SessionManagerModal 保持完全一致的结构与手感） -->
              <div class="search-modal-scroll flex-1 overflow-y-auto px-4 py-3">
                <div
                  v-if="harvesterStore.filteredCandidates.length === 0"
                  class="flex h-64 flex-col items-center justify-center rounded-[2px] border border-dashed border-white/12 bg-white/[0.01] text-center text-white/45"
                >
                  <Sparkles class="mb-2 size-8 opacity-40" />
                  <p class="text-xs font-medium text-white/70">暂无匹配的已确认群组 / 频道</p>
                  <p class="mt-1 max-w-md text-[11px] text-white/40">
                    只会收录能解析出真实 Telegram peer 的群组、超级群组或频道；个人聊天、机器人及无法确认身份的邀请链接会自动跳过
                  </p>
                </div>

                <div v-else class="space-y-1.5">
                  <article
                    v-for="(item, idx) in harvesterStore.filteredCandidates"
                    :key="item.key"
                    class="group relative flex cursor-grab select-none items-center gap-3 rounded-[2px] border p-2.5 transition-all duration-150 active:cursor-grabbing"
                    :class="
                      item.selected
                        ? 'border-sky-400/85 bg-sky-500/[0.17] ring-1 ring-sky-400/55 shadow-[inset_0_1px_0_0_rgba(56,189,248,0.28),0_6px_18px_-6px_rgba(14,165,233,0.3)]'
                        : 'border-white/10 bg-white/[0.03] hover:border-white/25 hover:bg-white/[0.06]'
                    "
                    @pointerdown="onCandidateCardPointerDown(item, $event)"
                    @click="onCandidateCardClick(idx, item.key, $event)"
                  >
                    <!-- 左端：正方形缩略图容器 (Square Thumbnail) -->
                    <div
                      class="relative aspect-square size-14 shrink-0 overflow-hidden rounded-[2px] border border-white/12 bg-black/45"
                    >
                      <img
                        v-if="item.avatarThumb"
                        :src="item.avatarThumb"
                        :alt="item.title"
                        loading="lazy"
                        class="h-full w-full object-cover transition-transform duration-200 group-hover:scale-105"
                      />
                      <div
                        v-else
                        class="flex h-full w-full items-center justify-center bg-gradient-to-br from-sky-500/25 via-slate-800 to-slate-950 text-base font-bold text-sky-200"
                      >
                        {{ item.title.slice(0, 2).toUpperCase() }}
                      </div>
                      <!-- 缩略图底部胶囊角标 -->
                      <span
                        class="absolute bottom-0.5 right-0.5 rounded-[1px] bg-black/75 px-1 py-0.2 font-mono text-[9px] text-white/85 backdrop-blur-xs"
                      >
                        {{ resolveKindLabel(item.peerKind) }}
                      </span>
                    </div>

                    <!-- 中部：Title 与结构化元数据 -->
                    <div class="min-w-0 flex-1">
                      <!-- 第一行：Title + 已在磁贴拓扑中的实时标记 + 凭据状态标签 -->
                      <div class="flex items-center gap-2">
                        <h3
                          class="min-w-0 flex-1 truncate text-[13px] font-medium tracking-wide"
                          :class="item.selected ? 'text-white' : 'text-white/92'"
                        >
                          {{ item.title }}
                        </h3>

                        <!-- 已在磁贴拓扑中的实时标记 -->
                        <span
                          v-if="item.peerKey && tileStore.archivedSourceMap.get(item.peerKey)"
                          class="flex shrink-0 items-center gap-1 rounded-[2px] border border-emerald-400/40 bg-emerald-500/15 px-1.5 py-0.5 text-[10px] text-emerald-300"
                          :title="`已归入：${tileStore.archivedSourceMap.get(item.peerKey)}`"
                        >
                          <CheckCircle2 class="size-2.5" />
                          <span class="max-w-[160px] truncate">{{ tileStore.archivedSourceMap.get(item.peerKey) }}</span>
                        </span>

                        <!-- 会话凭据态标签 -->
                        <span
                          class="shrink-0 rounded-[2px] border px-1.5 py-0.5 text-[10px]"
                          :class="
                            item.alreadyJoined
                              ? 'border-emerald-400/35 bg-emerald-500/15 text-emerald-300'
                              : 'border-amber-400/35 bg-amber-500/15 text-amber-200'
                          "
                        >
                          {{ item.alreadyJoined ? '已加入会话' : '已存凭据池 · 默认不续签' }}
                        </span>

                        <span class="shrink-0 rounded-[2px] border border-white/12 bg-white/[0.05] px-1.5 py-0.5 font-mono text-[10px] text-white/60">
                          P{{ item.sourcePage }}
                        </span>
                      </div>

                      <!-- 第二行：简介或来源链接 -->
                      <p class="mt-1 truncate text-[11px] text-white/55">
                        {{ item.about || `来源链接：${item.sourceTextSnippet}` }}
                      </p>

                      <!-- 第三行：用户名/PeerKey、成员数、来源链接 -->
                      <div class="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] text-white/40">
                        <span class="flex items-center gap-1 text-white/65">
                          <Users class="size-2.5 text-sky-300" />
                          <span class="max-w-[180px] truncate">
                            {{ item.username ? `@${item.username}` : item.peerKey }}
                          </span>
                        </span>

                        <span v-if="item.participantsCount">
                          {{ item.participantsCount.toLocaleString('zh-CN') }} 成员
                        </span>
                        <span class="truncate max-w-[260px]">{{ item.sourceTextSnippet }}</span>
                      </div>
                    </div>

                    <!-- 右端：外链预览 + 拖拽把手 + 多选高亮勾选框 -->
                    <div class="flex shrink-0 items-center gap-1.5 pl-1">
                      <a
                        :href="item.sourceTextSnippet"
                        target="_blank"
                        rel="noopener noreferrer"
                        class="flex size-7 items-center justify-center rounded-[2px] border border-white/10 bg-white/[0.03] text-white/50 transition-colors hover:border-white/25 hover:bg-white/10 hover:text-white"
                        title="在新标签页预览来源链接"
                        @click.stop
                      >
                        <ExternalLink class="size-3.5" />
                      </a>
                      <GripVertical
                        class="size-3.5 text-white/20 opacity-0 transition-opacity group-hover:opacity-100"
                      />
                      <div
                        class="flex size-4 items-center justify-center rounded-[2px] border transition-colors"
                        :class="
                          item.selected
                            ? 'border-sky-400 bg-sky-400 text-slate-950 shadow-[0_0_8px_rgba(56,189,248,0.6)]'
                            : 'border-white/20 bg-black/35 text-transparent group-hover:border-white/40'
                        "
                      >
                        <Check class="size-3" :stroke-width="2.5" />
                      </div>
                    </div>
                  </article>
                </div>
              </div>
            </main>
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
              v-if="primaryDraggedItem.thumbnailUrl"
              :src="primaryDraggedItem.thumbnailUrl"
              :alt="primaryDraggedItem.title"
              class="size-10 shrink-0 rounded-[2px] border border-white/15 object-cover"
            />
            <div
              v-else
              class="flex size-10 shrink-0 items-center justify-center rounded-[2px] border border-white/15 bg-sky-500/20 text-xs font-bold text-sky-200"
            >
              {{ primaryDraggedItem.title.slice(0, 2).toUpperCase() }}
            </div>
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
                      ? `收藏至 · ${searchStore.dragToTree.hoverTargetTitle}`
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
    </Transition>
  </Teleport>
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
