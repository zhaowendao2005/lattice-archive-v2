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
import type {
  ChatSyncPhase, FeedItem, MessageWindow, RichTextSegment, SessionListItem, TgChatUpdate, TgDialogCursor,
  TgDialogDto, TgInlineButton, TgInvitePreview, TgMessageDto, TgPeerKey, TgPeerRef, TgUpdatesState,
} from '../types';
import {
  DIALOG_PAGE_SIZE, MAX_DIALOG_PAGES, avatarKey, buildFeed, buildSnapshot, createWindow, historyPageSize, initialsOf, kindLabel,
  mergeHistoryAround, mergeLatestPage, orderDialogs, parseTelegramLink, prependOlder, toSessionItem, trimInactiveWindow, upsertMessage,
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
let resolveUsernameTimer: number | undefined;
let highlightTimer: number | undefined;
let callbackNoticeTimer: number | undefined;
let resolveSequence = 0;
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
const RESOLVE_DEBOUNCE_MS = 350;
const SYNC_RETRY_MS = 15_000;
const MAX_SYNC_PASSES = 3;
const RECENT_LIMIT = 20;
const LIST_LOAD_THRESHOLD_PX = 320;
/** 后台续拉会话页之间的间隔，避免连续请求触发 FLOOD_WAIT。 */
const BACKGROUND_PAGE_DELAY_MS = 400;
/** 会话栏一次渲染的条目数，滚动到底再追加；数千会话也不会一次性生成全部 DOM。 */
const LIST_RENDER_STEP = 120;
const wait = (ms: number) => new Promise<void>((resolve) => { window.setTimeout(resolve, ms); });

function looksLikeUsernameQuery(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('@')) return /^@[a-zA-Z][a-zA-Z0-9_]{3,31}$/.test(trimmed);
  if (/^(?:https?:\/\/)?(?:t\.me|telegram\.me)\//i.test(trimmed)) {
    return /^(?:https?:\/\/)?(?:t\.me|telegram\.me)\/(?!joinchat\/|\+|c\/)[a-zA-Z][a-zA-Z0-9_]{3,31}(?:[/?#].*)?$/i.test(trimmed);
  }
  return /^[a-zA-Z][a-zA-Z0-9_]{4,31}$/.test(trimmed);
}

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
    /** 正在执行归档 / 取消归档的会话键集合。 */
    archivingKeys: {} as Record<TgPeerKey, true>,
    /** 归档 / 加入等会话动作的提示或错误文本。 */
    actionError: null as string | null,
    /** 搜索框输入公开 @username 时解析到的会话摘要。 */
    resolvedDialog: null as TgDialogDto | null,
    isResolvingUsername: false,
    resolveError: null as string | null,
    /** 公开频道 / 超级群组加入态。 */
    isJoining: false,
    joinNotice: null as string | null,
    /** 退出群组 / 频道二次确认弹窗目标与状态。 */
    leaveTargetKey: null as TgPeerKey | null,
    isLeaving: false,
    leaveError: null as string | null,
    /** 会话访问历史栈（用于群组/频道/会话跳转后按访问顺序返回，栈原则）。 */
    chatHistoryStack: [] as TgPeerKey[],
    /** 删除会话二次确认弹窗目标与状态（针对用户间私聊，支持同时为对方删除）。 */
    deleteTargetKey: null as TgPeerKey | null,
    deleteRevokeForBoth: true as boolean,
    isDeletingChat: false as boolean,
    deleteChatError: null as string | null,
    /** 已点开的剧透文本与折叠引用块集合（键为 `${messageId}:${offset}`）。 */
    revealedSpoilers: {} as Record<string, true>,
    /** 正在请求中的内联 Callback 按钮集合（键为 `${messageId}:${row}:${col}`）。 */
    pendingCallbacks: {} as Record<string, true>,
    /** 点击机器人按钮或复制文本后的反馈提示。 */
    callbackNotice: null as string | null,
    /** 跨消息跳转定位后短暂高亮的目标消息 ID。 */
    highlightedMessageId: null as number | null,
    /** 各会话底部的待发送草稿文本。 */
    drafts: {} as Record<TgPeerKey, string>,
    /** 各会话最近一次由用户主动发出的文本（用于搜索机器人无 replyToId 时自动关联查询词）。 */
    lastSentQueryByPeer: {} as Record<TgPeerKey, string>,
    /** 各会话当前选中的待回复消息目标。 */
    replyingTo: {} as Record<TgPeerKey, { id: number; senderName: string; text: string }>,
    /** 正在发送消息或唤醒机器人。 */
    isSendingMessage: false,
    /** 私有邀请链接（+hash）弹窗预览状态。 */
    invitePreview: null as TgInvitePreview | null,
    isCheckingInvite: false,
    isImportingInvite: false,
    inviteError: null as string | null,
    /** L1 内存热快照缓存（供 P0/P1 多账号 <16ms 零闪烁切换使用） */
    accountSnapshots: {} as Record<string, {
      dialogs: Record<TgPeerKey, TgDialogDto>;
      pinnedOrder: TgPeerKey[];
      archivePinnedOrder: TgPeerKey[];
      activeChatKey: TgPeerKey | null;
      windows: Record<TgPeerKey, MessageWindow>;
      updatesState: TgUpdatesState | null;
      hasArchivedChats: boolean;
      dialogTotal: number;
      archiveTotal: number;
    }>,
    /** 会话栏顶部多账号快切弹出层开关（零本地 ref） */
    isAccountSwitcherOpen: false,
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
      const cleanKeyword = keyword.replace(/^@/, '');
      const pinned = state.activeFolderId === 1 ? state.archivePinnedOrder : state.pinnedOrder;
      const items = orderDialogs(state.dialogs, pinned, state.activeFolderId).map(toSessionItem);
      return keyword
        ? items.filter((item) =>
            item.title.toLowerCase().includes(keyword) ||
            item.preview.toLowerCase().includes(keyword) ||
            (cleanKeyword.length > 0 && (state.dialogs[item.key]?.username?.toLowerCase().includes(cleanKeyword) ?? false)))
        : items;
    },
    visibleSessionItems(): SessionListItem[] { return this.sessionItems.slice(0, this.listRenderLimit); },
    /** 搜索公开 @username 解析出的结果项（当不在当前本地过滤结果中时展示）。 */
    resolvedSearchItem(state): (SessionListItem & { username?: string; participantsCount?: number; isJoined: boolean }) | null {
      const dialog = state.resolvedDialog;
      if (!dialog || !state.searchKeyword.trim()) return null;
      if (this.sessionItems.some((item) => item.key === dialog.key)) return null;
      const base = toSessionItem(dialog);
      const subParts = [
        dialog.username ? `@${dialog.username}` : '',
        dialog.participantsCount ? `${dialog.participantsCount.toLocaleString('zh-CN')} 位成员` : kindLabel(dialog.kind),
      ].filter(Boolean);
      return {
        ...base,
        preview: subParts.join(' · ') || base.preview,
        username: dialog.username,
        participantsCount: dialog.participantsCount,
        isJoined: Boolean(state.dialogs[dialog.key] && !state.dialogs[dialog.key].left && !state.dialogs[dialog.key].kicked),
      };
    },
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
    activeDialog(state): TgDialogDto | undefined {
      if (!state.activeChatKey) return undefined;
      return state.dialogs[state.activeChatKey] ?? (state.resolvedDialog?.key === state.activeChatKey ? state.resolvedDialog : undefined);
    },
    activeWindow: (state): MessageWindow | undefined => (state.activeChatKey ? state.windows[state.activeChatKey] : undefined),
    activeHeader(): {
      key: TgPeerKey;
      title: string;
      subtitle: string;
      initials: string;
      avatarKey?: string;
      avatarThumb?: string;
      canArchive: boolean;
      archived: boolean;
      isArchiving: boolean;
      canJoin: boolean;
      joinRequest: boolean;
      joinPending: boolean;
      canLeave: boolean;
      canDelete: boolean;
      isCreator: boolean;
    } | null {
      if (!this.activeChatKey) return null;
      const dialog = this.activeDialog;
      if (!dialog) {
        return {
          key: this.activeChatKey,
          title: '会话',
          subtitle: '未在已加载的会话列表中',
          initials: '?',
          canArchive: false,
          archived: false,
          isArchiving: false,
          canJoin: false,
          joinRequest: false,
          joinPending: false,
          canLeave: false,
          canDelete: false,
          isCreator: false,
        };
      }
      const inDialogs = Boolean(this.dialogs[dialog.key]);
      const isMember = inDialogs && !dialog.left && !dialog.kicked;
      const subParts = [
        kindLabel(dialog.kind),
        dialog.username ? `@${dialog.username}` : '',
        dialog.participantsCount ? `${dialog.participantsCount.toLocaleString('zh-CN')} 位成员` : '',
        dialog.muted ? '已静音' : '',
        (dialog.folderId ?? 0) === 1 ? '已归档' : '',
      ].filter(Boolean);
      return {
        key: dialog.key,
        title: dialog.title,
        subtitle: subParts.join(' · '),
        initials: initialsOf(dialog.title),
        avatarKey: dialog.avatar ? avatarKey(dialog.key, dialog.avatar) : undefined,
        avatarThumb: dialog.avatar?.thumb,
        canArchive: isMember && dialog.kind !== 'self',
        archived: (dialog.folderId ?? 0) === 1,
        isArchiving: Boolean(this.archivingKeys[dialog.key]),
        canJoin: (dialog.kind === 'channel' || dialog.kind === 'supergroup') && !isMember && !dialog.kicked,
        joinRequest: Boolean(dialog.joinRequest),
        joinPending: Boolean(dialog.joinPending),
        canLeave: (dialog.kind === 'channel' || dialog.kind === 'supergroup' || dialog.kind === 'group') && isMember,
        canDelete: isMember && (dialog.kind === 'user' || dialog.kind === 'bot'),
        isCreator: Boolean(dialog.creator),
      };
    },
    /** 会话历史栈是否可后退 */
    canGoBack: (state): boolean => state.chatHistoryStack.length > 0,
    /** 上一会话的显示名称（用于返回按钮悬浮提示） */
    previousChatTitle(): string {
      const lastKey = this.chatHistoryStack[this.chatHistoryStack.length - 1];
      if (!lastKey) return '';
      const dialog = this.dialogs[lastKey] ?? (this.resolvedDialog?.key === lastKey ? this.resolvedDialog : undefined);
      return dialog?.title ?? '';
    },
    leaveTargetDialog(state): { key: TgPeerKey; title: string; kindLabel: string; isCreator: boolean } | null {
      if (!state.leaveTargetKey) return null;
      const dialog = state.dialogs[state.leaveTargetKey] ?? (state.resolvedDialog?.key === state.leaveTargetKey ? state.resolvedDialog : undefined);
      if (!dialog) return null;
      return {
        key: dialog.key,
        title: dialog.title,
        kindLabel: kindLabel(dialog.kind),
        isCreator: Boolean(dialog.creator),
      };
    },
    deleteTargetDialog(state): { key: TgPeerKey; title: string; kindLabel: string; isUser: boolean; peer: TgPeerRef } | null {
      if (!state.deleteTargetKey) return null;
      const dialog = state.dialogs[state.deleteTargetKey] ?? (state.resolvedDialog?.key === state.deleteTargetKey ? state.resolvedDialog : undefined);
      if (!dialog) return null;
      return {
        key: dialog.key,
        title: dialog.title,
        kindLabel: kindLabel(dialog.kind),
        isUser: dialog.kind === 'user' || dialog.kind === 'bot',
        peer: dialog.peer,
      };
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
      const hasPublicSearch = this.isResolvingUsername || this.resolvedSearchItem !== null || this.resolveError !== null;
      if (this.dialogCount > 0 || (this.archiveEntry !== null) || hasPublicSearch) {
        return this.sessionItems.length > 0 || this.archiveEntry !== null || hasPublicSearch ? 'ready' : 'no-match';
      }
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
    /** 当前会话是否允许发送文本消息（私聊、机器人、收藏夹、已加入群组，或自己是创建者的频道）。 */
    canSendInActiveChat(): boolean {
      const dialog = this.activeDialog;
      if (!dialog || dialog.left || dialog.kicked) return false;
      if (dialog.kind === 'channel') return Boolean(dialog.creator);
      return true;
    },
    activeDraft(state): string {
      return state.activeChatKey ? (state.drafts[state.activeChatKey] ?? '') : '';
    },
    activeReplyTarget(state): { id: number; senderName: string; text: string } | null {
      return state.activeChatKey ? (state.replyingTo[state.activeChatKey] ?? null) : null;
    },
    isSpoilerRevealed: (state) => (key?: string): boolean => Boolean(key && state.revealedSpoilers[key]),
    isCallbackPending: (state) => (messageId: number, rowIdx: number, colIdx: number, buttonText?: string): boolean => {
      if (buttonText !== undefined) {
        return Boolean(state.pendingCallbacks[`${messageId}:${rowIdx}:${colIdx}:${buttonText}`]);
      }
      return Boolean(state.pendingCallbacks[`${messageId}:${rowIdx}:${colIdx}`]);
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

    /** 账户切换（或解绑）：代次 +1 使旧账户的在飞请求全部失效，优先命中 L1 热快照实现 <16ms 零闪烁切换 */
    async bindAccount(accountId: string | null) {
      if (accountId === this.accountId && this.syncPhase !== 'no-account') return;
      if (this.accountId) {
        // 保存切出账户的 L1 热快照
        this.accountSnapshots[this.accountId] = {
          dialogs: { ...this.dialogs },
          pinnedOrder: [...this.pinnedOrder],
          archivePinnedOrder: [...this.archivePinnedOrder],
          activeChatKey: this.activeChatKey,
          windows: { ...this.windows },
          updatesState: this.updatesState ? { ...this.updatesState } : null,
          hasArchivedChats: this.hasArchivedChats,
          dialogTotal: this.dialogTotal,
          archiveTotal: this.archiveTotal,
        };
        void this.persistNow();
      }
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
      // L1 内存热快照命中：<16ms 同步恢复会话列表与窗口，无骨架屏闪烁
      const l1 = this.accountSnapshots[accountId];
      if (l1 && Object.keys(l1.dialogs).length > 0) {
        this.dialogs = { ...l1.dialogs };
        this.pinnedOrder = [...l1.pinnedOrder];
        this.archivePinnedOrder = [...l1.archivePinnedOrder];
        this.activeChatKey = keepActive ?? l1.activeChatKey;
        this.windows = { ...l1.windows };
        this.updatesState = l1.updatesState ? { ...l1.updatesState } : null;
        this.hasArchivedChats = l1.hasArchivedChats;
        this.dialogTotal = l1.dialogTotal;
        this.archiveTotal = l1.archiveTotal;
        this.hasCache = true;
        this.syncPhase = this.isOnline ? 'live' : 'cache';
        cacheLoadPromise = Promise.resolve();
        if (generation === accountGeneration && this.isOnline) void this.syncNow();
        return;
      }
      this.syncPhase = 'connecting';
      cacheLoadPromise = this.loadCache(this.ownerId, accountId, generation);
      await cacheLoadPromise;
      if (generation === accountGeneration && this.isOnline) void this.syncNow();
    },

    toggleAccountSwitcher() {
      this.isAccountSwitcherOpen = !this.isAccountSwitcherOpen;
    },

    closeAccountSwitcher() {
      this.isAccountSwitcherOpen = false;
    },

    /** 切换前台活跃账号（<16ms 热快照替换 + Worker P0/P1 焦点切换） */
    async switchForegroundAccount(accountId: string) {
      this.isAccountSwitcherOpen = false;
      if (accountId === this.accountId) return;
      const telegram = useTelegramStore();
      await telegram.switchActiveAccount(accountId);
      await this.bindAccount(accountId);
    },

    /** 批量加入并可选在 Telegram 侧静默归档（folder_id = 1） */
    async batchJoinAndArchive(
      items: { peer?: TgPeerRef; inviteHash?: string; username?: string }[],
      archiveInTg = true,
    ): Promise<TgDialogDto[]> {
      const accountId = this.accountId;
      if (!accountId) return [];
      const joinedDialogs: TgDialogDto[] = [];
      const peersToArchive: TgPeerRef[] = [];

      for (const item of items) {
        try {
          let dialog: TgDialogDto | null = null;
          if (item.inviteHash) {
            const res = await chatDataSource.importChatInvite(accountId, item.inviteHash);
            dialog = res.dialog ?? null;
          } else if (item.peer) {
            const res = await chatDataSource.joinChat(accountId, item.peer);
            dialog = res.dialog ?? null;
          } else if (item.username) {
            const resolved = await chatDataSource.resolveUsername(accountId, item.username);
            if (resolved) {
              const res = await chatDataSource.joinChat(accountId, resolved.peer);
              dialog = res.dialog ?? null;
            }
          }
          if (dialog) {
            if (archiveInTg) {
              dialog = { ...dialog, folderId: 1 };
              peersToArchive.push(dialog.peer);
            }
            this.dialogs[dialog.key] = dialog;
            joinedDialogs.push(dialog);
          }
        } catch {
          // 单个会话失败不中断整批任务
        }
      }

      if (archiveInTg && peersToArchive.length > 0) {
        try {
          await chatDataSource.batchSetDialogsArchived(accountId, peersToArchive, true);
          this.hasArchivedChats = true;
        } catch {
          // 忽略批量归档非致命异常
        }
      }
      this.scheduleSave();
      return joinedDialogs;
    },

    /** 清空所有账户相关内容（切换账户/退出时调用），避免上一个账户的数据残留 */
    resetContent() {
      window.clearTimeout(saveTimer);
      window.clearTimeout(dialogRefreshTimer);
      window.clearTimeout(syncRetryTimer);
      window.clearTimeout(resolveUsernameTimer);
      window.clearTimeout(highlightTimer);
      window.clearTimeout(callbackNoticeTimer);
      saveTimer = undefined; saveDeadline = 0; dialogPages = 0; archivePages = 0; revealedKey = null;
      // 旧账户的同步循环会在代次校验处自行退出，新账户无需排队等待它。
      syncPromise = null; syncQueued = false;
      this.dialogs = {}; this.pinnedOrder = []; this.windows = {}; this.recentChatKeys = []; this.viewportAnchors = {};
      this.dialogCursor = null; this.hasMoreDialogs = false; this.dialogsError = null;
      this.dialogTotal = 0; this.hasArchivedChats = false; this.listRenderLimit = LIST_RENDER_STEP;
      this.activeFolderId = 0; this.archivePinnedOrder = []; this.archiveCursor = null;
      this.hasMoreArchived = false; this.archiveTotal = 0; this.archiveLoaded = false;
      this.isLoadingArchive = false; this.isLoadingMoreArchive = false;
      this.archivingKeys = {}; this.actionError = null;
      this.resolvedDialog = null; this.isResolvingUsername = false; this.resolveError = null;
      this.isJoining = false; this.joinNotice = null;
      this.leaveTargetKey = null; this.isLeaving = false; this.leaveError = null;
      this.chatHistoryStack = []; this.deleteTargetKey = null; this.deleteRevokeForBoth = true; this.isDeletingChat = false; this.deleteChatError = null;
      this.revealedSpoilers = {}; this.pendingCallbacks = {}; this.callbackNotice = null;
      this.highlightedMessageId = null; this.drafts = {}; this.replyingTo = {}; this.isSendingMessage = false;
      this.invitePreview = null; this.isCheckingInvite = false; this.isImportingInvite = false; this.inviteError = null;
      this.updatesState = null; this.hasCache = false; this.syncError = null; this.lastSyncedAt = 0;
      // 消息窗口清空后，对应的 Object URL / 加载队列 / 查看器也必须一并回收。
      useChatMediaStore().reset();
    },

    /** 读取加密冷启动快照：命中则先展示缓存（syncPhase = cache），再后台校准 */
    async loadCache(ownerId: string, accountId: string, generation: number) {
      const snapshot = await chatCacheStore.read(ownerId, accountId);
      if (generation !== accountGeneration || !snapshot) return;
      this.dialogs = Object.fromEntries(snapshot.dialogs.map((dialog) => [dialog.key, dialog]));
      this.pinnedOrder = snapshot.pinnedOrder;
      this.archivePinnedOrder = snapshot.archivePinnedOrder ?? [];
      const cachedArchivedCount = snapshot.dialogs.filter((dialog) => (dialog.folderId ?? 0) === 1).length;
      this.hasArchivedChats = Boolean(snapshot.hasArchivedChats) || cachedArchivedCount > 0;
      this.archiveTotal = Math.max(this.archiveTotal, cachedArchivedCount);
      if (cachedArchivedCount > 0) this.archiveLoaded = true;
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

    /** 订阅 Telegram 连接状态：断开 → offline，恢复 → 重新补差 */
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
    /** 手动/自动触发同步（去重：已有同步在跑时只排一次队） */
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

    /** 真正的同步流程：补差 → 刷新会话列表 → 标记 live */
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

    /** 将满足条件的消息窗口标记为「不连续」，下次打开会重新拉最新页 */
    invalidateWindows(predicate: (key: TgPeerKey) => boolean) {
      for (const [key, win] of Object.entries(this.windows)) {
        if (!predicate(key)) continue;
        win.continuous = false;
        win.fresh = false;
      }
    },

    /** 用户手动重试：连接在线则重新同步，否则交给 telegram 域重新恢复会话。 */
    /** 同步失败后的重试（带 15s 退避定时器） */
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
    /** 拉取活动会话第一页（或刷新已有列表） */
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

    /** 拉取「已归档」文件夹第一页 */
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

    /** 后台静默把剩余归档页拉完（不阻塞界面） */
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

    /** 用户滚到底时加载下一页归档会话 */
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
    /** 后台静默把剩余活动会话页拉完 */
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

    /** 用户滚到底时加载下一页活动会话 */
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
    /** 会话列表滚动处理：接近底部时继续拉取，同时逐步扩大渲染条数（虚拟化替代方案） */
    handleSessionListScroll(scrollTop: number, scrollHeight: number, clientHeight: number) {
      if (scrollHeight - scrollTop - clientHeight > LIST_LOAD_THRESHOLD_PX) return;
      if (this.listRenderLimit < this.sessionItems.length) this.listRenderLimit += LIST_RENDER_STEP;
      else if (this.isArchiveView) void this.loadMoreArchiveDialogs();
      else void this.loadMoreDialogs();
    },

    /** 进入归档文件夹视图（首次进入才拉数据） */
    openArchiveFolder() {
      this.activeFolderId = 1;
      this.listRenderLimit = LIST_RENDER_STEP;
      if (!this.archiveLoaded && this.syncPhase === 'live') void this.refreshArchiveDialogs().catch(() => undefined);
      else if (this.hasMoreArchived && this.syncPhase === 'live') void this.loadRemainingArchiveDialogs();
    },

    /** 返回活动会话列表 */
    closeArchiveFolder() {
      this.activeFolderId = 0;
      this.listRenderLimit = LIST_RENDER_STEP;
    },

    /** 实时更新导致会话排序变化时，防抖刷新列表（避免每来一条消息都重排） */
    scheduleDialogRefresh() {
      window.clearTimeout(dialogRefreshTimer);
      dialogRefreshTimer = window.setTimeout(() => {
        if (this.syncPhase === 'live') {
          this.refreshDialogs().catch(() => undefined);
          if (this.isArchiveView || this.archiveLoaded) this.refreshArchiveDialogs().catch(() => undefined);
        }
      }, DIALOG_REFRESH_DEBOUNCE_MS);
    },

    /** 会话键 → 可直接用于 RPC 的 peer 引用 */
    peerRefOf(key: TgPeerKey): TgPeerRef | null {
      return this.dialogs[key]?.peer ?? (this.resolvedDialog?.key === key ? this.resolvedDialog.peer : null) ?? peerRefFromKey(key);
    },

    /**
     * 从磁贴 / 聚合搜索卡片跳转打开会话阅读流（并可选定位到具体消息 ID）：
     * - 自动补充磁贴携带的 accessHash / title / username / inviteHash 到 resolvedDialog，避免归档会话或临时凭据会话未在主列表时出现「无法识别该会话」；
     * - 若未在已加载列表中，后台自动触发一次归档列表拉取或用户名/邀请解析。
     */
    async openSessionFromTile(options: {
      peerKey: TgPeerKey;
      peerType?: 'user' | 'chat' | 'channel';
      accessHash?: string;
      title?: string;
      username?: string;
      inviteHash?: string;
      accountId?: string;
      messageId?: number;
      avatarThumb?: string;
    }) {
      const key = options.peerKey;
      if (!key) return;
      if (options.accountId && options.accountId !== this.accountId) {
        const telegram = useTelegramStore();
        await telegram.switchActiveAccount(options.accountId);
        await this.bindAccount(options.accountId);
      }

      if (!this.dialogs[key]) {
        const fallbackRef = peerRefFromKey(key);
        const type = options.peerType ?? fallbackRef?.type ?? 'channel';
        const id = fallbackRef?.id ?? key.replace(/^(user|chat|channel)-/, '');
        this.resolvedDialog = {
          key,
          peer: {
            type,
            id,
            accessHash: options.accessHash ?? (this.resolvedDialog?.key === key ? this.resolvedDialog.peer.accessHash : undefined),
          },
          kind: type === 'channel' ? 'channel' : type === 'chat' ? 'group' : 'user',
          title: options.title || this.resolvedDialog?.title || key,
          username: options.username,
          avatar: options.avatarThumb ? { photoId: 'tile', dcId: 0, thumb: options.avatarThumb } : undefined,
          pinned: false,
          folderId: 0,
          muted: false,
          unreadCount: 0,
          unreadMentions: 0,
          unreadMark: false,
          readInboxMaxId: 0,
          readOutboxMaxId: 0,
          topMessageId: options.messageId ?? 0,
          date: Math.floor(Date.now() / 1000),
        };

        const accountId = this.accountId;
        if (accountId && this.isOnline) {
          if (!options.accessHash && options.username) {
            try {
              const resolved = await chatDataSource.resolveUsername(accountId, options.username);
              if (resolved) {
                this.resolvedDialog = resolved;
              }
            } catch {
              // 忽略解析异常，继续走 getHistory / getDialogs 兜底
            }
          } else if (!options.accessHash && options.inviteHash) {
            try {
              const preview = await chatDataSource.checkChatInvite(accountId, options.inviteHash);
              if (preview.dialog) {
                this.resolvedDialog = preview.dialog;
              }
            } catch {
              // 忽略解析异常
            }
          }
          if (!this.archiveLoaded) {
            void this.refreshArchiveDialogs().catch(() => undefined);
          }
        }
      }

      if (options.messageId) {
        await this.focusMessageInChat(key, options.messageId);
      } else {
        await this.openChat(key);
      }
    },

    /** 路由驱动：打开会话，保存上一会话的阅读位置，按栈原则记录历史，必要时刷新最新页。 */
    async openChat(key: TgPeerKey, options?: { isBack?: boolean }) {
      const previous = this.activeChatKey;
      if (previous && previous !== key) {
        if (!options?.isBack) {
          this.chatHistoryStack.push(previous);
          if (this.chatHistoryStack.length > 50) this.chatHistoryStack.shift();
        }
        this.leaveChat(previous);
      }
      this.activeChatKey = key;
      this.actionError = null;
      this.joinNotice = null;
      this.callbackNotice = null;
      this.recentChatKeys = [key, ...this.recentChatKeys.filter((item) => item !== key)].slice(0, RECENT_LIMIT);
      if (!this.windows[key]) this.windows[key] = createWindow();
      if (previous !== key || revealedKey !== key) await this.revealActive();
      const win = this.windows[key];
      if (win && !win.fresh && !win.isLoadingLatest && this.syncPhase === 'live') void this.loadLatest(key);
      this.scheduleSave();
    },

    /**
     * 会话历史返回（栈原则）：
     * 弹出上一访问的会话并切换过去。
     */
    async goBackChat() {
      if (this.chatHistoryStack.length === 0) return;
      const prevKey = this.chatHistoryStack.pop()!;
      await this.openChat(prevKey, { isBack: true });
    },

    /**
     * 关闭当前会话（Header 顶部关闭按钮）：
     * 保存锚点并清空选中态，清空历史栈，返回空态引导。
     */
    closeActiveChat() {
      const key = this.activeChatKey;
      if (!key) return;
      this.leaveChat(key);
      this.activeChatKey = null;
      this.chatHistoryStack = [];
      this.scheduleSave();
    },

    /** 关闭会话（用于路由回退时清理选中态） */
    leaveChat(key: TgPeerKey) {
      this.captureAnchor(key);
      const win = this.windows[key];
      if (win && trimInactiveWindow(win)) {
        const anchor = this.viewportAnchors[key];
        if (anchor && !win.messages.some((message) => message.id === anchor)) delete this.viewportAnchors[key];
      }
    },

    /** 滚动定位到活动会话（首次挂载 / 切换会话时调用） */
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
    /** 首屏消息不足一屏时继续向上补拉，填满视口以消除跳动 */
    fillViewport() {
      const win = this.activeWindow;
      if (win?.hasOlder && win.messages.length > 0 && messageViewport.isNearTop()) void this.loadOlder();
    },

    /** 拉取会话最新的 N 条消息（并校准窗口连续性） */
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

    /** 向上翻页加载更早的消息 */
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

    /** 出错后重试当前会话 */
    retryActive() {
      const key = this.activeChatKey;
      if (!key) return;
      if (this.syncPhase !== 'live') { this.retrySync(); return; }
      const win = this.windows[key];
      if (win) win.error = null;
      void (win && win.messages.length > 0 ? this.loadOlder(key) : this.loadLatest(key));
    },

    /** 消息区滚动：记录锚点（用于返回时恢复位置） */
    handleFeedScroll() {
      if (messageViewport.isNearTop()) void this.loadOlder();
      window.clearTimeout(anchorTimer);
      const key = this.activeChatKey;
      anchorTimer = window.setTimeout(() => { if (key && key === this.activeChatKey) this.captureAnchor(key); }, ANCHOR_DEBOUNCE_MS);
    },

    /** 贴底时不记锚点（下次打开直接看最新）；否则记录视口顶部第一条消息。 */
    /** 记录某会话的滚动锚点（防抖后写入 state） */
    captureAnchor(key: TgPeerKey) {
      if (!messageViewport.isAttached()) return;
      const anchor = messageViewport.isNearBottom() ? null : messageViewport.topVisibleMessageId();
      if (anchor) this.viewportAnchors[key] = anchor;
      else delete this.viewportAnchors[key];
      this.scheduleSave();
    },

    /** Worker 广播的实时更新入口：先校验账户归属，再落到 applyUpdates */
    handleLiveUpdates(accountId: string, updates: TgChatUpdate[], state?: TgUpdatesState) {
      if (accountId !== this.accountId) return;
      this.applyUpdates(updates);
      // 只要 Worker 推来的 pts 水位不低于当前基线即前移，防止发送消息或短暂重同步期间滞后引发假性 Gap
      if (state && (!this.updatesState || state.pts >= this.updatesState.pts)) {
        this.updatesState = state;
      }
      this.scheduleSave();
    },

    /** 更新分发：按类型改会话摘要 / 消息窗口 / 状态序列（pts） */
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
        } else if (update.type === 'folderPeers') {
          for (const item of update.peers) {
            const dialog = this.dialogs[item.peerKey];
            if (dialog) {
              dialog.folderId = item.folderId === 1 ? 1 : 0;
              dialog.pinned = false;
            }
            this.pinnedOrder = this.pinnedOrder.filter((k) => k !== item.peerKey);
            this.archivePinnedOrder = this.archivePinnedOrder.filter((k) => k !== item.peerKey);
            if (item.folderId === 1) this.hasArchivedChats = true;
          }
          this.scheduleDialogRefresh();
        } else if (update.type === 'dialogPinned') {
          const dialog = this.dialogs[update.peerKey];
          if (dialog) dialog.pinned = update.pinned;
          const folderId = update.folderId ?? dialog?.folderId ?? 0;
          if (folderId === 1) {
            this.archivePinnedOrder = update.pinned
              ? [update.peerKey, ...this.archivePinnedOrder.filter((k) => k !== update.peerKey)]
              : this.archivePinnedOrder.filter((k) => k !== update.peerKey);
          } else {
            this.pinnedOrder = update.pinned
              ? [update.peerKey, ...this.pinnedOrder.filter((k) => k !== update.peerKey)]
              : this.pinnedOrder.filter((k) => k !== update.peerKey);
          }
          this.scheduleDialogRefresh();
        } else if (update.type === 'dialogUnreadMark') {
          const dialog = this.dialogs[update.peerKey];
          if (dialog) dialog.unreadMark = update.unreadMark;
        } else if (update.type === 'peerLeft') {
          this.applyPeerLeft(update.peerKey);
          this.scheduleDialogRefresh();
        } else if (update.type === 'channelTooLong') {
          this.invalidateWindows((key) => key === update.peerKey);
          if (update.peerKey === activeKey && this.syncPhase === 'live') void this.loadLatest(update.peerKey);
          this.scheduleDialogRefresh();
        } else if (update.type === 'dialogsChanged') this.scheduleDialogRefresh();
        else if (update.type === 'gap') void this.syncNow();
      }
      if (activeGrew && stick) void nextTick(() => messageViewport.scrollToBottom());
    },

    /** 新消息：更新会话摘要与窗口；若窗口不连续则只标记，等打开时重新拉取 */
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

    /** 编辑消息：替换窗口中的同 id 消息、清理该消息挂起的按钮旋转加载态并更新摘要 */
    applyEditedMessage(message: TgMessageDto) {
      const prefix = `${message.id}:`;
      for (const k of Object.keys(this.pendingCallbacks)) {
        if (k.startsWith(prefix)) {
          delete this.pendingCallbacks[k];
        }
      }
      const win = this.windows[message.peerKey];
      if (win && win.messages.some((item) => item.id === message.id)) upsertMessage(win, message);
      const dialog = this.dialogs[message.peerKey];
      if (dialog?.topMessageId === message.id) dialog.lastMessage = message;
    },

    /** peerKey 缺省时属于公共消息盒，ID 在私聊与基础群之间全局唯一。 */
    /** 删除消息：从窗口中移除，若删到会话最后一条消息则触发一次列表刷新 */
    applyDeletedMessages(ids: number[], peerKey?: TgPeerKey) {
      const removed = new Set(ids);
      const matches = (key: TgPeerKey) => (peerKey ? key === peerKey : !key.startsWith('channel-'));
      for (const [key, win] of Object.entries(this.windows)) {
        if (matches(key)) {
          win.messages = win.messages.filter((message) => !removed.has(message.id));
        }
      }
      const touchedTop = Object.values(this.dialogs).some((dialog) => matches(dialog.key) && removed.has(dialog.topMessageId));
      if (touchedTop) this.scheduleDialogRefresh();
    },

    /**
     * 服务端归档 / 取消归档会话（folders.EditPeerFolders）：
     * - 当前会话保护：若操作的是当前打开的会话，保持右侧消息区打开，仅更新所属文件夹与头部状态。
     */
    /** 归档 / 取消归档（乐观更新，失败由 actionError 提示） */
    async toggleArchive(targetKey?: TgPeerKey) {
      const key = targetKey ?? this.activeChatKey;
      const accountId = this.accountId;
      if (!key || !accountId || this.archivingKeys[key]) return;
      const dialog = this.dialogs[key];
      if (!dialog || dialog.kind === 'self' || dialog.left || dialog.kicked) return;
      const nextArchived = (dialog.folderId ?? 0) !== 1;
      const generation = accountGeneration;
      this.archivingKeys[key] = true;
      this.actionError = null;
      try {
        await chatDataSource.setDialogArchived(accountId, dialog.peer, nextArchived);
        if (generation !== accountGeneration) return;
        const current = this.dialogs[key];
        if (current) {
          current.folderId = nextArchived ? 1 : 0;
          current.pinned = false;
        }
        this.pinnedOrder = this.pinnedOrder.filter((item) => item !== key);
        this.archivePinnedOrder = this.archivePinnedOrder.filter((item) => item !== key);
        if (nextArchived) {
          this.dialogTotal = Math.max(0, this.dialogTotal - 1);
          this.archiveTotal += 1;
          this.hasArchivedChats = true;
        } else {
          this.archiveTotal = Math.max(0, this.archiveTotal - 1);
          this.dialogTotal += 1;
          this.hasArchivedChats = Object.values(this.dialogs).some((item) => (item.folderId ?? 0) === 1) || this.archiveTotal > 0;
        }
        this.scheduleSave();
        this.scheduleDialogRefresh();
      } catch (error) {
        if (generation === accountGeneration) this.actionError = chatDataSource.readError(error);
      } finally {
        delete this.archivingKeys[key];
      }
    },

    /**
     * 服务端解析公开 @username（contacts.ResolveUsername）。
     */
    /** 搜索框输入 @username 时远程解析公开会话（防抖 350ms） */
    async resolvePublicUsername(rawKeyword: string) {
      const accountId = this.accountId;
      if (!accountId || !this.isOnline) return;
      const generation = accountGeneration;
      const seq = ++resolveSequence;
      this.isResolvingUsername = true;
      this.resolveError = null;
      try {
        const dialog = await chatDataSource.resolveUsername(accountId, rawKeyword);
        if (generation !== accountGeneration || seq !== resolveSequence) return;
        if (dialog) {
          this.resolvedDialog = dialog;
          const existing = this.dialogs[dialog.key];
          if (existing) {
            this.dialogs[dialog.key] = {
              ...existing,
              username: dialog.username ?? existing.username,
              participantsCount: dialog.participantsCount ?? existing.participantsCount,
              avatar: dialog.avatar ?? existing.avatar,
              creator: dialog.creator ?? existing.creator,
              joinRequest: dialog.joinRequest ?? existing.joinRequest,
            };
          }
        } else {
          this.resolvedDialog = null;
        }
      } catch (error) {
        if (generation === accountGeneration && seq === resolveSequence) {
          this.resolveError = chatDataSource.readError(error);
        }
      } finally {
        if (generation === accountGeneration && seq === resolveSequence) {
          this.isResolvingUsername = false;
        }
      }
    },

    /**
     * 加入当前查看的公开频道或超级群组（channels.JoinChannel）。
     * - INVITE_REQUEST_SENT 记为 pending，不伪报为已加入。
     */
    /** 加入当前解析到的公开频道 / 群组（可能返回 pending / webview） */
    async joinActiveChat() {
      const key = this.activeChatKey;
      const accountId = this.accountId;
      const dialog = this.activeDialog;
      if (!key || !accountId || !dialog || this.isJoining) return;
      if (dialog.kind !== 'channel' && dialog.kind !== 'supergroup') return;
      if (dialog.joinPending) {
        this.joinNotice = '已提交加入申请，请耐心等待管理员审核';
        return;
      }
      const generation = accountGeneration;
      this.isJoining = true;
      this.actionError = null;
      this.joinNotice = null;
      try {
        const result = await chatDataSource.joinChat(accountId, dialog.peer);
        if (generation !== accountGeneration) return;
        if (result.status === 'joined') {
          const merged: TgDialogDto = result.dialog ?? { ...dialog, left: false, kicked: false, joinPending: false, folderId: 0 };
          merged.left = false;
          merged.kicked = false;
          merged.joinPending = false;
          this.dialogs[key] = merged;
          if (this.resolvedDialog?.key === key) this.resolvedDialog = merged;
          this.joinNotice = '已成功加入会话';
          this.scheduleSave();
          this.scheduleDialogRefresh();
          void this.loadLatest(key);
        } else if (result.status === 'pending') {
          dialog.joinPending = true;
          if (this.dialogs[key]) this.dialogs[key].joinPending = true;
          this.joinNotice = '已提交加入申请，等待管理员审核';
        } else {
          this.joinNotice = '该会话需在 Telegram 官方客户端完成附加验证后加入';
        }
      } catch (error) {
        if (generation === accountGeneration) this.actionError = chatDataSource.readError(error);
      } finally {
        if (generation === accountGeneration) this.isJoining = false;
      }
    },

    /** 打开退出群组 / 频道的二次确认弹窗。 */
    /** 打开退出群组二次确认弹窗 */
    promptLeaveChat(targetKey?: TgPeerKey) {
      const key = targetKey ?? this.activeChatKey;
      if (!key || !this.dialogs[key]) return;
      this.leaveTargetKey = key;
      this.leaveError = null;
    },

    /** 关闭退出确认弹窗 */
    cancelLeaveChat() {
      if (this.isLeaving) return;
      this.leaveTargetKey = null;
      this.leaveError = null;
    },

    /**
     * 确认退出群组 / 频道（channels.LeaveChannel / messages.DeleteChatUser）：
     * - 创建者角色保护：creator === true 阻止直接退出；
     * - 仅在 RPC 成功后才清理本地状态与消息窗口。
     */
    /** 确认退出群组 / 频道（创建者会被服务端拒绝） */
    async confirmLeaveChat() {
      const key = this.leaveTargetKey;
      const accountId = this.accountId;
      if (!key || !accountId || this.isLeaving) return;
      const dialog = this.dialogs[key];
      if (!dialog) {
        this.leaveTargetKey = null;
        return;
      }
      if (dialog.creator) {
        this.leaveError = '您是该群组或频道的创建者，请先在官方客户端转让所有权或解散后再退出';
        return;
      }
      const generation = accountGeneration;
      this.isLeaving = true;
      this.leaveError = null;
      try {
        await chatDataSource.leaveChat(accountId, dialog.peer);
        if (generation !== accountGeneration) return;
        this.applyPeerLeft(key);
        this.leaveTargetKey = null;
        this.scheduleSave();
        this.scheduleDialogRefresh();
      } catch (error) {
        if (generation === accountGeneration) this.leaveError = chatDataSource.readError(error);
      } finally {
        if (generation === accountGeneration) this.isLeaving = false;
      }
    },

    /** 处理 peerLeft 更新：标记已退出并移出列表 */
    applyPeerLeft(key: TgPeerKey) {
      const dialog = this.dialogs[key];
      const wasArchived = (dialog?.folderId ?? 0) === 1;
      delete this.dialogs[key];
      delete this.windows[key];
      delete this.viewportAnchors[key];
      this.pinnedOrder = this.pinnedOrder.filter((item) => item !== key);
      this.archivePinnedOrder = this.archivePinnedOrder.filter((item) => item !== key);
      this.recentChatKeys = this.recentChatKeys.filter((item) => item !== key);
      if (wasArchived) {
        this.archiveTotal = Math.max(0, this.archiveTotal - 1);
        this.hasArchivedChats = Object.values(this.dialogs).some((item) => (item.folderId ?? 0) === 1) || this.archiveTotal > 0;
      } else {
        this.dialogTotal = Math.max(0, this.dialogTotal - 1);
      }
      if (this.resolvedDialog?.key === key) {
        this.resolvedDialog = { ...this.resolvedDialog, left: true };
      }
      this.chatHistoryStack = this.chatHistoryStack.filter((item) => item !== key);
      if (this.activeChatKey === key) {
        if (this.chatHistoryStack.length > 0) {
          const prevKey = this.chatHistoryStack.pop()!;
          void this.openChat(prevKey, { isBack: true });
        } else {
          this.activeChatKey = null;
        }
      }
    },

    /** 打开删除聊天二次确认弹窗（针对用户间私聊支持双向删除，群组/频道转为退出）。 */
    promptDeleteChat(targetKey?: TgPeerKey) {
      const key = targetKey ?? this.activeChatKey;
      if (!key) return;
      const dialog = this.dialogs[key] ?? (this.resolvedDialog?.key === key ? this.resolvedDialog : undefined);
      if (!dialog) return;
      this.deleteTargetKey = key;
      this.deleteRevokeForBoth = true;
      this.deleteChatError = null;
    },

    cancelDeleteChat() {
      if (this.isDeletingChat) return;
      this.deleteTargetKey = null;
      this.deleteChatError = null;
    },

    toggleDeleteRevoke() {
      this.deleteRevokeForBoth = !this.deleteRevokeForBoth;
    },

    setDeleteRevoke(revoke: boolean) {
      this.deleteRevokeForBoth = revoke;
    },

    /**
     * 确认删除聊天（messages.DeleteHistory / messages.DeleteChatUser / channels.LeaveChannel）：
     * 针对用户间聊天，支持同时为对方删除聊天（revoke: true）。
     */
    async confirmDeleteChat() {
      const key = this.deleteTargetKey;
      const accountId = this.accountId;
      if (!key || !accountId || this.isDeletingChat) return;
      const dialog = this.dialogs[key] ?? (this.resolvedDialog?.key === key ? this.resolvedDialog : undefined);
      if (!dialog) {
        this.deleteTargetKey = null;
        return;
      }
      const generation = accountGeneration;
      this.isDeletingChat = true;
      this.deleteChatError = null;
      try {
        await chatDataSource.deleteChat(accountId, dialog.peer, this.deleteRevokeForBoth);
        if (generation !== accountGeneration) return;
        this.applyPeerLeft(key);
        this.deleteTargetKey = null;
        this.scheduleSave();
        this.scheduleDialogRefresh();
      } catch (error) {
        if (generation === accountGeneration) this.deleteChatError = chatDataSource.readError(error);
      } finally {
        if (generation === accountGeneration) this.isDeletingChat = false;
      }
    },

    /** 防抖写盘：3s 内合并写，最多拖 15s 必写一次 */
    scheduleSave() {
      if (!this.accountId) return;
      const now = Date.now();
      if (!saveDeadline) saveDeadline = now + SAVE_MAX_WAIT_MS;
      window.clearTimeout(saveTimer);
      saveTimer = window.setTimeout(() => { void this.persistNow(); }, Math.min(SAVE_DEBOUNCE_MS, Math.max(0, saveDeadline - now)));
    },

    /** 快照在同步阶段构建完成（切换账户前调用也安全），之后才异步加密写盘。 */
    /** 立即落盘冷启动快照（页面隐藏 / 离开时调用） */
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
        archivePinnedOrder: this.archivePinnedOrder,
        hasArchivedChats: this.hasArchivedChats,
        windows: this.windows,
        recentChatKeys: this.recentChatKeys,
        activeChatKey: this.activeChatKey,
        viewportAnchors: this.viewportAnchors,
      }));
    },

    /** 设置会话搜索关键字（会触发本地过滤 + 可能的用户名解析） */
    setSearchKeyword(keyword: string) {
      this.searchKeyword = keyword;
      this.listRenderLimit = LIST_RENDER_STEP;
      window.clearTimeout(resolveUsernameTimer);
      resolveSequence += 1;
      this.isResolvingUsername = false;
      this.resolveError = null;
      if (this.resolvedDialog?.key !== this.activeChatKey) {
        this.resolvedDialog = null;
      }
      if (looksLikeUsernameQuery(keyword) && this.isOnline && this.accountId) {
        resolveUsernameTimer = window.setTimeout(() => {
          void this.resolvePublicUsername(keyword);
        }, RESOLVE_DEBOUNCE_MS);
      }
    },
    toggleSessionList() { this.isSessionListCollapsed = !this.isSessionListCollapsed; },
    collapseSessionList() { this.isSessionListCollapsed = true; },

    /** 点开剧透文本或折叠引用块 */
    revealSpoiler(key?: string) {
      if (key) this.revealedSpoilers[key] = true;
    },

    /** 展示内联按钮反馈提示（4.5s 后自动清除） */
    showCallbackNotice(text: string) {
      this.callbackNotice = text;
      window.clearTimeout(callbackNoticeTimer);
      callbackNoticeTimer = window.setTimeout(() => {
        if (this.callbackNotice === text) this.callbackNotice = null;
      }, 4500);
    },

    /** 更新当前会话的输入框草稿 */
    setDraft(text: string) {
      if (!this.activeChatKey) return;
      this.drafts[this.activeChatKey] = text;
      if (text.trim()) this.actionError = null;
    },

    /** 设置当前会话的回复目标消息并聚焦输入框 */
    setReplyTarget(messageId: number, senderName?: string, text?: string) {
      if (!this.activeChatKey) return;
      this.replyingTo[this.activeChatKey] = {
        id: messageId,
        senderName: senderName || '消息',
        text: (text ?? '').replace(/\s+/g, ' ').trim() || `消息 #${messageId}`,
      };
      void nextTick(() => messageViewport.focusComposerInput());
    },

    /** 取消当前会话的回复目标 */
    cancelReplyTarget() {
      if (!this.activeChatKey) return;
      delete this.replyingTo[this.activeChatKey];
    },

    /**
     * 发送文本消息（支持搜索群关键词输入、命令发送、回复指定消息）。
     * 遵循「主按钮不置灰」规范：空文本时聚焦输入框并提示中文错误。
     */
    async sendActiveMessage(overrideText?: string) {
      const key = this.activeChatKey;
      const accountId = this.accountId;
      if (!key || !accountId || this.isSendingMessage) return;
      const raw = overrideText ?? this.drafts[key] ?? '';
      const trimmed = raw.trim();
      if (!trimmed) {
        this.actionError = '请输入消息内容后再发送';
        messageViewport.focusComposerInput();
        return;
      }
      const peer = this.peerRefOf(key);
      if (!peer) {
        this.actionError = '无法识别当前会话';
        return;
      }
      const replyTarget = overrideText ? undefined : this.replyingTo[key];
      const generation = accountGeneration;
      this.isSendingMessage = true;
      this.actionError = null;
      this.lastSentQueryByPeer[key] = trimmed;
      try {
        const sent = await chatDataSource.sendMessage(accountId, peer, trimmed, replyTarget?.id);
        if (generation !== accountGeneration) return;
        if (!overrideText) {
          this.drafts[key] = '';
          delete this.replyingTo[key];
        }
        if (sent) {
          this.applyNewMessage(sent);
        }
        this.scheduleSave();
        await nextTick();
        messageViewport.scrollToBottom();
      } catch (error) {
        if (generation === accountGeneration) {
          this.actionError = chatDataSource.readError(error);
        }
      } finally {
        if (generation === accountGeneration) {
          this.isSendingMessage = false;
        }
      }
    },

    /**
     * 点击消息下方的内联按键（ReplyInlineMarkup）：
     * - callback：调用 messages.GetBotCallbackAnswer，机器人原地编辑消息（如翻页/筛选）会自动经 UpdateEditMessage 更新；
     * - url / webview：走 Telegram 链接路由器；
     * - switchInline：填入输入框并聚焦；
     * - copy：写入剪贴板并提示。
     */
    async pressInlineButton(messageId: number, rowIdx: number, colIdx: number, button: TgInlineButton) {
      const key = this.activeChatKey;
      const accountId = this.accountId;
      if (!key || !accountId) return;

      if (button.kind === 'url' && button.url) {
        void this.handleLinkClick(button.url);
        return;
      }
      if (button.kind === 'webview' && button.url) {
        void this.handleLinkClick(button.url);
        return;
      }
      if (button.kind === 'switchInline') {
        const prefix = this.activeDialog?.username ? `@${this.activeDialog.username} ` : '';
        this.drafts[key] = `${prefix}${button.query ?? ''}`;
        void nextTick(() => messageViewport.focusComposerInput());
        return;
      }
      if (button.kind === 'copy' && button.copyText) {
        try {
          await navigator.clipboard?.writeText(button.copyText);
        } catch {
          // 忽略剪贴板权限异常
        }
        this.showCallbackNotice('已复制到剪贴板');
        return;
      }
      if (button.kind !== 'callback' || !button.data) return;

      const cbKey = `${messageId}:${rowIdx}:${colIdx}:${button.text}`;
      if (this.pendingCallbacks[cbKey]) return;
      const peer = this.peerRefOf(key);
      if (!peer) return;

      const generation = accountGeneration;
      this.pendingCallbacks[cbKey] = true;
      this.actionError = null;
      try {
        const answer = await chatDataSource.pressBotCallback(accountId, peer, messageId, button.data);
        if (generation !== accountGeneration) return;
        if (answer.message) {
          this.showCallbackNotice(answer.message);
        }
        if (answer.url) {
          void this.handleLinkClick(answer.url);
        }
      } catch (error) {
        if (generation === accountGeneration) {
          const msg = chatDataSource.readError(error);
          if (!msg.includes('机器人响应超时')) {
            this.actionError = msg;
          }
        }
      } finally {
        delete this.pendingCallbacks[cbKey];
      }
    },

    /**
     * 在指定会话中定位并高亮某条消息（若不在当前窗口内则调用 getHistoryAround 拉取上下文）。
     */
    async focusMessageInChat(peerKey: TgPeerKey, messageId: number) {
      if (!peerKey || !messageId) return;
      if (this.activeChatKey !== peerKey) {
        await this.openChat(peerKey);
      }
      const accountId = this.accountId;
      const peer = this.peerRefOf(peerKey);
      let win = this.windows[peerKey];
      if (!win) {
        win = createWindow();
        this.windows[peerKey] = win;
      }

      const hasInWindow = win.messages.some((item) => item.id === messageId);
      if (!hasInWindow && accountId && peer && this.isOnline) {
        const generation = accountGeneration;
        win.isLoadingOlder = true;
        try {
          const page = await chatDataSource.getHistoryAround(accountId, peer, messageId, historyPageSize());
          if (generation !== accountGeneration) return;
          const current = this.windows[peerKey];
          if (current) mergeHistoryAround(current, page);
        } catch (error) {
          if (generation === accountGeneration) {
            this.actionError = chatDataSource.readError(error);
          }
        } finally {
          if (generation === accountGeneration && this.windows[peerKey]) {
            this.windows[peerKey].isLoadingOlder = false;
          }
        }
      }

      await nextTick();
      if (this.activeChatKey !== peerKey) return;
      const scrolled = messageViewport.scrollToMessage(messageId, true);
      if (scrolled) {
        this.highlightedMessageId = messageId;
        window.clearTimeout(highlightTimer);
        highlightTimer = window.setTimeout(() => {
          if (this.highlightedMessageId === messageId) this.highlightedMessageId = null;
        }, 2200);
      } else {
        this.actionError = `未找到消息 #${messageId}（可能已被删除）`;
      }
    },

    /** 处理富文本内联链接点击（URL / @mention / 用户引用 / 机器人命令 / #标签） */
    handleRichLinkClick(link: NonNullable<RichTextSegment['link']>) {
      if (link.kind === 'url') {
        void this.handleLinkClick(link.target);
        return;
      }
      if (link.kind === 'mention') {
        void this.handleLinkClick(`@${link.target}`);
        return;
      }
      if (link.kind === 'mentionName') {
        void this.openChat(link.target);
        return;
      }
      if (link.kind === 'botCommand') {
        if (this.canSendInActiveChat) {
          void this.sendActiveMessage(link.target);
        } else {
          this.setDraft(link.target);
        }
        return;
      }
      if (link.kind === 'hashtag') {
        this.setSearchKeyword(link.target);
      }
    },

    /**
     * 全场景 Telegram 链接跳转路由器：
     * - botStart：解析机器人 → 打开会话 → 自动触发 startBot（/start <payload>）；
     * - publicMessage：解析公开用户名 → 打开会话 → 定位并高亮目标消息 ID；
     * - privateMessage：打开 channel-<id> → 定位并高亮目标消息 ID；
     * - invite：检查私有邀请哈希 → 已加入则直接进入，未加入则打开邀请预览弹窗；
     * - username：解析公开用户名 → 打开会话；
     * - external：在新标签页安全打开外部网页。
     */
    async handleLinkClick(rawUrl: string) {
      const parsed = parseTelegramLink(rawUrl);
      if (parsed.kind === 'external') {
        if (parsed.url && typeof window !== 'undefined') {
          window.open(parsed.url, '_blank', 'noopener,noreferrer');
        }
        return;
      }

      const accountId = this.accountId;
      if (!accountId || !this.isOnline) {
        this.actionError = '当前处于离线状态，无法解析 Telegram 链接';
        return;
      }

      if (parsed.kind === 'invite') {
        await this.openInviteHash(parsed.hash);
        return;
      }

      if (parsed.kind === 'privateMessage') {
        const targetKey = `channel-${parsed.channelId}`;
        if (!this.dialogs[targetKey] && this.resolvedDialog?.key !== targetKey) {
          this.actionError = '无法访问该私有频道或群组（您尚未加入该会话）';
          return;
        }
        await this.focusMessageInChat(targetKey, parsed.messageId);
        return;
      }

      // username / publicMessage / botStart：优先命中本地已有 username，否则调用 resolveUsername
      const lowerName = parsed.username.toLowerCase();
      let targetDialog = Object.values(this.dialogs).find((item) => item.username?.toLowerCase() === lowerName)
        ?? (this.resolvedDialog?.username?.toLowerCase() === lowerName ? this.resolvedDialog : undefined);

      if (!targetDialog) {
        const generation = accountGeneration;
        try {
          const resolved = await chatDataSource.resolveUsername(accountId, parsed.username);
          if (generation !== accountGeneration) return;
          if (!resolved) {
            this.actionError = `未找到 @${parsed.username} 对应的会话`;
            return;
          }
          this.resolvedDialog = resolved;
          if (this.dialogs[resolved.key]) {
            this.dialogs[resolved.key] = { ...this.dialogs[resolved.key], ...resolved };
          }
          targetDialog = resolved;
        } catch (error) {
          if (generation === accountGeneration) {
            this.actionError = chatDataSource.readError(error);
          }
          return;
        }
      }

      if (parsed.kind === 'username') {
        await this.openChat(targetDialog.key);
        return;
      }

      if (parsed.kind === 'publicMessage') {
        await this.focusMessageInChat(targetDialog.key, parsed.messageId);
        return;
      }

      if (parsed.kind === 'botStart') {
        await this.openChat(targetDialog.key);
        const generation = accountGeneration;
        this.isSendingMessage = true;
        try {
          const sent = await chatDataSource.startBot(accountId, targetDialog.peer, parsed.startParam);
          if (generation !== accountGeneration) return;
          if (sent) this.applyNewMessage(sent);
          await nextTick();
          messageViewport.scrollToBottom();
        } catch (error) {
          if (generation === accountGeneration) {
            this.actionError = chatDataSource.readError(error);
          }
        } finally {
          if (generation === accountGeneration) {
            this.isSendingMessage = false;
          }
        }
      }
    },

    /** 检查私有邀请链接（+hash / joinchat/hash） */
    async openInviteHash(hash: string) {
      const accountId = this.accountId;
      if (!accountId || !hash || this.isCheckingInvite) return;
      const generation = accountGeneration;
      this.isCheckingInvite = true;
      this.inviteError = null;
      this.actionError = null;
      try {
        const preview = await chatDataSource.checkChatInvite(accountId, hash);
        if (generation !== accountGeneration) return;
        if ((preview.status === 'already' || preview.status === 'peek') && preview.dialog) {
          this.resolvedDialog = preview.dialog;
          if (preview.status === 'already' && !this.dialogs[preview.dialog.key]) {
            this.dialogs[preview.dialog.key] = preview.dialog;
          }
          await this.openChat(preview.dialog.key);
          return;
        }
        this.invitePreview = preview;
      } catch (error) {
        if (generation === accountGeneration) {
          this.actionError = chatDataSource.readError(error);
        }
      } finally {
        if (generation === accountGeneration) {
          this.isCheckingInvite = false;
        }
      }
    },

    /** 关闭私有邀请链接弹窗 */
    closeInviteDialog() {
      if (this.isImportingInvite) return;
      this.invitePreview = null;
      this.inviteError = null;
    },

    /** 确认通过私有邀请链接加入群组 / 频道 */
    async confirmImportInvite() {
      const preview = this.invitePreview;
      const accountId = this.accountId;
      if (!preview || !accountId || this.isImportingInvite) return;
      const generation = accountGeneration;
      this.isImportingInvite = true;
      this.inviteError = null;
      try {
        const result = await chatDataSource.importChatInvite(accountId, preview.hash);
        if (generation !== accountGeneration) return;
        if (result.status === 'joined') {
          this.invitePreview = null;
          if (result.dialog) {
            this.dialogs[result.dialog.key] = { ...result.dialog, left: false, kicked: false };
            await this.openChat(result.dialog.key);
          }
          this.joinNotice = '已通过邀请链接加入会话';
          this.scheduleSave();
          this.scheduleDialogRefresh();
        } else if (result.status === 'pending') {
          this.invitePreview = null;
          this.joinNotice = '已提交加入申请，请等待管理员审核';
        } else {
          this.inviteError = '该会话需在 Telegram 官方客户端完成附加验证后加入';
        }
      } catch (error) {
        if (generation === accountGeneration) {
          this.inviteError = chatDataSource.readError(error);
        }
      } finally {
        if (generation === accountGeneration) {
          this.isImportingInvite = false;
        }
      }
    },
  },
});
