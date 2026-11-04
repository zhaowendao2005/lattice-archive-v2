<script setup lang="ts">
/**
 * [VIEW] 会话与配额治理中心全局弹窗 (SessionManagerModal)
 * 严格遵循：
 * 1. 零本地 ref / reactive 与零直接 fetch 约束；主操作按钮永不置灰；
 * 2. 与聚合搜索 (AggregateSearchModal) 完全一致的深色高透亚克力设计语言；
 * 3. 左栏搭载通用磁贴资源管理器 (TileExplorerTree)，支持点选任意分组/文件夹作为收纳路径、即时新建文件夹与跨栏拖拽归档；
 * 4. 会话列表采用与 SearchResultCard 一致的单列横向卡片布局（左端正方形缩略图 + 中部结构化元数据 + 右端拖拽把手与多选框）。
 */
import { computed, onMounted, onUnmounted } from 'vue';
import {
  Activity,
  Check,
  CheckCircle2,
  CloudUpload,
  Database,
  Download,
  Folder,
  FolderPlus,
  GripVertical,
  HardDrive,
  Info,
  KeyRound,
  Layers,
  PanelLeft,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  Trash2,
  Upload,
  Users,
  X,
  Zap,
} from '@lucide/vue';
import {
  QUOTA_RULE_LABELS,
  useSessionManagerStore,
  type SessionManagerTab,
} from '@/stores/archive/stores/sessionManagerStore';
import { useAggregateSearchStore } from '@/stores/archive/stores/aggregateSearchStore';
import type { QuotaRuleKey } from '@/stores/archive/types';
import { useTileStore } from '@/stores/archive/stores/tileStore';
import { useTelegramStore } from '@/stores/telegram/stores/telegramStore';
import { useChatMediaStore } from '@/stores/chat/stores/chatMediaStore';
import type { TgDialogDto } from '@/stores/chat/types';
import TileExplorerTree from '../search-modal/left-tree/TileExplorerTree.vue';

const sessionStore = useSessionManagerStore();
const searchStore = useAggregateSearchStore();
const tileStore = useTileStore();
const telegramStore = useTelegramStore();
const chatMediaStore = useChatMediaStore();

const TABS: { id: SessionManagerTab; label: string; badge?: () => string | number }[] = [
  { id: 'sessions', label: '全部会话与收纳', badge: () => sessionStore.filteredDialogs.length },
  { id: 'temp_pool', label: '临时会话凭据池', badge: () => sessionStore.tempCredentials.length },
  { id: 'accounts_quota', label: '多账号矩阵与配额', badge: () => telegramStore.accounts.length },
  { id: 'vault_storage', label: '私有备份群与存储' },
];

const QUOTA_KEYS: QuotaRuleKey[] = [
  'joinChannel',
  'checkChatInvite',
  'resolveUsername',
  'botCallbackPage',
  'messagesSearch',
];

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

/** 当前选中的收纳目标路径展示文案 */
const currentTargetPathLabel = computed(() => {
  const group = tileStore.groups.find((g) => g.id === sessionStore.targetGroupId) ?? tileStore.groups[0];
  if (!group) return '默认分组';
  if (sessionStore.targetFolderId) {
    const folder = tileStore.getTileById(sessionStore.targetFolderId);
    if (folder && folder.type === 'folder') {
      return `${group.title} / 📁 ${folder.title}`;
    }
  }
  return `🗂️ ${group.title}（分组根目录）`;
});

function resolveDialogAvatarUrl(dialog: TgDialogDto): string | null {
  return chatMediaStore.dialogAvatarUrl(dialog.key) ?? dialog.avatar?.thumb ?? null;
}

function resolveDialogKindLabel(kind: TgDialogDto['kind']): string {
  if (kind === 'channel') return '频道';
  if (kind === 'supergroup') return '超级群';
  if (kind === 'group') return '群组';
  if (kind === 'bot') return '机器人';
  return '私聊';
}

function formatDialogDate(unixSec?: number): string {
  if (!unixSec) return '近期活跃';
  return new Date(unixSec * 1000).toISOString().slice(0, 10);
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

let suppressNextCardClick = false;

function onSessionCardClick(index: number, key: string, event: MouseEvent) {
  if (suppressNextCardClick) {
    suppressNextCardClick = false;
    return;
  }
  sessionStore.handleSessionCardClick(index, key, event);
}

function onSessionCardPointerDown(dialog: TgDialogDto, event: PointerEvent) {
  if (event.button !== 0) return;
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
      sessionStore.startDragSessionCardToTree(dialog, moveEvent.clientX, moveEvent.clientY);
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

function onCredentialCardClick(index: number, id: string, event: MouseEvent) {
  if (suppressNextCardClick) { suppressNextCardClick = false; return; }
  sessionStore.handleCredentialClick(index, id, event);
}

function onCredentialCardPointerDown(credentialId: string, event: PointerEvent) {
  if (event.button !== 0) return;
  const target = event.target as HTMLElement | null;
  if (target?.closest('button, input, a')) return;
  const startX = event.clientX;
  const startY = event.clientY;
  let dragStarted = false;
  const onPointerMove = (moveEvent: PointerEvent) => {
    if (!dragStarted && Math.abs(moveEvent.clientX - startX) < 5 && Math.abs(moveEvent.clientY - startY) < 5) return;
    if (!dragStarted) {
      dragStarted = true;
      suppressNextCardClick = true;
      sessionStore.startDragCredentialsToTree(
        sessionStore.selectedCredentialIds.includes(credentialId)
          ? sessionStore.selectedCredentialIds
          : [credentialId],
        moveEvent.clientX,
        moveEvent.clientY,
      );
    }
    searchStore.updateDragToTreePointer(moveEvent.clientX, moveEvent.clientY);
  };
  const onPointerUp = () => {
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerUp);
    if (dragStarted) searchStore.finishDragToTree();
  };
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);
}

function handleBatchFileSelect(event: Event) {
  const input = event.target as HTMLInputElement;
  if (input.files && input.files.length > 0) {
    void sessionStore.importBatchSessionsFromFiles(input.files);
    input.value = '';
  }
}

function handleColdBackupFileSelect(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (file) {
    void tileStore.importColdArchive(file);
    input.value = '';
  }
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && sessionStore.isModalOpen) {
    sessionStore.closeModal();
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
        v-if="sessionStore.isModalOpen"
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/25 p-2.5 backdrop-blur-[2px]"
        @click.self="sessionStore.closeModal()"
      >
        <!-- 会话与配额治理中心：与聚合搜索一致的深色高透亚克力面板 -->
        <div
          class="archive-modal-card relative flex h-[min(960px,95vh)] w-[min(1560px,97vw)] flex-col overflow-hidden rounded-[2px] border border-white/15 bg-[#0f172a]/70 text-white shadow-[inset_0_1px_0_0_rgba(255,255,255,0.14),0_24px_60px_-12px_rgba(0,0,0,0.55)] backdrop-blur-xl"
        >
          <!-- 顶部 Header（与 SearchModalHeader 保持视觉统一） -->
          <header class="flex shrink-0 flex-wrap items-center gap-2.5 border-b border-white/10 bg-black/20 px-4 py-2.5">
            <!-- 应用方角徽标 -->
            <span
              class="flex size-[26px] shrink-0 items-center justify-center rounded-[2px] border border-sky-400/35 bg-sky-500/15 text-sky-300 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.18)]"
            >
              <Layers class="size-3.5" :stroke-width="2" />
            </span>

            <!-- 标题与操作提示 -->
            <div class="flex min-w-0 items-center gap-2">
              <h2 class="truncate text-[14px] font-medium tracking-wide text-white/92">
                会话与配额治理中心
              </h2>

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
                  class="pointer-events-none absolute left-0 top-full z-[100] mt-1.5 hidden w-80 rounded-[4px] border border-white/15 bg-[#141e30]/95 p-2.5 shadow-2xl backdrop-blur-xl group-hover:block transition-all duration-150"
                >
                  <div class="flex items-center gap-1.5 text-[11px] font-medium text-sky-300">
                    <Info class="size-3" />
                    <span>会话收纳与磁贴目录提示</span>
                  </div>
                  <p class="mt-1 font-mono text-[10px] leading-relaxed text-white/70">
                    按住 Shift 连续多选会话 · 向左直接拖拽会话卡片至 Explore 分组或文件夹 · 可在左栏随时新建文件夹或选择目标路径
                  </p>
                </div>
              </div>
            </div>

            <!-- 四大治理子面板 Tab 切换（方角胶囊风格） -->
            <nav class="ml-2 flex flex-wrap items-center gap-1">
              <button
                v-for="tab in TABS"
                :key="tab.id"
                type="button"
                class="flex h-[26px] items-center gap-1.5 rounded-[2px] border px-2.5 text-[11px] transition-colors whitespace-nowrap"
                :class="
                  sessionStore.activeTab === tab.id
                    ? 'border-sky-400/50 bg-sky-500/20 text-sky-200 font-medium shadow-[inset_0_1px_0_0_rgba(56,189,248,0.25)]'
                    : 'border-white/10 bg-white/[0.03] text-white/55 hover:border-white/25 hover:text-white/90'
                "
                @click="sessionStore.setActiveTab(tab.id)"
              >
                <span>{{ tab.label }}</span>
                <span
                  v-if="tab.badge"
                  class="rounded-[2px] px-1 font-mono text-[10px] tabular-nums"
                  :class="
                    sessionStore.activeTab === tab.id
                      ? 'bg-sky-400 text-slate-950 font-semibold'
                      : 'bg-white/10 text-white/55'
                  "
                >
                  {{ tab.badge() }}
                </span>
              </button>
            </nav>

            <!-- 归档落位反馈横幅 -->
            <div
              v-if="sessionStore.batchPlaceNotice || searchStore.lastImportBannerText"
              class="flex items-center gap-1.5 rounded-[2px] border border-sky-400/40 bg-sky-500/15 px-2 py-0.5 text-[11px] text-sky-200"
            >
              <CheckCircle2 class="size-3 shrink-0 text-sky-400" />
              <span class="max-w-[240px] truncate">
                {{ sessionStore.batchPlaceNotice || searchStore.lastImportBannerText }}
              </span>
            </div>

            <!-- 右侧左栏 Explore 显隐控制与关闭按钮 -->
            <div class="ml-auto flex shrink-0 items-center gap-1.5">
              <button
                type="button"
                class="flex h-[26px] items-center gap-1.5 rounded-[2px] border px-2 text-[11px] transition-colors"
                :class="
                  sessionStore.isLeftTreeOpen
                    ? 'border-sky-400/45 bg-sky-500/20 text-sky-200'
                    : 'border-white/10 bg-white/[0.03] text-white/45 hover:border-white/25 hover:text-white/85'
                "
                title="显示/隐藏左栏 Explore 磁贴目录树"
                @click="sessionStore.toggleLeftTree()"
              >
                <PanelLeft class="size-3.5" :stroke-width="1.8" />
                <span class="hidden md:inline">Explore 目录树</span>
              </button>

              <div class="mx-0.5 h-3.5 w-px bg-white/10" />

              <button
                type="button"
                class="flex size-[26px] items-center justify-center rounded-[2px] border border-white/10 text-white/45 transition-colors hover:border-white/25 hover:bg-white/10 hover:text-white"
                title="关闭会话与配额治理中心 (Esc)"
                @click="sessionStore.closeModal()"
              >
                <X class="size-3.5" :stroke-width="1.75" />
              </button>
            </div>
          </header>

          <!-- 主体双栏区：左栏通用磁贴资源管理器 (Explore) + 右侧主内容区 -->
          <div class="flex min-h-0 flex-1 overflow-hidden">
            <TileExplorerTree
              :is-open="sessionStore.isLeftTreeOpen"
              :selectable-target="true"
              :selected-target-type="sessionStore.targetFolderId ? 'folder' : 'group'"
              :selected-target-id="sessionStore.targetFolderId || sessionStore.targetGroupId"
              @select-target="sessionStore.selectTargetFromExplorer"
            />

            <!-- ============================================================ -->
            <!-- TAB 1: 全部会话与批量收纳（单列 SearchResultCard 风格） -->
            <!-- ============================================================ -->
            <main
              v-if="sessionStore.activeTab === 'sessions'"
              class="flex min-w-0 flex-1 flex-col bg-black/10"
            >
              <!-- 顶部筛选与收纳路径工具栏 -->
              <div class="shrink-0 border-b border-white/10 bg-white/[0.02] px-4 py-3 space-y-2.5">
                <!-- 第一行：搜索框 + 状态筛选胶囊 + 全选/清空 -->
                <div class="flex flex-wrap items-center justify-between gap-2.5">
                  <div class="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                    <div
                      class="flex h-8 w-64 items-center gap-2 rounded-[2px] border border-white/15 bg-black/35 px-2.5 focus-within:border-sky-400/60"
                    >
                      <Search class="size-3.5 shrink-0 text-white/40" />
                      <input
                        :value="sessionStore.sessionFilterKeyword"
                        type="text"
                        placeholder="筛选会话标题或 @username…"
                        class="w-full bg-transparent text-xs text-white placeholder-white/35 outline-none"
                        @input="sessionStore.sessionFilterKeyword = ($event.target as HTMLInputElement).value"
                      />
                    </div>

                    <div class="flex items-center gap-1">
                      <button
                        v-for="mode in [
                          { id: 'all', label: '全部会话' },
                          { id: 'joined', label: 'TG 主列表' },
                          { id: 'archived', label: 'TG 已归档' },
                        ]"
                        :key="mode.id"
                        type="button"
                        class="h-8 rounded-[2px] border px-2.5 text-[11px] transition-colors"
                        :class="
                          sessionStore.sessionFilterMode === mode.id
                            ? 'border-sky-400/50 bg-sky-500/20 text-sky-200 font-medium'
                            : 'border-white/10 bg-white/[0.03] text-white/55 hover:border-white/25 hover:text-white/85'
                        "
                        @click="sessionStore.sessionFilterMode = mode.id as 'all' | 'joined' | 'archived'"
                      >
                        {{ mode.label }}
                      </button>
                    </div>
                  </div>

                  <div class="flex items-center gap-1.5 text-[11px]">
                    <span class="font-mono text-white/45">
                      已选 <strong class="text-sky-300">{{ sessionStore.selectedPeerKeys.length }}</strong> / {{ sessionStore.filteredDialogs.length }}
                    </span>
                    <button
                      type="button"
                      class="h-7 rounded-[2px] border border-white/12 bg-white/[0.04] px-2.5 text-white/75 transition-colors hover:border-white/25 hover:bg-white/[0.08] hover:text-white"
                      @click="sessionStore.selectAllFilteredPeers()"
                    >
                      全选当前 ({{ sessionStore.filteredDialogs.length }})
                    </button>
                    <button
                      v-if="sessionStore.selectedPeerKeys.length > 0"
                      type="button"
                      class="h-7 rounded-[2px] border border-white/12 bg-white/[0.04] px-2.5 text-white/55 transition-colors hover:border-white/25 hover:text-white"
                      @click="sessionStore.clearSelectedPeers()"
                    >
                      清空已选
                    </button>
                  </div>
                </div>

                <!-- 第二行：目标收纳路径指示器（联动左栏 Explore）+ 凭据模式 + TG 静默归档 + 一键收纳按钮 -->
                <div class="flex flex-wrap items-center justify-between gap-2.5 border-t border-white/8 pt-2.5 text-[11px]">
                  <div class="flex flex-wrap items-center gap-2.5">
                    <!-- 当前目标路径指示器（点击左栏任意分组/文件夹可实时切换） -->
                    <div
                      class="flex h-7 items-center gap-1.5 rounded-[2px] border border-sky-400/35 bg-sky-500/10 px-2.5 text-sky-200"
                      title="在左侧 Explore 目录树中点击任意分组或文件夹即可切换目标落位路径，也可直接在左栏新建文件夹"
                    >
                      <Folder class="size-3.5 shrink-0 text-sky-300" />
                      <span class="text-white/55">目标路径：</span>
                      <span class="max-w-[220px] truncate font-medium">{{ currentTargetPathLabel }}</span>
                    </div>

                    <!-- 快捷分组下拉切换 -->
                    <select
                      :value="sessionStore.targetGroupId"
                      class="h-7 rounded-[2px] border border-white/12 bg-black/40 px-2 text-[11px] text-white/85 outline-none focus:border-sky-400/50"
                      @change="
                        sessionStore.targetGroupId = ($event.target as HTMLSelectElement).value;
                        sessionStore.targetFolderId = '';
                      "
                    >
                      <option v-for="g in tileStore.groups" :key="g.id" :value="g.id" class="bg-slate-900 text-white">
                        分组：{{ g.title }}
                      </option>
                    </select>

                    <!-- 磁贴凭据态 -->
                    <select
                      :value="sessionStore.credentialModeForPlacement"
                      class="h-7 rounded-[2px] border border-white/12 bg-black/40 px-2 text-[11px] text-white/85 outline-none focus:border-sky-400/50"
                      @change="sessionStore.credentialModeForPlacement = ($event.target as HTMLSelectElement).value as any"
                    >
                      <option value="joined" class="bg-slate-900 text-white">🟢 已加入 (Joined)</option>
                      <option value="temp_auto_renew" class="bg-slate-900 text-white">🔵 临时自动续期 (Auto-Renew)</option>
                      <option value="temp_ephemeral" class="bg-slate-900 text-white">🟡 临时免打扰 (Ephemeral)</option>
                    </select>

                    <label class="flex cursor-pointer items-center gap-1.5 text-white/75 hover:text-white">
                      <input
                        type="checkbox"
                        :checked="sessionStore.archiveInTelegram"
                        class="rounded-[2px] border-white/25 bg-black/40 accent-sky-400"
                        @change="sessionStore.archiveInTelegram = ($event.target as HTMLInputElement).checked"
                      />
                      <span>同时在 Telegram 静默归档 (folder_id=1)</span>
                    </label>
                  </div>

                  <div class="flex items-center gap-2">
                    <button
                      type="button"
                      class="flex h-7 items-center gap-1.5 border border-white/15 bg-white/[0.05] px-2.5 text-[11px] text-white/80 hover:bg-white/10"
                      @click="sessionStore.refreshSelectedSessionCovers()"
                    >
                      <RefreshCw class="size-3.5" :class="sessionStore.isRefreshingSelectedCovers ? 'animate-spin' : ''" />刷新选中封面 ({{ sessionStore.selectedPeerKeys.length }})
                    </button>
                    <button
                      type="button"
                      class="flex h-7 items-center gap-1.5 rounded-[2px] border border-sky-400/60 bg-sky-500/25 px-3 text-[11px] font-medium text-sky-100 shadow-[inset_0_1px_0_0_rgba(56,189,248,0.3)] transition-colors hover:bg-sky-500/35"
                      @click="sessionStore.batchPlaceSelectedSessionsIntoExplore()"
                    >
                    <FolderPlus class="size-3.5 text-sky-300" />
                    <span>
                      {{
                        sessionStore.isBatchPlacing
                          ? '正在批量收纳…'
                          : `一键收纳至目标路径 (${sessionStore.selectedPeerKeys.length})`
                      }}
                    </span>
                    </button>
                  </div>
                </div>
                <p v-if="sessionStore.coverRefreshNotice" class="text-[11px] text-sky-300">{{ sessionStore.coverRefreshNotice }}</p>
              </div>

              <!-- 会话单列卡片流（与 SearchResultCard 保持完全一致的结构与手感） -->
              <div class="search-modal-scroll flex-1 overflow-y-auto px-4 py-3">
                <div
                  v-if="sessionStore.filteredDialogs.length === 0"
                  class="flex h-64 flex-col items-center justify-center rounded-[2px] border border-dashed border-white/12 bg-white/[0.01] text-center text-white/45"
                >
                  <Users class="mb-2 size-8 opacity-40" />
                  <p class="text-xs font-medium text-white/70">暂无匹配的 Telegram 会话</p>
                  <p class="mt-1 text-[11px] text-white/40">
                    连接 Telegram 账号后，可在此勾选群组/频道并直接拖入左侧 Explore 磁贴树或一键批量收纳
                  </p>
                </div>

                <div v-else class="space-y-1.5">
                  <article
                    v-for="(dialog, idx) in sessionStore.filteredDialogs"
                    :key="dialog.key"
                    class="group relative flex cursor-grab select-none items-center gap-3 rounded-[2px] border p-2.5 transition-all duration-150 active:cursor-grabbing"
                    :class="
                      sessionStore.selectedPeerKeys.includes(dialog.key)
                        ? 'border-sky-400/85 bg-sky-500/[0.17] ring-1 ring-sky-400/55 shadow-[inset_0_1px_0_0_rgba(56,189,248,0.28),0_6px_18px_-6px_rgba(14,165,233,0.3)]'
                        : 'border-white/10 bg-white/[0.03] hover:border-white/25 hover:bg-white/[0.06]'
                    "
                    @pointerdown="onSessionCardPointerDown(dialog, $event)"
                    @click="onSessionCardClick(idx, dialog.key, $event)"
                  >
                    <!-- 左端：正方形缩略图容器 (Square Thumbnail) -->
                    <div
                      class="relative aspect-square size-14 shrink-0 overflow-hidden rounded-[2px] border border-white/12 bg-black/45"
                    >
                      <img
                        v-if="resolveDialogAvatarUrl(dialog)"
                        :src="resolveDialogAvatarUrl(dialog)!"
                        :alt="dialog.title"
                        loading="lazy"
                        class="h-full w-full object-cover transition-transform duration-200 group-hover:scale-105"
                      />
                      <div
                        v-else
                        class="flex h-full w-full items-center justify-center bg-gradient-to-br from-sky-500/25 via-slate-800 to-slate-950 text-base font-bold text-sky-200"
                      >
                        {{ dialog.title.slice(0, 2).toUpperCase() }}
                      </div>
                      <!-- 缩略图底部胶囊角标 -->
                      <span
                        class="absolute bottom-0.5 right-0.5 rounded-[1px] bg-black/75 px-1 py-0.2 font-mono text-[9px] text-white/85 backdrop-blur-xs"
                      >
                        {{ resolveDialogKindLabel(dialog.kind) }}
                      </span>
                    </div>

                    <!-- 中部：Title 与结构化元数据 -->
                    <div class="min-w-0 flex-1">
                      <!-- 第一行：Title + 已归档磁贴位置标记 + TG 归档态标签 -->
                      <div class="flex items-center gap-2">
                        <h3
                          class="min-w-0 flex-1 truncate text-[13px] font-medium tracking-wide"
                          :class="sessionStore.selectedPeerKeys.includes(dialog.key) ? 'text-white' : 'text-white/92'"
                        >
                          {{ dialog.title }}
                        </h3>

                        <!-- 已在磁贴拓扑中的实时标记 -->
                        <span
                          v-if="tileStore.archivedSourceMap.get(dialog.key)"
                          class="flex shrink-0 items-center gap-1 rounded-[2px] border border-emerald-400/40 bg-emerald-500/15 px-1.5 py-0.5 text-[10px] text-emerald-300"
                          :title="`已归入：${tileStore.archivedSourceMap.get(dialog.key)}`"
                        >
                          <CheckCircle2 class="size-2.5" />
                          <span class="max-w-[140px] truncate">{{ tileStore.archivedSourceMap.get(dialog.key) }}</span>
                        </span>

                        <!-- TG 侧主列表 / 已归档标记 -->
                        <span
                          class="shrink-0 rounded-[2px] border px-1.5 py-0.5 text-[10px]"
                          :class="
                            (dialog.folderId ?? 0) === 1
                              ? 'border-white/15 bg-white/[0.06] text-white/60'
                              : 'border-sky-400/35 bg-sky-500/15 text-sky-300'
                          "
                        >
                          {{ (dialog.folderId ?? 0) === 1 ? 'TG 已归档' : 'TG 主列表' }}
                        </span>
                      </div>

                      <!-- 第二行：最近消息摘要 -->
                      <p class="mt-1 truncate text-[11px] text-white/55">
                        {{
                          dialog.lastMessage?.text ||
                            (dialog.username ? `@${dialog.username}` : `${resolveDialogKindLabel(dialog.kind)}会话`)
                        }}
                      </p>

                      <!-- 第三行：账号标识、成员数、未读数、活跃日期 -->
                      <div class="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] text-white/40">
                        <span class="flex items-center gap-1 text-white/65">
                          <Users class="size-2.5 text-sky-300" />
                          <span class="max-w-[180px] truncate">
                            {{ dialog.username ? `@${dialog.username}` : dialog.key }}
                          </span>
                        </span>

                        <span v-if="dialog.participantsCount">
                          {{ dialog.participantsCount.toLocaleString('zh-CN') }} 成员
                        </span>
                        <span v-if="dialog.unreadCount > 0" class="text-sky-300">
                          未读 {{ dialog.unreadCount }}
                        </span>
                        <span class="uppercase">{{ dialog.kind }}</span>
                        <span>{{ formatDialogDate(dialog.date) }}</span>
                      </div>
                    </div>

                    <!-- 右端：拖拽把手提示与多选高亮勾选框 -->
                    <div class="flex shrink-0 items-center gap-1.5 pl-1">
                      <GripVertical
                        class="size-3.5 text-white/20 opacity-0 transition-opacity group-hover:opacity-100"
                      />
                      <div
                        class="flex size-4 items-center justify-center rounded-[2px] border transition-colors"
                        :class="
                          sessionStore.selectedPeerKeys.includes(dialog.key)
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

            <!-- ============================================================ -->
            <!-- TAB 2: 临时会话凭据池 -->
            <!-- ============================================================ -->
            <main
              v-else-if="sessionStore.activeTab === 'temp_pool'"
              class="search-modal-scroll flex-1 overflow-y-auto bg-black/10 p-4 space-y-4"
            >
              <div class="rounded-[2px] border border-white/12 bg-white/[0.03] p-4 space-y-3">
                <div class="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h3 class="text-[13px] font-medium text-white/92">添加免打扰临时会话凭据</h3>
                    <p class="mt-0.5 text-[11px] text-white/50">
                      不调用 JoinChannel、不占用 500/1000 槽位上限，仅通过 CheckChatInvite / ResolveUsername 维护只读访问哈希
                    </p>
                  </div>
                  <button
                    type="button"
                    class="flex h-7 items-center gap-1.5 rounded-[2px] border border-white/15 bg-white/[0.05] px-2.5 text-[11px] text-white/85 transition-colors hover:border-white/30 hover:bg-white/10"
                    @click="sessionStore.patrolAllTempCredentials()"
                  >
                    <RefreshCw class="size-3.5 text-sky-300" :class="sessionStore.isPatrollingPool ? 'animate-spin' : ''" />
                    <span>{{ sessionStore.isPatrollingPool ? '正在巡检…' : '立即批量巡检刷新 (GetChannels)' }}</span>
                  </button>
                </div>

                <textarea
                  :value="sessionStore.newCredentialInput"
                  rows="3"
                  placeholder="输入 @username、https://t.me/channel 或 https://t.me/+inviteHash（支持多行批量粘贴）…"
                  class="w-full rounded-[2px] border border-white/15 bg-black/40 p-2.5 font-mono text-xs text-white placeholder-white/35 outline-none focus:border-sky-400/60"
                  @input="sessionStore.newCredentialInput = ($event.target as HTMLTextAreaElement).value"
                />

                <div class="flex flex-wrap items-center justify-between gap-3 text-[11px]">
                  <div class="flex flex-wrap items-center gap-4 text-white/75">
                    <label class="flex cursor-pointer items-center gap-1.5 hover:text-white">
                      <input
                        type="checkbox"
                        :checked="sessionStore.newCredentialAutoRenew"
                        class="rounded-[2px] accent-sky-400"
                        @change="sessionStore.newCredentialAutoRenew = ($event.target as HTMLInputElement).checked"
                      />
                      <span>🔵 开启后台自动续期巡检 (Auto-Renew)</span>
                    </label>
                    <label class="flex cursor-pointer items-center gap-1.5 hover:text-white">
                      <input
                        type="checkbox"
                        :checked="sessionStore.newCredentialPlaceToBoard"
                        class="rounded-[2px] accent-sky-400"
                        @change="sessionStore.newCredentialPlaceToBoard = ($event.target as HTMLInputElement).checked"
                      />
                      <span>同时生成磁贴至当前目标路径 ({{ currentTargetPathLabel }})</span>
                    </label>
                  </div>

                  <button
                    type="button"
                    class="flex h-7 items-center gap-1.5 rounded-[2px] border border-sky-400/60 bg-sky-500/25 px-3 text-[11px] font-medium text-sky-100 hover:bg-sky-500/35"
                    @click="sessionStore.addTempCredentialsFromInput()"
                  >
                    <Sparkles class="size-3.5 text-sky-300" />
                    <span>{{ sessionStore.isAddingCredential ? '正在解析…' : '解析并加入临时凭据池' }}</span>
                  </button>
                </div>

                <p v-if="sessionStore.patrolNotice" class="text-[11px] text-sky-300">
                  {{ sessionStore.patrolNotice }}
                </p>
              </div>

              <!-- 临时凭据单列卡片列表 -->
              <div
                v-if="sessionStore.tempCredentials.length === 0"
                class="flex h-56 flex-col items-center justify-center rounded-[2px] border border-dashed border-white/12 bg-white/[0.01] text-center text-white/45"
              >
                <KeyRound class="mb-2 size-8 opacity-40" />
                <p class="text-xs font-medium text-white/70">临时会话凭据池为空</p>
                <p class="mt-1 text-[11px] text-white/40">
                  粘贴公开频道或私有邀请链接即可免加群窥视并纳入全局聚合检索
                </p>
              </div>

              <div v-else class="space-y-1.5">
                <div class="flex items-center justify-between gap-2 text-[11px] text-white/55">
                  <span>已选 {{ sessionStore.selectedCredentialIds.length }} / {{ sessionStore.tempCredentials.length }}</span>
                  <div class="flex gap-1.5">
                    <button type="button" class="flex h-7 items-center gap-1 border border-white/15 px-2 text-white/75 hover:bg-white/10" @click="sessionStore.refreshSelectedSessionCovers()">
                      <RefreshCw class="size-3" :class="sessionStore.isRefreshingSelectedCovers ? 'animate-spin' : ''" />刷新所选封面
                    </button>
                    <button type="button" class="flex h-7 items-center gap-1 border border-sky-400/40 px-2 text-sky-200 hover:bg-sky-500/15" @click="sessionStore.placeSelectedCredentialTiles()">
                      <FolderPlus class="size-3.5" />生成选中磁贴
                    </button>
                    <button type="button" class="h-7 border border-white/15 px-2 text-white/75 hover:bg-white/10" @click="sessionStore.selectAllCredentials()">全选</button>
                    <button type="button" class="h-7 border border-white/15 px-2 text-white/55 hover:bg-white/10" @click="sessionStore.clearSelectedCredentials()">清空</button>
                  </div>
                </div>
                <p v-if="sessionStore.coverRefreshNotice" class="text-[11px] text-sky-300">{{ sessionStore.coverRefreshNotice }}</p>
                <div
                  v-for="(cred, credIndex) in sessionStore.tempCredentials"
                  :key="cred.id"
                  class="flex flex-wrap items-center justify-between gap-3 rounded-[2px] border p-3 transition-colors"
                  :class="sessionStore.selectedCredentialIds.includes(cred.id) ? 'border-sky-400/70 bg-sky-500/10' : 'border-white/10 bg-white/[0.03] hover:border-white/25 hover:bg-white/[0.05]'"
                  @pointerdown="onCredentialCardPointerDown(cred.id, $event)"
                  @click="onCredentialCardClick(credIndex, cred.id, $event)"
                >
                  <div class="flex min-w-0 flex-1 items-center gap-3">
                    <span class="flex size-4 shrink-0 items-center justify-center border" :class="sessionStore.selectedCredentialIds.includes(cred.id) ? 'border-sky-400 bg-sky-400 text-slate-950' : 'border-white/20 text-transparent'">
                      <Check class="size-3" />
                    </span>
                    <div class="min-w-0 space-y-1">
                      <div class="flex items-center gap-2">
                        <KeyRound class="size-3.5 shrink-0 text-amber-300" />
                        <span class="truncate text-[13px] font-medium text-white/92">{{ cred.title }}</span>
                      <span
                        class="rounded-[2px] border px-1.5 py-0.5 text-[10px]"
                        :class="
                          cred.status === 'healthy'
                            ? 'border-emerald-400/40 bg-emerald-500/15 text-emerald-300'
                            : 'border-rose-400/40 bg-rose-500/15 text-rose-300'
                        "
                      >
                        {{ cred.status === 'healthy' ? '凭据有效' : '待续期/已失效' }}
                      </span>
                      <span class="rounded-[2px] border border-white/12 bg-white/[0.06] px-1.5 py-0.5 text-[10px] text-white/70">
                        {{ cred.autoRenew ? '🔵 自动续期' : '🟡 单次快照' }}
                      </span>
                    </div>
                    <p class="font-mono text-[10px] text-white/45">
                      {{ cred.username ? `@${cred.username}` : `Invite +${cred.inviteHash}` }}
                      <span v-if="cred.participantsCount"> · {{ cred.participantsCount }} 成员</span>
                      · 最近校准：{{ new Date(cred.lastVerifiedAt).toLocaleTimeString('zh-CN') }}
                    </p>
                    </div>
                  </div>

                  <div class="flex items-center gap-1.5 text-[11px]">
                    <button
                      type="button"
                      class="h-7 rounded-[2px] border border-white/15 bg-white/[0.05] px-2.5 text-white/85 hover:border-white/30 hover:bg-white/10"
                      @click.stop="sessionStore.placeTempCredentialTile(cred, sessionStore.targetGroupId)"
                    >
                      生成磁贴
                    </button>
                    <button
                      type="button"
                      class="h-7 rounded-[2px] border border-emerald-400/45 bg-emerald-500/20 px-2.5 text-emerald-200 hover:bg-emerald-500/30"
                      @click.stop="sessionStore.upgradeTempCredentialToJoined(cred.id)"
                    >
                      🟢 转正加入并归档
                    </button>
                    <button
                      type="button"
                      class="flex size-7 items-center justify-center rounded-[2px] border border-white/10 text-white/45 hover:border-rose-400/40 hover:bg-rose-500/15 hover:text-rose-300"
                      title="移除凭据"
                      @click.stop="sessionStore.removeTempCredential(cred.id)"
                    >
                      <Trash2 class="size-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            </main>

            <!-- ============================================================ -->
            <!-- TAB 3: 多账号矩阵、PendingSlot 裂变、无缝导入与配额引擎 -->
            <!-- ============================================================ -->
            <main
              v-else-if="sessionStore.activeTab === 'accounts_quota'"
              class="search-modal-scroll flex-1 overflow-y-auto bg-black/10 p-4 space-y-4"
            >
              <!-- A. 多账号凭据矩阵与 6步同机回环热槽位生成 -->
              <section class="rounded-[2px] border border-white/12 bg-white/[0.03] p-4 space-y-3">
                <div class="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h3 class="text-[13px] font-medium text-white/92">
                      多账号凭据健康度与同机回环热备槽位 (PendingSlot)
                    </h3>
                    <p class="mt-0.5 text-[11px] text-white/50">
                      对满 24h 的黄金会话，支持在 Worker 内通过 6 步同机回环裂变独立 auth_key 备用槽位，全程免手机扫码/短信
                    </p>
                  </div>
                  <div class="flex items-center gap-2">
                    <input
                      :value="sessionStore.spawn2FAPasswordInput"
                      type="password"
                      placeholder="若启用两步验证，输入 2FA 密码"
                      class="h-7 w-48 rounded-[2px] border border-white/15 bg-black/40 px-2.5 text-xs text-white placeholder-white/35 outline-none focus:border-sky-400/60"
                      @input="sessionStore.spawn2FAPasswordInput = ($event.target as HTMLInputElement).value"
                    />
                    <button
                      type="button"
                      class="flex h-7 items-center gap-1.5 rounded-[2px] border border-white/15 bg-white/[0.05] px-2.5 text-[11px] text-white/85 hover:border-white/30 hover:bg-white/10"
                      @click="sessionStore.probeAllAccountsHealth()"
                    >
                      <Activity class="size-3.5 text-sky-300" :class="sessionStore.isProbingHealth ? 'animate-spin' : ''" />
                      <span>探测账号健康度</span>
                    </button>
                  </div>
                </div>

                <div class="grid grid-cols-1 gap-2.5 md:grid-cols-2">
                  <div
                    v-for="acc in telegramStore.accounts"
                    :key="acc.tg_user_id"
                    class="rounded-[2px] border border-white/10 bg-black/30 p-3 space-y-2"
                  >
                    <div class="flex items-center justify-between gap-2">
                      <div>
                        <div class="flex items-center gap-2">
                          <span class="text-[13px] font-medium text-white/92">
                            {{ [acc.first_name, acc.last_name].filter(Boolean).join(' ') || acc.tg_user_id }}
                          </span>
                          <span class="rounded-[2px] border border-sky-400/35 bg-sky-500/15 px-1.5 py-0.2 font-mono text-[10px] text-sky-300">
                            DC{{ sessionStore.governanceRecords[acc.tg_user_id]?.dcId ?? 2 }}
                          </span>
                        </div>
                        <p class="mt-0.5 font-mono text-[10px] text-white/45">
                          {{ acc.username ? `@${acc.username}` : `ID: ${acc.tg_user_id}` }}
                          · 在线设备数：{{ sessionStore.governanceRecords[acc.tg_user_id]?.activeSessionsCount ?? acc.authorizations.length }}
                        </p>
                      </div>

                      <button
                        type="button"
                        class="flex h-7 items-center gap-1 rounded-[2px] border border-sky-400/60 bg-sky-500/25 px-2.5 text-[11px] font-medium text-sky-100 hover:bg-sky-500/35"
                        @click="sessionStore.spawnAccountPendingSlot(acc.tg_user_id)"
                      >
                        <Zap class="size-3.5 text-sky-300" />
                        <span>
                          {{
                            sessionStore.isSpawningSlot[acc.tg_user_id]
                              ? '回环裂变中…'
                              : '裂变备用槽位'
                          }}
                        </span>
                      </button>
                    </div>

                    <div class="flex flex-wrap items-center gap-2 font-mono text-[10px] text-white/55">
                      <span class="rounded-[2px] border border-white/10 bg-white/[0.04] px-2 py-0.5">
                        状态：{{ sessionStore.governanceRecords[acc.tg_user_id]?.healthStatus ?? 'healthy' }}
                      </span>
                      <span class="rounded-[2px] border border-white/10 bg-white/[0.04] px-2 py-0.5">
                        已储备 PendingSlot：{{ sessionStore.governanceRecords[acc.tg_user_id]?.pendingSlots.length ?? 0 }} 个
                      </span>
                    </div>
                  </div>
                </div>
              </section>

              <!-- B. 外部二进制 .session / StringSession 批量无头导入 -->
              <section class="rounded-[2px] border border-white/12 bg-white/[0.03] p-4 space-y-3">
                <div class="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h3 class="text-[13px] font-medium text-white/92">外部会话无缝批量导入（零验证码 / 零短信）</h3>
                    <p class="mt-0.5 text-[11px] text-white/50">
                      支持直接选择 Telethon/Pyrogram `.session` SQLite3 二进制文件 + 同名 `.json` 设备指纹，或粘贴多行 GramJS StringSession
                    </p>
                  </div>
                  <label class="flex h-7 cursor-pointer items-center gap-1.5 rounded-[2px] border border-sky-400/60 bg-sky-500/25 px-3 text-[11px] font-medium text-sky-100 hover:bg-sky-500/35">
                    <Upload class="size-3.5 text-sky-300" />
                    <span>选择 .session / .json 文件批量导入</span>
                    <input
                      type="file"
                      multiple
                      accept=".session,.json"
                      class="hidden"
                      @change="handleBatchFileSelect"
                    />
                  </label>
                </div>

                <div class="flex gap-2">
                  <textarea
                    :value="sessionStore.batchImportTextInput"
                    rows="2"
                    placeholder="或在此粘贴多行 GramJS StringSession 字符串（每行一个账号）…"
                    class="flex-1 rounded-[2px] border border-white/15 bg-black/40 p-2 font-mono text-xs text-white placeholder-white/35 outline-none focus:border-sky-400/60"
                    @input="sessionStore.batchImportTextInput = ($event.target as HTMLTextAreaElement).value"
                  />
                  <button
                    type="button"
                    class="shrink-0 rounded-[2px] border border-white/15 bg-white/[0.05] px-3.5 text-[11px] font-medium text-white/85 hover:border-white/30 hover:bg-white/10"
                    @click="sessionStore.importBatchSessionsFromText()"
                  >
                    导入文本会话
                  </button>
                </div>

                <p v-if="sessionStore.batchImportNotice" class="text-[11px] text-sky-300">
                  {{ sessionStore.batchImportNotice }}
                </p>
              </section>

              <!-- C. 用户可配置自适应配额引擎 -->
              <section class="rounded-[2px] border border-white/12 bg-white/[0.03] p-4 space-y-3">
                <div class="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h3 class="text-[13px] font-medium text-white/92">自适应配额策略令牌桶 (Adaptive Quota Engine)</h3>
                    <p class="mt-0.5 text-[11px] text-white/50">
                      所有软性日配额支持按需调节；服务端 FLOOD_WAIT_X 秒硬性底线始终强制生效以保护账号安全
                    </p>
                  </div>

                  <div class="flex items-center gap-1">
                    <button
                      v-for="preset in [
                        { id: 'conservative', label: '🛡️ 保守安全' },
                        { id: 'standard', label: '⚖️ 均衡推荐' },
                        { id: 'aggressive', label: '🚀 激进高频' },
                      ]"
                      :key="preset.id"
                      type="button"
                      class="h-7 rounded-[2px] border px-2.5 text-[11px] transition-colors"
                      :class="
                        sessionStore.quotaPolicy.mode === preset.id
                          ? 'border-sky-400/50 bg-sky-500/20 text-sky-200 font-medium'
                          : 'border-white/10 bg-white/[0.03] text-white/55 hover:border-white/25 hover:text-white/85'
                      "
                      @click="sessionStore.setQuotaPreset(preset.id as any)"
                    >
                      {{ preset.label }}
                    </button>
                  </div>
                </div>

                <div class="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                  <div
                    v-for="ruleKey in QUOTA_KEYS"
                    :key="ruleKey"
                    class="flex items-center justify-between gap-3 rounded-[2px] border border-white/10 bg-black/30 p-3"
                  >
                    <div class="min-w-0">
                      <p class="truncate text-xs font-medium text-white/90">{{ QUOTA_RULE_LABELS[ruleKey] }}</p>
                      <p class="mt-0.5 font-mono text-[10px] text-white/45">
                        最小间隔：{{ (sessionStore.effectiveQuotaLimits[ruleKey].minIntervalMs / 1000).toFixed(1) }}s
                      </p>
                    </div>
                    <input
                      type="number"
                      min="1"
                      max="5000"
                      :value="sessionStore.effectiveQuotaLimits[ruleKey].maxPerDay"
                      class="h-7 w-20 rounded-[2px] border border-white/15 bg-black/50 px-2 text-right font-mono text-xs font-semibold text-sky-300 tabular-nums outline-none focus:border-sky-400"
                      @change="sessionStore.updateCustomQuotaLimit(ruleKey, Number(($event.target as HTMLInputElement).value))"
                    />
                  </div>
                </div>
              </section>
            </main>

            <!-- ============================================================ -->
            <!-- TAB 4: 共享私有备份群 & OPFS 5 子域存储治理 -->
            <!-- ============================================================ -->
            <main
              v-else-if="sessionStore.activeTab === 'vault_storage'"
              class="search-modal-scroll flex-1 overflow-y-auto bg-black/10 p-4 space-y-4"
            >
              <!-- A. 共享私有备份群 (Shared Private Vault Group) -->
              <section class="rounded-[2px] border border-white/12 bg-white/[0.03] p-4 space-y-3">
                <div class="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h3 class="text-[13px] font-medium text-white/92">共享私有备份群 (Shared Private Vault Group)</h3>
                    <p class="mt-0.5 text-[11px] text-white/50">
                      多账号共同驻留的私有超级群组（开启 Forum Topics），提供零带宽转发备份、防转发流式克隆与 #02 会话凭据信标同步
                    </p>
                  </div>
                  <div class="flex items-center gap-2">
                    <select
                      :value="sessionStore.selectedVaultPeerKey"
                      class="h-7 rounded-[2px] border border-white/15 bg-black/40 px-2.5 text-xs text-white outline-none focus:border-sky-400/60"
                      @change="sessionStore.selectedVaultPeerKey = ($event.target as HTMLSelectElement).value"
                    >
                      <option value="" class="bg-slate-900 text-white">-- 选择已加入的超级群组作为私有备份群 --</option>
                      <option
                        v-for="sg in sessionStore.candidateVaultSupergroups"
                        :key="sg.key"
                        :value="sg.key"
                        class="bg-slate-900 text-white"
                      >
                        {{ sg.title }} ({{ sg.key }})
                      </option>
                    </select>
                    <button
                      type="button"
                      class="flex h-7 items-center gap-1.5 rounded-[2px] border border-sky-400/60 bg-sky-500/25 px-3 text-[11px] font-medium text-sky-100 hover:bg-sky-500/35"
                      @click="sessionStore.bindAndInitVaultGroup(sessionStore.selectedVaultPeerKey)"
                    >
                      <ShieldCheck class="size-3.5 text-sky-300" />
                      <span>{{ sessionStore.isInitializingVault ? '正在初始化话题…' : '绑定并初始化 5 大话题' }}</span>
                    </button>
                  </div>
                </div>

                <div
                  v-if="sessionStore.vaultConfig"
                  class="rounded-[2px] border border-white/10 bg-black/30 p-3 space-y-2"
                >
                  <div class="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p class="text-xs font-medium text-white/90">
                        已绑定备份群：{{ sessionStore.vaultConfig.vaultTitle }} ({{ sessionStore.vaultConfig.vaultPeerKey }})
                      </p>
                      <p class="mt-0.5 font-mono text-[10px] text-white/45">
                        5 大 Forum Topics 已就绪 · 信标话题 ID：#{{ sessionStore.vaultConfig.topics.beacon }}
                      </p>
                    </div>
                    <button
                      type="button"
                      class="flex h-7 items-center gap-1.5 rounded-[2px] border border-sky-400/45 bg-sky-500/15 px-2.5 text-[11px] text-sky-200 hover:bg-sky-500/25"
                      @click="sessionStore.syncTempPoolToVaultBeacon()"
                    >
                      <CloudUpload class="size-3.5 text-sky-300" />
                      <span>
                        {{ sessionStore.isSyncingBeacon ? '正在同步信标…' : '同步临时凭据池至 #02 置顶信标' }}
                      </span>
                    </button>
                  </div>
                </div>

                <p v-if="sessionStore.vaultNotice" class="text-[11px] text-sky-300">
                  {{ sessionStore.vaultNotice }}
                </p>
              </section>

              <!-- B. OPFS 5 大存储子域配额仪表盘与冷备份导入导出 -->
              <section class="rounded-[2px] border border-white/12 bg-white/[0.03] p-4 space-y-3">
                <div class="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div class="flex items-center gap-2">
                      <h3 class="text-[13px] font-medium text-white/92">OPFS 5 大存储子域配额治理</h3>
                      <span
                        class="rounded-[2px] border px-1.5 py-0.5 font-mono text-[10px]"
                        :class="
                          sessionStore.isPersistedStorage
                            ? 'border-emerald-400/40 bg-emerald-500/15 text-emerald-300'
                            : 'border-white/15 bg-white/[0.06] text-white/60'
                        "
                      >
                        {{ sessionStore.isPersistedStorage ? 'Persistent Storage 已锁定' : '标准浏览器配额' }}
                      </span>
                    </div>
                    <p class="mt-0.5 font-mono text-[11px] text-white/50">
                      当前总占用：{{ formatBytes(sessionStore.totalStorageUsedBytes) }} · 探索页元数据与离线钉选资产受永不驱逐保护
                    </p>
                  </div>

                  <div class="flex flex-wrap items-center gap-1.5 text-[11px]">
                    <button
                      type="button"
                      class="flex h-7 items-center gap-1 rounded-[2px] border border-white/15 bg-white/[0.05] px-2.5 text-white/85 hover:border-white/30 hover:bg-white/10"
                      @click="sessionStore.runFullOrphanGcNow()"
                    >
                      <HardDrive class="size-3.5 text-sky-300" />
                      <span>{{ sessionStore.isCleaningStorage ? '正在清理…' : '执行孤儿缩略图与超限 GC' }}</span>
                    </button>
                    <button
                      type="button"
                      class="flex h-7 items-center gap-1 rounded-[2px] border border-white/15 bg-white/[0.05] px-2.5 text-white/85 hover:border-white/30 hover:bg-white/10"
                      @click="sessionStore.downloadColdBackupNow()"
                    >
                      <Download class="size-3.5 text-sky-300" />
                      <span>导出 .lattice-archive 冷备份</span>
                    </button>
                    <label class="flex h-7 cursor-pointer items-center gap-1 rounded-[2px] border border-sky-400/60 bg-sky-500/25 px-2.5 font-medium text-sky-100 hover:bg-sky-500/35">
                      <Upload class="size-3.5 text-sky-300" />
                      <span>导入冷备份</span>
                      <input type="file" accept=".lattice-archive,.gz,.json" class="hidden" @change="handleColdBackupFileSelect" />
                    </label>
                  </div>
                </div>

                <div class="space-y-2">
                  <div
                    v-for="sub in sessionStore.storageSubDomains"
                    :key="sub.id"
                    class="flex flex-wrap items-center justify-between gap-3 rounded-[2px] border border-white/10 bg-black/30 p-3"
                  >
                    <div class="min-w-0 flex-1 space-y-1.5">
                      <div class="flex items-center gap-2">
                        <Database class="size-3.5 text-sky-300" />
                        <span class="text-xs font-medium text-white/90">{{ sub.title }}</span>
                        <span class="rounded-[2px] border border-white/10 bg-white/[0.05] px-1.5 py-0.2 font-mono text-[10px] text-white/60">
                          策略：{{ sub.evictionPolicy }}
                        </span>
                      </div>
                      <div class="h-1.5 w-full overflow-hidden rounded-[1px] bg-white/10">
                        <div
                          class="h-full bg-sky-400 transition-all"
                          :style="{ width: `${Math.min(100, (sub.usedBytes / Math.max(1, sub.configuredLimitMB * 1024 * 1024)) * 100)}%` }"
                        />
                      </div>
                    </div>

                    <div class="flex items-center gap-3 font-mono text-[11px]">
                      <span class="tabular-nums text-white/55">
                        {{ formatBytes(sub.usedBytes) }} / {{ sub.configuredLimitMB }} MB ({{ sub.itemCount }} 项)
                      </span>
                      <button
                        v-if="sub.evictionPolicy !== 'never'"
                        type="button"
                        class="h-6 rounded-[2px] border border-white/12 px-2 text-[10px] text-white/60 hover:border-rose-400/40 hover:bg-rose-500/15 hover:text-rose-300"
                        @click="sessionStore.evictSubDomainNow(sub.id)"
                      >
                        清空缓存
                      </button>
                    </div>
                  </div>
                </div>
              </section>
            </main>
          </div>

          <!-- 跨栏拖拽幽灵浮层（将会话卡片拖入左侧 Explore 磁贴目录树） -->
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
