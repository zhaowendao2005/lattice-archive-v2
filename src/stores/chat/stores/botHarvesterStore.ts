/**
 * [STORE] 搜索机器人 [startPage, endPage] 自动翻页收割机 Store (BotHarvesterStore)
 *
 * 职责（纯视图状态与动作编排）：
 * 1. 管理翻页区间、当前收割任务进度、候选链接池与批量归档弹窗状态；
 * 2. 双向绑定「我方发出的查询消息 (Outbox Query) ↔ 机器人回复的分页消息 (Inbox Reply)」；
 * 3. 基于 UpdateEditMessage 实时事件驱动自动翻页（不阻塞等待 10s BOT_RESPONSE_TIMEOUT）。
 */
import { defineStore } from 'pinia';
import type { BotHarvestTaskState } from '@/stores/archive/types';
import type { BotHarvestCandidateItem } from '@/types/botHarvest';
import { useSessionManagerStore } from '@/stores/archive/stores/sessionManagerStore';
import { useTileStore } from '@/stores/archive/stores/tileStore';
import type { SessionCredentialState } from '@/views/main/archive/types/tile';
import { useChatStore } from './chatStore';
import { telegramBusClient } from '@/stores/telegram/data-sources/telegramBusClient';
import type { TgInlineButton, TgMessageDto } from '../types';
import { debugLoggerDataSource } from '@/stores/app/data-sources/debugLoggerDataSource';

const wait = (ms: number) => new Promise<void>((resolve) => { window.setTimeout(resolve, ms); });
/** 同一消息元数据只保留一个在途 Worker 解析；过期响应不得覆盖新版本。 */
const pendingBotMetadata = new Map<string, string>();

export const useBotHarvesterStore = defineStore('botHarvester', {
  state: () => ({
    startPageByMsg: {} as Record<number, number>,
    parsedPageByMsg: {} as Record<number, number>,
    pairedQueryByMsg: {} as Record<number, { queryText: string; queryMsgId?: number }>,
    metadataSignatureByMsg: {} as Record<number, string>,
    paginationByMsg: {} as Record<number, boolean>,
    endPageByMsg: {} as Record<number, number>,
    activeTask: null as (BotHarvestTaskState & {
      harvestedCount?: number;
      errorMessage?: string;
      pairedQueryText?: string;
      pairedQueryMsgId?: number;
    }) | null,
    candidates: [] as BotHarvestCandidateItem[],
    isCandidateModalOpen: false,
    /** 「解析消息」设置弹窗当前对应的消息 ID；null 表示弹窗关闭。 */
    dialogMessageId: null as number | null,
    candidateFilterKind: 'all' as 'all' | 'username' | 'invite_hash' | 'deep_link',
    targetExploreGroupId: 'group-default',
    placementMode: 'temp_auto_renew' as SessionCredentialState,
    archiveOnJoin: true,
    isCommitting: false,
    harvestNotice: null as string | null,
    metadataFailedByMsg: {} as Record<number, boolean>,
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
      return this.parsedPageByMsg[messageId] ?? 1;
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

    /** 获取 Worker 解析并缓存的查询词。 */
    getPairedQuery(messageId: number): { queryText: string; queryMsgId?: number } {
      return this.pairedQueryByMsg[messageId] ?? { queryText: '当前页检索' };
    },

    hasPaginationControls(_rows: TgInlineButton[][], messageId?: number): boolean {
      return messageId ? Boolean(this.paginationByMsg[messageId]) : false;
    },

    async refreshMessageMetadata(accountId: string, message: TgMessageDto, windowMessages: TgMessageDto[] = [], fallbackLastQuery?: string) {
      const signature = JSON.stringify([accountId, message.id, message.text, message.replyMarkup, message.replyToId, windowMessages.map((item) => [item.id, item.text, item.out, item.replyToId]), fallbackLastQuery ?? '']);
      const key = String(message.id);
      if (this.metadataSignatureByMsg[message.id] === signature || pendingBotMetadata.get(key) === signature) return;
      pendingBotMetadata.set(key, signature);
      try {
        const metadata = await telegramBusClient.bot.metadata(accountId, message, windowMessages, fallbackLastQuery);
        if (pendingBotMetadata.get(key) !== signature) return;
        this.metadataSignatureByMsg[message.id] = signature;
        if (metadata.page && metadata.page > 0) this.parsedPageByMsg[message.id] = metadata.page;
        this.paginationByMsg[message.id] = metadata.hasPagination;
        this.pairedQueryByMsg[message.id] = metadata.pairedQuery;
      } finally {
        if (pendingBotMetadata.get(key) === signature) pendingBotMetadata.delete(key);
      }
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

    /**
     * 消息右侧工具条的「解析」入口：任何消息都可打开设置弹窗。
     * 分页元数据只在打开时向 Worker 请求一次（不再为每条机器人消息预取）；失败时弹窗仍可用，按单页解析。
     */
    async openHarvestDialog(messageId: number) {
      this.dialogMessageId = messageId;
      this.metadataFailedByMsg[messageId] = false;
      const chatStore = useChatStore();
      const accountId = chatStore.accountId;
      const windowMessages = chatStore.activeWindow?.messages ?? [];
      const message = windowMessages.find((item) => item.id === messageId);
      if (!accountId || !message) return;
      try {
        await this.refreshMessageMetadata(
          accountId,
          message,
          windowMessages,
          chatStore.activeChatKey ? chatStore.lastSentQueryByPeer[chatStore.activeChatKey] : undefined,
        );
      } catch (err) {
        this.metadataFailedByMsg[messageId] = true;
        debugLoggerDataSource.emitFrontendLog({
          domain: 'bot.callback',
          action: 'harvest_metadata_failed',
          level: 'WARN',
          message: err instanceof Error ? err.name : 'UnknownError',
          tags: { messageId },
        });
        // 失败与「确实没有翻页按钮」分开呈现；仍允许单页解析。
      }
    },

    closeHarvestDialog() {
      this.dialogMessageId = null;
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
      const initialMsg = chatStore.activeWindow?.messages.find((m) => m.id === messageId);
      const paired = initialMsg
        ? (await telegramBusClient.bot.metadata(accountId, initialMsg, chatStore.activeWindow?.messages ?? [], chatStore.activeChatKey ? chatStore.lastSentQueryByPeer[chatStore.activeChatKey] : undefined)).pairedQuery
        : this.getPairedQuery(messageId);
      this.harvestNotice = null;

      const taskId = sessionStore.enqueueTask({
        kind: 'bot_harvest',
        title: `收割「${paired.queryText}」(${dialog.title} 第 ${startPage}~${endPage} 页)`,
        total: Math.max(1, endPage - startPage + 1),
        accountId,
      });

      const initialPage = initialMsg ? ((await telegramBusClient.bot.metadata(accountId, initialMsg, chatStore.activeWindow?.messages ?? [])).page ?? startPage) : startPage;
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
            const pageItems = await telegramBusClient.bot.extractCandidates(accountId, currentMsg, page);
            this.mergeCandidates(pageItems);
            this.activeTask.harvestedCount = this.candidates.length;
            sessionStore.updateTaskProgress(taskId, Math.max(1, page - startPage + 1));
          }

          if (page >= endPage) break;

          const nextBtn = currentMsg?.replyMarkup
            ? await telegramBusClient.bot.findNextButton(accountId, currentMsg.replyMarkup, page + 1)
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
          const editWaiter = telegramBusClient.bot.waitForMessageEdit(dialog.key, messageId, 4800);

          // 2. 异步触发 GetBotCallbackAnswer（不阻塞等待 10s BOT_RESPONSE_TIMEOUT，且吞掉非致命超时）
          void telegramBusClient.bot
            .pressBotCallback(accountId, dialog.peer, messageId, nextBtn.data)
            .catch(() => undefined);

          // 3. 等待实时 UpdateEditMessage 到达；若 4.8s 超时未收到推送，再通过 getHistoryAround 兜底校准
          const editedMsg = await editWaiter;
          if (!this.activeTask || this.activeTask.status !== 'running') break;

          if (!editedMsg) {
            try {
              const refreshed = await telegramBusClient.chatRead.getHistoryAround(accountId, dialog.peer, messageId, 3);
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
          this.dialogMessageId = null;
          this.isCandidateModalOpen = true;
        }
      } catch (err) {
        const msg = telegramBusClient.readError(err);
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
