/**
 * chat 域页面状态：会话列表、消息窗口、同步阶段与冷启动缓存调度。
 *
 * 数据流：View（零 ref）→ chatStore action → chatDataSource → MTProto Bridge → 本地 Telegram Worker。
 * 账户与连接状态的唯一来源是 telegramStore；本 Store 只订阅，不复制连接逻辑。
 */
import { defineStore } from 'pinia';
import { effectScope, nextTick, watch } from 'vue';
import { useTelegramStore, type TelegramConnectionState } from '@/stores/telegram/stores/telegramStore';
import { chatDataSource } from '../data-sources/chatDataSource';
import { chatCacheStore } from '../data-sources/chatCacheStore';
import { chatMediaCache } from '../data-sources/chatMediaCache';
import { messageViewport } from '../data-sources/messageViewport';
import { useChatMediaStore } from './chatMediaStore';
import type { ChatSyncPhase, FeedItem, MessageWindow, SessionListItem, TgChatUpdate, TgDialogCursor, TgDialogDto, TgMessageDto, TgPeerKey, TgPeerRef, TgUpdatesState } from '../types';
import {
  DIALOG_PAGE_SIZE, MAX_DIALOG_PAGES, buildFeed, buildSnapshot, createWindow, historyPageSize, initialsOf, kindLabel,
  mergeLatestPage, orderDialogs, prependOlder, toSessionItem, trimInactiveWindow, upsertMessage,
} from './chatModel';

/** 模块作用域：调度句柄与代次计数不可序列化，不进入 Pinia state。 */
let initialized = false;
/** 每次切换账户递增；所有异步响应回来时比对，丢弃属于旧账户的结果。 */
let accountGeneration = 0;
let cacheLoadPromise: Promise<void> = Promise.resolve();
let syncPromise: Promise<void> | null = null;
let syncQueued = false;
let syncRetryTimer: number | undefined;
let saveTimer: number | undefined;
let saveDeadline = 0;
let dialogRefreshTimer: number | undefined;
let anchorTimer: number | undefined;
let dialogPages = 0;
let archivePages = 0;
/** 后台续拉剩余会话页的循环是否在跑（同一时间只允许一个）。 */
let backgroundDialogsRunning = false;
let backgroundArchiveRunning = false;
/** 已在当前滚动容器中完成定位的会话；容器首次挂载（KeepAlive 首屏）时需要补一次定位。 */
let revealedKey: TgPeerKey | null = null;

const SAVE_DEBOUNCE_MS = 3_000;
const SAVE_MAX_WAIT_MS = 15_000;
const DIALOG_REFRESH_DEBOUNCE_MS = 1_500;
const ANCHOR_DEBOUNCE_MS = 200;
const SYNC_RETRY_MS = 15_000;
const MAX_SYNC_PASSES = 3;
const RECENT_LIMIT = 20;
const LIST_LOAD_THRESHOLD_PX = 320;
/** 后台续拉会话页之间的间隔，避免连续请求触发 FLOOD_WAIT。 */
const BACKGROUND_PAGE_DELAY_MS = 400;
/** 会话栏一次渲染的条目数，滚动到底再追加；数千会话也不会一次性生成全部 DOM。 */
const LIST_RENDER_STEP = 120;
const wait = (ms: number) => new Promise<void>((resolve) => { window.setTimeout(resolve, ms); });

function peerRefFromKey(key: TgPeerKey): TgPeerRef | null {
  const match = /^(user|chat|channel)-(\d+)$/.exec(key);
  return match ? { type: match[1] as TgPeerRef['type'], id: match[2] } : null;
}

export const useChatStore = defineStore('chat', {
  state: () => ({
    /** 当前工作区的 Lattice 用户；缓存与账户偏好都按它隔离。 */
    ownerId: null as string | null,
    accountId: null as string | null,
    syncPhase: 'no-account' as ChatSyncPhase,
    syncError: null as string | null,
    lastSyncedAt: 0,
    updatesState: null as TgUpdatesState | null,
    hasCache: false,
    dialogs: {} as Record<TgPeerKey, TgDialogDto>,
    pinnedOrder: [] as TgPeerKey[],
    dialogCursor: null as TgDialogCursor | null,
    hasMoreDialogs: false,
    /** Telegram 报告的活动列表会话总数，用于展示加载进度。 */
    dialogTotal: 0,
    /** 账户存在「已归档」文件夹。 */
    hasArchivedChats: false,
    /** 当前会话列表展示的文件夹：0 = 活动会话，1 = 已归档会话。 */
    activeFolderId: 0 as 0 | 1,
    archivePinnedOrder: [] as TgPeerKey[],
    archiveCursor: null as TgDialogCursor | null,
    hasMoreArchived: false,
    archiveTotal: 0,
    archiveLoaded: false,
    isLoadingArchive: false,
    isLoadingMoreArchive: false,
    listRenderLimit: LIST_RENDER_STEP,
    isLoadingDialogs: false,
    isLoadingMoreDialogs: false,
    dialogsError: null as string | null,
    activeChatKey: null as TgPeerKey | null,
    windows: {} as Record<TgPeerKey, MessageWindow>,
    recentChatKeys: [] as TgPeerKey[],
    viewportAnchors: {} as Record<TgPeerKey, number>,
    searchKeyword: '',
    isSessionListCollapsed: false,
  }),

  getters: {
    connectionState(): TelegramConnectionState | undefined { return useTelegramStore().currentConnectionState; },
    isOnline(): boolean { return this.connectionState === 'online'; },
    isArchiveView: (state): boolean => state.activeFolderId === 1,
    accountLabel(): string {
      const account = useTelegramStore().currentAccount;
      if (!account) return '';
      return [account.first_name, account.last_name].filter(Boolean).join(' ') || (account.username ? `@${account.username}` : account.tg_user_id);
    },
    sessionItems(state): SessionListItem[] {
      const keyword = state.searchKeyword.trim().toLowerCase();
      const pinned = state.activeFolderId === 1 ? state.archivePinnedOrder : state.pinnedOrder;
      const items = orderDialogs(state.dialogs, pinned, state.activeFolderId).map(toSessionItem);
      return keyword ? items.filter((item) => item.title.toLowerCase().includes(keyword) || item.preview.toLowerCase().includes(keyword)) : items;
    },
    visibleSessionItems(): SessionListItem[] { return this.sessionItems.slice(0, this.listRenderLimit); },
    /** 主列表顶部的「已归档会话」入口（仅在活动文件夹且未搜索时展示）。 */
    archiveEntry(state): { preview: string; unreadCount: number; count: number } | null {
      if (state.activeFolderId !== 0 || state.searchKeyword.trim()) return null;
      const archived = orderDialogs(state.dialogs, state.archivePinnedOrder, 1);
      if (!state.hasArchivedChats && archived.length === 0) return null;
      const preview = archived.slice(0, 4).map((dialog) => dialog.title).join('、') || '点击查看已归档的会话';
      const unreadCount = archived.reduce((sum, dialog) => sum + (!dialog.muted ? dialog.unreadCount : 0), 0);
      return { preview, unreadCount, count: Math.max(state.archiveTotal, archived.length) };
    },
    /** 列表底部提示：加载进度 / 已全部加载。 */
    listFooter(): string {
      const loaded = this.dialogCount;
      const total = Math.max(this.currentFolderTotal, loaded);
      const hasMore = this.currentFolderHasMore;
      const isLoadingMore = this.isArchiveView ? this.isLoadingMoreArchive : this.isLoadingMoreDialogs;
      if (this.listRenderLimit < this.sessionItems.length) return '';
      if (hasMore) return isLoadingMore ? `正在加载会话 ${loaded} / ${total}…` : `已加载 ${loaded} / ${total}，继续下滑加载更多`;
      return `已显示全部 ${loaded} 个${this.isArchiveView ? '已归档' : ''}会话`;
    },
    dialogCount: (state): number => Object.values(state.dialogs).filter((dialog) => (dialog.folderId ?? 0) === state.activeFolderId).length,
    currentFolderTotal: (state): number => (state.activeFolderId === 1 ? state.archiveTotal : state.dialogTotal),
    currentFolderHasMore: (state): boolean => (state.activeFolderId === 1 ? state.hasMoreArchived : state.hasMoreDialogs),
    /** 侧栏徽标：活动列表中未静音的未读会话数。 */
    unreadChatCount: (state): number =>
      Object.values(state.dialogs).filter((dialog) => (dialog.folderId ?? 0) === 0 && !dialog.muted && (dialog.unreadCount > 0 || dialog.unreadMark)).length,
    activeDialog: (state): TgDialogDto | undefined => (state.activeChatKey ? state.dialogs[state.activeChatKey] : undefined),
    activeWindow: (state): MessageWindow | undefined => (state.activeChatKey ? state.windows[state.activeChatKey] : undefined),
    activeHeader(): { title: string; subtitle: string; initials: string } | null {
      if (!this.activeChatKey) return null;
      const dialog = this.activeDialog;
      if (!dialog) return { title: '会话', subtitle: '未在已加载的会话列表中', initials: '?' };
      return { title: dialog.title, subtitle: [kindLabel(dialog.kind), dialog.muted ? '已静音' : ''].filter(Boolean).join(' · '), initials: initialsOf(dialog.title) };
    },
    feedItems(): FeedItem[] { return buildFeed(this.activeWindow?.messages ?? [], this.activeDialog); },
    /** 会话栏顶部的同步状态：区分「仅缓存」与「已与服务器校准」。 */
    syncStatus(): { tone: 'ok' | 'muted' | 'error'; label: string } {
      const telegram = useTelegramStore();
      const notice = telegram.currentAccountId ? telegram.connectionNotices[telegram.currentAccountId] : undefined;
      switch (this.syncPhase) {
        case 'no-account': return { tone: 'muted', label: '未连接 Telegram 账户' };
        case 'cache': return { tone: 'muted', label: '显示本地缓存 · 正在连接' };
        case 'connecting': return { tone: 'muted', label: notice ?? '正在连接 Telegram…' };
        case 'syncing': return { tone: 'muted', label: this.hasCache ? '正在同步最新消息…' : '正在加载会话…' };
        case 'live': return { tone: 'ok', label: '已同步' };
        default: return { tone: 'error', label: this.syncError ?? notice ?? '连接中断，显示的可能是旧数据' };
      }
    },
    listState(): 'no-account' | 'loading' | 'error' | 'empty' | 'no-match' | 'ready' {
      if (this.syncPhase === 'no-account') return 'no-account';
      if (this.dialogCount > 0 || (this.archiveEntry !== null)) return this.sessionItems.length > 0 || this.archiveEntry !== null ? 'ready' : 'no-match';
      if (this.isArchiveView && this.isLoadingArchive) return 'loading';
      if (this.syncPhase === 'offline') return 'error';
      return this.syncPhase === 'live' ? 'empty' : 'loading';
    },
    feedState(): 'no-chat' | 'loading' | 'error' | 'waiting' | 'empty' | 'ready' {
      if (!this.activeChatKey) return 'no-chat';
      const win = this.activeWindow;
      if (win && win.messages.length > 0) return 'ready';
      if (win?.error) return 'error';
      if (win?.isLoadingLatest) return 'loading';
      if (!this.isOnline || this.syncPhase !== 'live') return 'waiting';
      return win?.fresh ? 'empty' : 'loading';
    },
    olderState(): 'loading' | 'end' | 'idle' {
      const win = this.activeWindow;
      if (!win || win.messages.length === 0) return 'idle';
      if (win.isLoadingOlder) return 'loading';
      return win.hasOlder ? 'idle' : 'end';
    },
  },

  actions: {
    /**
     * 幂等：订阅 Worker 更新、跟随 telegram 域的当前账户与连接状态，并引导连接。
     * owner 变化（同一标签页换人登录）时先清空上一位用户的全部聊天内存态。
     */
    initialize(owner: string) {
      const telegram = useTelegramStore();
      if (this.ownerId !== owner) {
        if (this.ownerId && this.accountId) void this.persistNow();
        accountGeneration += 1;
        this.resetContent();
        this.ownerId = owner;
        this.accountId = null;
        this.activeChatKey = null;
        this.syncPhase = 'no-account';
      }
      void telegram.ensureBootstrapped(owner);
      useChatMediaStore().init();
      if (!initialized) {
        initialized = true;
        chatDataSource.subscribeUpdates((accountId, updates, state) => this.handleLiveUpdates(accountId, updates, state));
        chatDataSource.onPageHidden(() => { void this.persistNow(); });
        // 独立作用域：watcher 不能挂在首次调用 initialize 的组件上，否则组件卸载即失效。
        effectScope(true).run(() => {
          watch(() => telegram.currentAccountId, (accountId) => { void this.bindAccount(accountId); });
          watch(() => telegram.currentConnectionState, (state) => this.handleConnectionChange(state));
        });
      }
      // 换人后账户 ID 可能恰好不变，watcher 不会触发，这里显式绑定一次（bindAccount 自带去重）。
      void this.bindAccount(telegram.currentAccountId);
      this.handleConnectionChange(telegram.currentConnectionState);
    },

    async bindAccount(accountId: string | null) {
      if (accountId === this.accountId && this.syncPhase !== 'no-account') return;
      if (this.accountId) void this.persistNow();
      const generation = ++accountGeneration;
      // 冷启动时路由可能先于账户确定选中会话，首次绑定保留它；切换账户则清空。
      const keepActive = this.accountId === null ? this.activeChatKey : null;
      this.resetContent();
      this.accountId = accountId;
      this.activeChatKey = keepActive;
      if (!accountId || !this.ownerId) {
        this.syncPhase = 'no-account';
        cacheLoadPromise = Promise.resolve();
        return;
      }
      this.syncPhase = 'connecting';
      cacheLoadPromise = this.loadCache(this.ownerId, accountId, generation);
      await cacheLoadPromise;
      if (generation === accountGeneration && this.isOnline) void this.syncNow();
    },

    resetContent() {
      window.clearTimeout(saveTimer);
      window.clearTimeout(dialogRefreshTimer);
      window.clearTimeout(syncRetryTimer);
      saveTimer = undefined; saveDeadline = 0; dialogPages = 0; archivePages = 0; revealedKey = null;
      // 旧账户的同步循环会在代次校验处自行退出，新账户无需排队等待它。
      syncPromise = null; syncQueued = false;
      this.dialogs = {}; this.pinnedOrder = []; this.windows = {}; this.recentChatKeys = []; this.viewportAnchors = {};
      this.dialogCursor = null; this.hasMoreDialogs = false; this.dialogsError = null;
      this.dialogTotal = 0; this.hasArchivedChats = false; this.listRenderLimit = LIST_RENDER_STEP;
      this.activeFolderId = 0; this.archivePinnedOrder = []; this.archiveCursor = null;
      this.hasMoreArchived = false; this.archiveTotal = 0; this.archiveLoaded = false;
      this.isLoadingArchive = false; this.isLoadingMoreArchive = false;
      this.updatesState = null; this.hasCache = false; this.syncError = null; this.lastSyncedAt = 0;
      // 消息窗口清空后，对应的 Object URL / 加载队列 / 查看器也必须一并回收。
      useChatMediaStore().reset();
    },

    async loadCache(ownerId: string, accountId: string, generation: number) {
      const snapshot = await chatCacheStore.read(ownerId, accountId);
      if (generation !== accountGeneration || !snapshot) return;
      this.dialogs = Object.fromEntries(snapshot.dialogs.map((dialog) => [dialog.key, dialog]));
      this.pinnedOrder = snapshot.pinnedOrder;
      this.windows = Object.fromEntries(Object.entries(snapshot.windows).map(([key, item]) => [key, createWindow(item.messages, item.hasOlder, true)]));
      this.recentChatKeys = snapshot.recentChatKeys;
      this.viewportAnchors = snapshot.viewportAnchors;
      this.updatesState = snapshot.updatesState;
      this.hasCache = true;
      if (this.syncPhase === 'connecting') this.syncPhase = 'cache';
      if (!this.activeChatKey) this.activeChatKey = snapshot.activeChatKey;
      else if (!this.windows[this.activeChatKey]) this.windows[this.activeChatKey] = createWindow();
      void this.revealActive();
    },

    handleConnectionChange(state: TelegramConnectionState | undefined) {
      if (!this.accountId) return;
      if (state === 'online') {
        if (this.syncPhase !== 'live' && this.syncPhase !== 'syncing') void this.syncNow();
        return;
      }
      if (state === 'auth-expired') {
        // 授权被撤销：本机缓存的聊天内容与媒体必须一并清除。
        const accountId = this.accountId;
        this.resetContent();
        if (this.ownerId) {
          void chatCacheStore.remove(this.ownerId, accountId);
          void chatMediaCache.removeScope(chatMediaCache.scopeOf(this.ownerId, accountId));
        }
        this.syncPhase = 'offline';
        this.syncError = '本设备的 Telegram 授权已失效，请在设置中重新添加';
        return;
      }
      if (state === undefined || state === 'connecting') {
        this.syncPhase = this.hasCache ? 'cache' : 'connecting';
        return;
      }
      this.syncPhase = 'offline';
    },

    /** 补差 + 刷新会话首页 + 刷新当前会话；并发调用合并，期间收到缺口信号则再跑一轮。 */
    syncNow(): Promise<void> {
      if (syncPromise) { syncQueued = true; return syncPromise; }
      window.clearTimeout(syncRetryTimer);
      const run: Promise<void> = (async () => {
        let passes = 0;
        do {
          syncQueued = false;
          passes += 1;
          await this.runSync();
        } while (syncQueued && passes < MAX_SYNC_PASSES && this.isOnline);
      })().finally(() => { if (syncPromise === run) syncPromise = null; });
      syncPromise = run;
      return run;
    },

    async runSync() {
      const accountId = this.accountId;
      const generation = accountGeneration;
      if (!accountId) return;
      await cacheLoadPromise;
      if (generation !== accountGeneration || !this.isOnline) return;
      this.syncPhase = 'syncing';
      this.syncError = null;
      try {
        const result = await chatDataSource.syncFrom(accountId, this.updatesState);
        if (generation !== accountGeneration) return;
        if (result.kind === 'difference') {
          this.applyUpdates(result.updates);
          // 公共差异不含频道消息，频道窗口无法证明连续，打开时重新拉取最新页。
          this.invalidateWindows((key) => key.startsWith('channel-'));
        } else {
          this.invalidateWindows(() => true);
        }
        this.updatesState = result.state;
        await this.refreshDialogs(generation);
        if (generation !== accountGeneration) return;
        if (this.activeChatKey) await this.loadLatest(this.activeChatKey);
        if (generation !== accountGeneration) return;
        this.syncPhase = 'live';
        this.lastSyncedAt = Date.now();
        this.scheduleSave();
        void this.loadRemainingDialogs();
        if (this.hasArchivedChats || this.isArchiveView) void this.refreshArchiveDialogs(generation).catch(() => undefined);
      } catch (error) {
        if (generation !== accountGeneration) return;
        this.syncError = chatDataSource.readError(error);
        this.syncPhase = 'offline';
        // 连接仍在线说明是临时失败，稍后自动重试一次；连接断开则等待恢复事件。
        if (this.isOnline) syncRetryTimer = window.setTimeout(() => { if (this.isOnline && this.syncPhase === 'offline') void this.syncNow(); }, SYNC_RETRY_MS);
      }
    },

    invalidateWindows(predicate: (key: TgPeerKey) => boolean) {
      for (const [key, win] of Object.entries(this.windows)) {
        if (!predicate(key)) continue;
        win.continuous = false;
        win.fresh = false;
      }
    },

    /** 用户手动重试：连接在线则重新同步，否则交给 telegram 域重新恢复会话。 */
    retrySync() {
      if (this.isOnline) { void this.syncNow(); return; }
      if (this.accountId && this.connectionState !== 'auth-expired') void useTelegramStore().reconnectAccount(this.accountId);
    },

    /**
     * 刷新会话首页并与已加载的更深分页合并（而不是整体替换）：
     * - 首页就是全部 → 以服务器为准整体替换；
     * - 否则，首页时间范围内本应出现却缺席的会话视为已删除 / 退出 / 归档并移除，更早的分页保持不动；
     * - 置顶集合变化时重置分页游标并重新后台续拉，确保被取消置顶的会话回到正确位置。
     */
    async refreshDialogs(generation = accountGeneration) {
      const accountId = this.accountId;
      if (!accountId) return;
      this.isLoadingDialogs = true;
      this.dialogsError = null;
      try {
        const page = await chatDataSource.getDialogs(accountId, 0, undefined, DIALOG_PAGE_SIZE);
        if (generation !== accountGeneration) return;
        const pageKeys = new Set(page.dialogs.map((dialog) => dialog.key));
        const activeKey = this.activeChatKey;
        const next: Record<TgPeerKey, TgDialogDto> = {};
        // 保留已加载的归档会话（folderId === 1），仅对活动会话（folderId === 0）做合并校准。
        for (const [key, dialog] of Object.entries(this.dialogs)) {
          if ((dialog.folderId ?? 0) === 1) next[key] = dialog;
        }
        if (!page.hasMore) {
          for (const dialog of page.dialogs) next[dialog.key] = dialog;
          // 当前打开的会话保留，以免头部信息与 peer 引用丢失。
          if (activeKey && !next[activeKey] && this.dialogs[activeKey]) next[activeKey] = this.dialogs[activeKey];
        } else {
          const unpinnedDates = page.dialogs.filter((dialog) => !dialog.pinned).map((dialog) => dialog.date);
          const oldest = unpinnedDates.length > 0 ? Math.min(...unpinnedDates) : Number.POSITIVE_INFINITY;
          for (const [key, dialog] of Object.entries(this.dialogs)) {
            if ((dialog.folderId ?? 0) !== 0) continue;
            if (pageKeys.has(key)) continue;
            if (key === activeKey || (!dialog.pinned && dialog.date < oldest)) next[key] = dialog;
          }
          for (const dialog of page.dialogs) next[dialog.key] = dialog;
        }
        const pinnedKeys = page.pinnedKeys ?? [];
        const pinnedChanged = pinnedKeys.join(',') !== this.pinnedOrder.join(',');
        this.dialogs = next;
        this.pinnedOrder = pinnedKeys;
        this.dialogTotal = page.totalCount;
        this.hasArchivedChats = Boolean(page.hasArchive) || Object.values(next).some((dialog) => (dialog.folderId ?? 0) === 1);
        // 已经续拉到更深分页时保留游标，避免每次实时刷新都从第 2 页重走。
        if (dialogPages <= 1 || !page.hasMore || pinnedChanged) {
          this.dialogCursor = page.nextCursor ?? null;
          this.hasMoreDialogs = page.hasMore;
          dialogPages = 1;
          if (pinnedChanged && page.hasMore && this.syncPhase === 'live') void this.loadRemainingDialogs();
        }
      } catch (error) {
        if (generation === accountGeneration) this.dialogsError = chatDataSource.readError(error);
        throw error;
      } finally {
        if (generation === accountGeneration) this.isLoadingDialogs = false;
      }
    },

    async refreshArchiveDialogs(generation = accountGeneration) {
      const accountId = this.accountId;
      if (!accountId || this.isLoadingArchive) return;
      this.isLoadingArchive = true;
      try {
        const page = await chatDataSource.getDialogs(accountId, 1, undefined, DIALOG_PAGE_SIZE);
        if (generation !== accountGeneration) return;
        const next: Record<TgPeerKey, TgDialogDto> = {};
        for (const [key, dialog] of Object.entries(this.dialogs)) {
          if ((dialog.folderId ?? 0) === 0 || key === this.activeChatKey) next[key] = dialog;
        }
        for (const dialog of page.dialogs) next[dialog.key] = dialog;
        this.dialogs = next;
        this.archivePinnedOrder = page.pinnedKeys ?? [];
        this.archiveTotal = page.totalCount;
        this.archiveCursor = page.nextCursor ?? null;
        this.hasMoreArchived = page.hasMore;
        this.archiveLoaded = true;
        this.hasArchivedChats = this.hasArchivedChats || page.totalCount > 0 || page.dialogs.length > 0;
        archivePages = 1;
        if (this.isArchiveView && page.hasMore && this.syncPhase === 'live') void this.loadRemainingArchiveDialogs();
      } finally {
        if (generation === accountGeneration) this.isLoadingArchive = false;
      }
    },

    async loadRemainingArchiveDialogs() {
      if (backgroundArchiveRunning) return;
      backgroundArchiveRunning = true;
      const generation = accountGeneration;
      try {
        while (generation === accountGeneration && this.isArchiveView && this.hasMoreArchived && this.syncPhase === 'live' && archivePages < MAX_DIALOG_PAGES) {
          const before = archivePages;
          await this.loadMoreArchiveDialogs();
          if (archivePages === before) break;
          await wait(BACKGROUND_PAGE_DELAY_MS);
        }
      } finally {
        backgroundArchiveRunning = false;
      }
    },

    async loadMoreArchiveDialogs() {
      const accountId = this.accountId;
      const cursor = this.archiveCursor;
      if (!accountId || !cursor || !this.hasMoreArchived || this.isLoadingMoreArchive || this.isLoadingArchive) return;
      if (this.syncPhase !== 'live' || archivePages >= MAX_DIALOG_PAGES) return;
      const generation = accountGeneration;
      this.isLoadingMoreArchive = true;
      try {
        const page = await chatDataSource.getDialogs(accountId, 1, cursor, DIALOG_PAGE_SIZE);
        if (generation !== accountGeneration) return;
        for (const dialog of page.dialogs) this.dialogs[dialog.key] = dialog;
        this.archiveTotal = Math.max(this.archiveTotal, page.totalCount);
        const stalled = JSON.stringify(page.nextCursor) === JSON.stringify(cursor);
        this.archiveCursor = page.nextCursor ?? null;
        this.hasMoreArchived = page.hasMore && !stalled && page.dialogs.length > 0;
        archivePages += 1;
      } finally {
        if (generation === accountGeneration) this.isLoadingMoreArchive = false;
      }
    },

    /** 参考实现的做法：首页可交互后，在后台按间隔续拉其余活动会话，直到全部加载或达到保护上限。 */
    async loadRemainingDialogs() {
      if (backgroundDialogsRunning) return;
      backgroundDialogsRunning = true;
      const generation = accountGeneration;
      try {
        while (generation === accountGeneration && this.hasMoreDialogs && this.syncPhase === 'live' && dialogPages < MAX_DIALOG_PAGES) {
          const before = dialogPages;
          await this.loadMoreDialogs();
          // 本轮失败或被并发的滚动加载占用时，交给下一次同步 / 滚动再继续，不反复重试。
          if (this.dialogsError || dialogPages === before) break;
          await wait(BACKGROUND_PAGE_DELAY_MS);
        }
      } finally {
        backgroundDialogsRunning = false;
      }
    },

    async loadMoreDialogs() {
      const accountId = this.accountId;
      const cursor = this.dialogCursor;
      if (!accountId || !cursor || !this.hasMoreDialogs || this.isLoadingMoreDialogs || this.isLoadingDialogs) return;
      if (this.syncPhase !== 'live' || dialogPages >= MAX_DIALOG_PAGES) return;
      const generation = accountGeneration;
      this.isLoadingMoreDialogs = true;
      this.dialogsError = null;
      try {
        const page = await chatDataSource.getDialogs(accountId, 0, cursor, DIALOG_PAGE_SIZE);
        if (generation !== accountGeneration) return;
        for (const dialog of page.dialogs) this.dialogs[dialog.key] = dialog;
        this.dialogTotal = Math.max(this.dialogTotal, page.totalCount);
        const stalled = JSON.stringify(page.nextCursor) === JSON.stringify(cursor);
        this.dialogCursor = page.nextCursor ?? null;
        this.hasMoreDialogs = page.hasMore && !stalled && page.dialogs.length > 0;
        dialogPages += 1;
      } catch (error) {
        if (generation === accountGeneration) this.dialogsError = chatDataSource.readError(error);
      } finally {
        if (generation === accountGeneration) this.isLoadingMoreDialogs = false;
      }
    },

    /** 滚到底部：先追加渲染已加载的条目，全部渲染后再向服务器要下一页。 */
    handleSessionListScroll(scrollTop: number, scrollHeight: number, clientHeight: number) {
      if (scrollHeight - scrollTop - clientHeight > LIST_LOAD_THRESHOLD_PX) return;
      if (this.listRenderLimit < this.sessionItems.length) this.listRenderLimit += LIST_RENDER_STEP;
      else if (this.isArchiveView) void this.loadMoreArchiveDialogs();
      else void this.loadMoreDialogs();
    },

    openArchiveFolder() {
      this.activeFolderId = 1;
      this.listRenderLimit = LIST_RENDER_STEP;
      if (!this.archiveLoaded && this.syncPhase === 'live') void this.refreshArchiveDialogs().catch(() => undefined);
      else if (this.hasMoreArchived && this.syncPhase === 'live') void this.loadRemainingArchiveDialogs();
    },

    closeArchiveFolder() {
      this.activeFolderId = 0;
      this.listRenderLimit = LIST_RENDER_STEP;
    },

    scheduleDialogRefresh() {
      window.clearTimeout(dialogRefreshTimer);
      dialogRefreshTimer = window.setTimeout(() => {
        if (this.syncPhase === 'live') {
          this.refreshDialogs().catch(() => undefined);
          if (this.isArchiveView || this.archiveLoaded) this.refreshArchiveDialogs().catch(() => undefined);
        }
      }, DIALOG_REFRESH_DEBOUNCE_MS);
    },

    peerRefOf(key: TgPeerKey): TgPeerRef | null { return this.dialogs[key]?.peer ?? peerRefFromKey(key); },

    /** 路由驱动：打开会话，保存上一会话的阅读位置，必要时刷新最新页。 */
    async openChat(key: TgPeerKey) {
      const previous = this.activeChatKey;
      if (previous && previous !== key) this.leaveChat(previous);
      this.activeChatKey = key;
      this.recentChatKeys = [key, ...this.recentChatKeys.filter((item) => item !== key)].slice(0, RECENT_LIMIT);
      if (!this.windows[key]) this.windows[key] = createWindow();
      if (previous !== key || revealedKey !== key) await this.revealActive();
      const win = this.windows[key];
      if (win && !win.fresh && !win.isLoadingLatest && this.syncPhase === 'live') void this.loadLatest(key);
      this.scheduleSave();
    },

    leaveChat(key: TgPeerKey) {
      this.captureAnchor(key);
      const win = this.windows[key];
      if (win && trimInactiveWindow(win)) {
        const anchor = this.viewportAnchors[key];
        if (anchor && !win.messages.some((message) => message.id === anchor)) delete this.viewportAnchors[key];
      }
    },

    async revealActive() {
      const key = this.activeChatKey;
      await nextTick();
      if (!key || key !== this.activeChatKey) return;
      const anchor = this.viewportAnchors[key];
      if (!anchor || !messageViewport.scrollToMessage(anchor)) messageViewport.scrollToBottom();
      revealedKey = messageViewport.isAttached() && (this.activeWindow?.messages.length ?? 0) > 0 ? key : null;
      this.fillViewport();
    },

    /** 内容不足一屏时不会触发滚动事件，主动补拉更早历史。 */
    fillViewport() {
      const win = this.activeWindow;
      if (win?.hasOlder && win.messages.length > 0 && messageViewport.isNearTop()) void this.loadOlder();
    },

    async loadLatest(key: TgPeerKey) {
      const accountId = this.accountId;
      const win = this.windows[key];
      const peer = this.peerRefOf(key);
      if (!accountId || !win || win.isLoadingLatest) return;
      if (!peer) { win.error = '无法识别该会话'; return; }
      const generation = accountGeneration;
      const epoch = win.epoch;
      const stick = key === this.activeChatKey && (win.messages.length === 0 || messageViewport.isNearBottom());
      win.isLoadingLatest = true;
      win.error = null;
      try {
        const page = await chatDataSource.getHistory(accountId, peer, 0, historyPageSize());
        const current = this.windows[key];
        if (generation !== accountGeneration || !current) return;
        mergeLatestPage(current, page);
        this.scheduleSave();
        if (key !== this.activeChatKey) return;
        await nextTick();
        if (stick || current.epoch !== epoch) messageViewport.scrollToBottom();
        this.fillViewport();
      } catch (error) {
        if (generation === accountGeneration && this.windows[key]) this.windows[key].error = chatDataSource.readError(error);
      } finally {
        if (generation === accountGeneration && this.windows[key]) this.windows[key].isLoadingLatest = false;
      }
    },

    async loadOlder(target?: TgPeerKey) {
      const key = target ?? this.activeChatKey;
      const accountId = this.accountId;
      const win = key ? this.windows[key] : undefined;
      const peer = key ? this.peerRefOf(key) : null;
      if (!key || !accountId || !win || !peer || !this.isOnline) return;
      if (!win.hasOlder || win.isLoadingOlder || win.isLoadingLatest || win.messages.length === 0) return;
      const generation = accountGeneration;
      const epoch = win.epoch;
      win.isLoadingOlder = true;
      try {
        const page = await chatDataSource.getHistory(accountId, peer, win.messages[0].id, historyPageSize());
        const current = this.windows[key];
        // 窗口在请求期间被整体替换（缺口重建 / 裁剪）时，旧锚点的翻页结果不再适用。
        if (generation !== accountGeneration || !current || current.epoch !== epoch) return;
        const snapshot = key === this.activeChatKey ? messageViewport.capture() : null;
        prependOlder(current, page);
        if (key === this.activeChatKey) {
          await nextTick();
          messageViewport.restoreAfterPrepend(snapshot);
        }
      } catch (error) {
        if (generation === accountGeneration && this.windows[key]) this.windows[key].error = chatDataSource.readError(error);
      } finally {
        if (generation === accountGeneration && this.windows[key]) this.windows[key].isLoadingOlder = false;
      }
    },

    retryActive() {
      const key = this.activeChatKey;
      if (!key) return;
      if (this.syncPhase !== 'live') { this.retrySync(); return; }
      const win = this.windows[key];
      if (win) win.error = null;
      void (win && win.messages.length > 0 ? this.loadOlder(key) : this.loadLatest(key));
    },

    handleFeedScroll() {
      if (messageViewport.isNearTop()) void this.loadOlder();
      window.clearTimeout(anchorTimer);
      const key = this.activeChatKey;
      anchorTimer = window.setTimeout(() => { if (key && key === this.activeChatKey) this.captureAnchor(key); }, ANCHOR_DEBOUNCE_MS);
    },

    /** 贴底时不记锚点（下次打开直接看最新）；否则记录视口顶部第一条消息。 */
    captureAnchor(key: TgPeerKey) {
      if (!messageViewport.isAttached()) return;
      const anchor = messageViewport.isNearBottom() ? null : messageViewport.topVisibleMessageId();
      if (anchor) this.viewportAnchors[key] = anchor;
      else delete this.viewportAnchors[key];
      this.scheduleSave();
    },

    handleLiveUpdates(accountId: string, updates: TgChatUpdate[], state?: TgUpdatesState) {
      if (accountId !== this.accountId) return;
      this.applyUpdates(updates);
      // 只有已完成补差的标签页才能前移本地状态，否则会跳过自己尚未见过的更新。
      if (state && this.syncPhase === 'live') this.updatesState = state;
      this.scheduleSave();
    },

    applyUpdates(updates: TgChatUpdate[]) {
      const activeKey = this.activeChatKey;
      const stick = activeKey ? messageViewport.isNearBottom() : false;
      let activeGrew = false;
      for (const update of updates) {
        if (update.type === 'newMessage') {
          this.applyNewMessage(update.message);
          if (update.message.peerKey === activeKey) activeGrew = true;
        } else if (update.type === 'editMessage') this.applyEditedMessage(update.message);
        else if (update.type === 'deleteMessages') this.applyDeletedMessages(update.ids, update.peerKey);
        else if (update.type === 'readInbox') {
          const dialog = this.dialogs[update.peerKey];
          if (!dialog) continue;
          dialog.readInboxMaxId = Math.max(dialog.readInboxMaxId, update.maxId);
          dialog.unreadCount = update.stillUnreadCount ?? (update.maxId >= dialog.topMessageId ? 0 : dialog.unreadCount);
          dialog.unreadMark = false;
        } else if (update.type === 'readOutbox') {
          const dialog = this.dialogs[update.peerKey];
          if (dialog) dialog.readOutboxMaxId = Math.max(dialog.readOutboxMaxId, update.maxId);
        } else if (update.type === 'channelTooLong') {
          this.invalidateWindows((key) => key === update.peerKey);
          if (update.peerKey === activeKey && this.syncPhase === 'live') void this.loadLatest(update.peerKey);
          this.scheduleDialogRefresh();
        } else if (update.type === 'dialogsChanged') this.scheduleDialogRefresh();
        else if (update.type === 'gap') void this.syncNow();
      }
      if (activeGrew && stick) void nextTick(() => messageViewport.scrollToBottom());
    },

    applyNewMessage(message: TgMessageDto) {
      const dialog = this.dialogs[message.peerKey];
      if (dialog && message.id > dialog.topMessageId) {
        // 以 topMessageId 去重：补差与实时广播可能重复投递同一条消息，未读数不能重复累加。
        dialog.topMessageId = message.id;
        dialog.lastMessage = message;
        dialog.date = message.date;
        if (!message.out && message.id > dialog.readInboxMaxId) dialog.unreadCount += 1;
      } else if (!dialog && this.syncPhase === 'live') this.scheduleDialogRefresh();
      const win = this.windows[message.peerKey];
      // 不连续的窗口插入新消息会制造永久空洞，只能等打开时整体校准。
      if (win?.continuous) upsertMessage(win, message);
    },

    applyEditedMessage(message: TgMessageDto) {
      const win = this.windows[message.peerKey];
      if (win && win.messages.some((item) => item.id === message.id)) upsertMessage(win, message);
      const dialog = this.dialogs[message.peerKey];
      if (dialog?.topMessageId === message.id) dialog.lastMessage = message;
    },

    /** peerKey 缺省时属于公共消息盒，ID 在私聊与基础群之间全局唯一。 */
    applyDeletedMessages(ids: number[], peerKey?: TgPeerKey) {
      const removed = new Set(ids);
      const matches = (key: TgPeerKey) => (peerKey ? key === peerKey : !key.startsWith('channel-'));
      for (const [key, win] of Object.entries(this.windows)) {
        if (matches(key)) win.messages = win.messages.filter((message) => !removed.has(message.id));
      }
      const touchedTop = Object.values(this.dialogs).some((dialog) => matches(dialog.key) && removed.has(dialog.topMessageId));
      if (touchedTop) this.scheduleDialogRefresh();
    },

    scheduleSave() {
      if (!this.accountId) return;
      const now = Date.now();
      if (!saveDeadline) saveDeadline = now + SAVE_MAX_WAIT_MS;
      window.clearTimeout(saveTimer);
      saveTimer = window.setTimeout(() => { void this.persistNow(); }, Math.min(SAVE_DEBOUNCE_MS, Math.max(0, saveDeadline - now)));
    },

    /** 快照在同步阶段构建完成（切换账户前调用也安全），之后才异步加密写盘。 */
    persistNow(): Promise<void> {
      window.clearTimeout(saveTimer);
      saveTimer = undefined;
      saveDeadline = 0;
      if (!this.ownerId || !this.accountId || Object.keys(this.dialogs).length === 0) return Promise.resolve();
      return chatCacheStore.write(buildSnapshot({
        ownerId: this.ownerId,
        accountId: this.accountId,
        updatesState: this.updatesState,
        dialogs: this.dialogs,
        pinnedOrder: this.pinnedOrder,
        windows: this.windows,
        recentChatKeys: this.recentChatKeys,
        activeChatKey: this.activeChatKey,
        viewportAnchors: this.viewportAnchors,
      }));
    },

    setSearchKeyword(keyword: string) { this.searchKeyword = keyword; this.listRenderLimit = LIST_RENDER_STEP; },
    toggleSessionList() { this.isSessionListCollapsed = !this.isSessionListCollapsed; },
    collapseSessionList() { this.isSessionListCollapsed = true; },
  },
});
