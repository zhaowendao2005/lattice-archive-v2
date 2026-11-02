/**
 * [STORE] 搜索机器人 [startPage, endPage] 自动翻页收割机 Store (BotHarvesterStore)
 *
 * 职责（纯视图状态与动作编排）：
 * 1. 管理翻页区间、当前收割任务进度、候选链接池与批量归档弹窗状态；
 * 2. 双向绑定「我方发出的查询消息 (Outbox Query) ↔ 机器人回复的分页消息 (Inbox Reply)」；
 * 3. 基于 UpdateEditMessage 实时事件驱动自动翻页（不阻塞等待 10s BOT_RESPONSE_TIMEOUT）。
 */
import { defineStore } from 'pinia';
import type { BotHarvestCandidateItem, BotHarvestTaskState } from '@/stores/archive/types';
import { useSessionManagerStore } from '@/stores/archive/stores/sessionManagerStore';
import { useTileStore } from '@/views/main/archive/store/tileStore';
import type { SessionCredentialState } from '@/views/main/archive/types/tile';
import {
  detectCurrentBotPage,
  extractBotCandidatesFromMessage,
  findNextBotPageButton,
  hasBotPaginationControls,
  resolvePairedQueryForBotMessage,
} from '@/worker/local/chat/botHarvesterParser';
import { useChatStore } from './chatStore';
import { chatDataSource } from '../data-sources/chatDataSource';
import type { TgInlineButton, TgMessageDto } from '../types';

const wait = (ms: number) => new Promise<void>((resolve) => { window.setTimeout(resolve, ms); });

export const useBotHarvesterStore = defineStore('botHarvester', {
  state: () => ({
    startPageByMsg: {} as Record<number, number>,
    endPageByMsg: {} as Record<number, number>,
    activeTask: null as (BotHarvestTaskState & {
      harvestedCount?: number;
      errorMessage?: string;
      pairedQueryText?: string;
      pairedQueryMsgId?: number;
    }) | null,
    candidates: [] as BotHarvestCandidateItem[],
    isCandidateModalOpen: false,
    candidateFilterKind: 'all' as 'all' | 'username' | 'invite_hash' | 'deep_link',
    targetExploreGroupId: 'group-default',
    placementMode: 'temp_auto_renew' as SessionCredentialState,
    archiveOnJoin: true,
    isCommitting: false,
    harvestNotice: null as string | null,
  }),

  getters: {
    filteredCandidates(state): BotHarvestCandidateItem[] {
      if (state.candidateFilterKind === 'all') return state.candidates;
      return state.candidates.filter((c) => c.kind === state.candidateFilterKind);
    },

    selectedCandidates(state): BotHarvestCandidateItem[] {
      return state.candidates.filter((c) => c.selected);
    },
  },

  actions: {
    getStartPage(messageId: number): number {
      if (this.startPageByMsg[messageId] !== undefined) {
        return this.startPageByMsg[messageId]!;
      }
      const chatStore = useChatStore();
      const msg = chatStore.activeWindow?.messages.find((m) => m.id === messageId);
      const detected = detectCurrentBotPage(msg);
      return detected && detected >= 1 ? detected : 1;
    },

    setStartPage(messageId: number, page: number) {
      const clamped = Math.max(1, Math.min(50, Math.floor(page) || 1));
      this.startPageByMsg[messageId] = clamped;
      if ((this.endPageByMsg[messageId] ?? 5) < clamped) {
        this.endPageByMsg[messageId] = clamped;
      }
    },

    getEndPage(messageId: number): number {
      const start = this.getStartPage(messageId);
      const configured = this.endPageByMsg[messageId] ?? Math.max(5, start + 4);
      return Math.max(start, configured);
    },

    setEndPage(messageId: number, page: number) {
      const start = this.getStartPage(messageId);
      const clamped = Math.max(start, Math.min(50, Math.floor(page) || start));
      this.endPageByMsg[messageId] = clamped;
    },

    /** 获取当前机器人回复消息所关联的「我方发出查询词」 */
    getPairedQuery(messageId: number): { queryText: string; queryMsgId?: number } {
      const chatStore = useChatStore();
      const winMessages = chatStore.activeWindow?.messages ?? [];
      const botMsg = winMessages.find((m) => m.id === messageId);
      const fallback = chatStore.activeChatKey
        ? chatStore.lastSentQueryByPeer[chatStore.activeChatKey]
        : undefined;
      return resolvePairedQueryForBotMessage(botMsg, winMessages, fallback);
    },

    /** 判断内联键盘是否包含搜索机器人的翻页按钮 */
    hasPaginationControls(rows: TgInlineButton[][]): boolean {
      return hasBotPaginationControls(rows);
    },

    findNextPageButton(rows: TgInlineButton[][], nextPageNum: number): TgInlineButton | null {
      return findNextBotPageButton(rows, nextPageNum);
    },

    extractCandidatesFromMessage(msg: TgMessageDto, pageNum: number): BotHarvestCandidateItem[] {
      return extractBotCandidatesFromMessage(msg, pageNum);
    },

    mergeCandidates(items: BotHarvestCandidateItem[]) {
      const existingKeys = new Set(this.candidates.map((c) => c.key));
      for (const item of items) {
        if (!existingKeys.has(item.key)) {
          existingKeys.add(item.key);
          this.candidates.push(item);
        }
      }
    },

    /** 启动 [startPage, endPage] 事件驱动自动翻页收割任务 */
    async startHarvestRange(messageId: number) {
      const chatStore = useChatStore();
      const sessionStore = useSessionManagerStore();
      const accountId = chatStore.accountId;
      const dialog = chatStore.activeDialog;
      if (!accountId || !dialog) return;

      const startPage = this.getStartPage(messageId);
      const endPage = this.getEndPage(messageId);
      const paired = this.getPairedQuery(messageId);
      this.harvestNotice = null;

      const taskId = sessionStore.enqueueTask({
        kind: 'bot_harvest',
        title: `收割「${paired.queryText}」(${dialog.title} 第 ${startPage}~${endPage} 页)`,
        total: Math.max(1, endPage - startPage + 1),
        accountId,
      });

      const initialMsg = chatStore.activeWindow?.messages.find((m) => m.id === messageId);
      const initialPage = detectCurrentBotPage(initialMsg) ?? startPage;
      const loopStart = Math.min(startPage, initialPage);

      this.activeTask = {
        taskId,
        peerKey: dialog.key,
        messageId,
        botName: dialog.title,
        startPage,
        endPage,
        currentPage: loopStart,
        status: 'running',
        candidates: [],
        targetGroupId: this.targetExploreGroupId,
        targetFolderId: null,
        autoJoinAndArchive: this.placementMode === 'joined',
        startedAtMs: Date.now(),
        harvestedCount: 0,
        pairedQueryText: paired.queryText,
        pairedQueryMsgId: paired.queryMsgId,
      };

      try {
        for (let page = loopStart; page <= endPage; page++) {
          if (!this.activeTask || this.activeTask.status !== 'running') break;
          this.activeTask.currentPage = page;

          const currentMsg = chatStore.activeWindow?.messages.find((m) => m.id === messageId);
          if (currentMsg && page >= startPage) {
            const pageItems = this.extractCandidatesFromMessage(currentMsg, page);
            this.mergeCandidates(pageItems);
            this.activeTask.harvestedCount = this.candidates.length;
            sessionStore.updateTaskProgress(taskId, Math.max(1, page - startPage + 1));
          }

          if (page >= endPage) break;

          const nextBtn = currentMsg?.replyMarkup
            ? this.findNextPageButton(currentMsg.replyMarkup, page + 1)
            : null;
          if (!nextBtn || !nextBtn.data) break;

          const quotaCheck = sessionStore.consumeQuota(accountId, 'botCallbackPage', 1);
          if (!quotaCheck.allowed) {
            this.activeTask.status = 'paused_captcha';
            this.activeTask.pauseReason = quotaCheck.reason;
            this.activeTask.errorMessage = quotaCheck.reason;
            break;
          }

          // 1. 先注册 UpdateEditMessage 实时事件监听器（机器人编辑消息即在 200~500ms 内触发）
          const editWaiter = chatDataSource.waitForMessageEdit(dialog.key, messageId, 4800);

          // 2. 异步触发 GetBotCallbackAnswer（不阻塞等待 10s BOT_RESPONSE_TIMEOUT，且吞掉非致命超时）
          void chatDataSource
            .pressBotCallback(accountId, dialog.peer, messageId, nextBtn.data)
            .catch(() => undefined);

          // 3. 等待实时 UpdateEditMessage 到达；若 4.8s 超时未收到推送，再通过 getHistoryAround 兜底校准
          const editedMsg = await editWaiter;
          if (!this.activeTask || this.activeTask.status !== 'running') break;

          if (!editedMsg) {
            try {
              const refreshed = await chatDataSource.getHistoryAround(accountId, dialog.peer, messageId, 3);
              const updatedMsg = refreshed.messages.find((m) => m.id === messageId);
              if (updatedMsg && chatStore.activeWindow) {
                const idx = chatStore.activeWindow.messages.findIndex((m) => m.id === messageId);
                if (idx >= 0) chatStore.activeWindow.messages[idx] = updatedMsg;
              }
            } catch {
              // 忽略历史校准异常，继续使用窗口内最新消息
            }
          }

          // 4. 拟人化微抖动间隔（900ms ~ 1400ms），兼顾连续翻页速度与防封控安全
          await wait(900 + Math.floor(Math.random() * 500));
        }

        if (this.activeTask && this.activeTask.status === 'running') {
          this.activeTask.status = 'completed';
          sessionStore.completeTask(taskId);
          this.isCandidateModalOpen = true;
        }
      } catch (err) {
        const msg = chatDataSource.readError(err);
        if (this.activeTask) {
          this.activeTask.status = 'error';
          this.activeTask.pauseReason = msg;
          this.activeTask.errorMessage = msg;
        }
        sessionStore.failTask(taskId, msg);
      }
    },

    stopHarvest() {
      if (this.activeTask) {
        this.activeTask.status = 'cancelled';
        this.activeTask = null;
      }
    },

    openCandidateModal() {
      const tileStore = useTileStore();
      if (tileStore.groups.length > 0 && !tileStore.groups.some((g) => g.id === this.targetExploreGroupId)) {
        this.targetExploreGroupId = tileStore.groups[0]!.id;
      }
      this.isCandidateModalOpen = true;
    },

    closeCandidateModal() {
      this.isCandidateModalOpen = false;
    },

    toggleCandidate(key: string) {
      const item = this.candidates.find((c) => c.key === key);
      if (item) item.selected = !item.selected;
    },

    selectAllFiltered() {
      for (const item of this.filteredCandidates) item.selected = true;
    },

    clearSelection() {
      for (const item of this.candidates) item.selected = false;
    },

    clearPool() {
      this.candidates = [];
      this.harvestNotice = null;
    },

    /** 将勾选的候选条目批量入驻临时凭据池或静默加入并放置到探索页 */
    async commitSelectedCandidates() {
      const selected = this.selectedCandidates;
      if (selected.length === 0) {
        this.harvestNotice = '请先勾选至少一条收割结果';
        return;
      }
      this.isCommitting = true;
      this.harvestNotice = null;
      const chatStore = useChatStore();
      const sessionStore = useSessionManagerStore();
      const tileStore = useTileStore();
      const targetGroup = tileStore.groups.find((g) => g.id === this.targetExploreGroupId) ?? tileStore.groups[0];

      try {
        if (this.placementMode === 'joined') {
          const joined = await chatStore.batchJoinAndArchive(
            selected.map((c) => ({ inviteHash: c.inviteHash, username: c.username })),
            this.archiveOnJoin,
          );
          if (targetGroup) {
            for (const d of joined) {
              tileStore.addNewFile(
                {
                  title: d.title,
                  size: 'medium',
                  fileType: 'generic',
                  extension: 'tg',
                  sessionId: d.key,
                  sessionTitle: d.title,
                  isSessionLink: true,
                  peerKey: d.key,
                  peerType: d.peer.type,
                  accessHash: d.peer.accessHash,
                  sessionCredentialState: 'joined',
                  participantsCount: d.participantsCount,
                },
                targetGroup.id,
              );
            }
          }
          this.harvestNotice = `已静默加入并收纳 ${joined.length} 个会话至「${targetGroup?.title ?? '探索页'}」`;
        } else {
          const accountId = chatStore.accountId ?? 'local';
          let count = 0;
          for (const item of selected) {
            const credId = `temp-harvest-${item.key}`;
            const peerKey = item.username ? `channel-${item.username}` : `invite-${item.inviteHash ?? item.key}`;
            let placedTileId: string | undefined;
            if (targetGroup) {
              const newTile = tileStore.addNewFile(
                {
                  title: item.title,
                  size: 'medium',
                  fileType: 'generic',
                  extension: 'tg',
                  sessionId: peerKey,
                  sessionTitle: item.title,
                  isSessionLink: true,
                  peerKey,
                  peerType: 'channel',
                  username: item.username,
                  inviteHash: item.inviteHash,
                  sessionCredentialState: this.placementMode,
                },
                targetGroup.id,
              );
              placedTileId = newTile.id;
            }
            sessionStore.upsertTempCredential({
              id: credId,
              peerKey,
              peerId: item.username ?? item.inviteHash ?? item.key,
              peerType: 'channel',
              title: item.title,
              username: item.username,
              inviteHash: item.inviteHash,
              accountId,
              state: this.placementMode,
              autoRenew: this.placementMode === 'temp_auto_renew',
              lastVerifiedAt: Date.now(),
              peekExpiresAt: Date.now() + 48 * 3600_000,
              linkedTileIds: placedTileId ? [placedTileId] : [],
              status: 'healthy',
            });
            count += 1;
          }
          await sessionStore.persistGovernanceToOpfs();
          this.harvestNotice = `已将 ${count} 个条目免加群入驻临时凭据池并生成探索页磁贴`;
        }
      } finally {
        this.isCommitting = false;
      }
    },
  },
});
