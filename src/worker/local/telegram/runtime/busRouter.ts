/**
 * ============================================================================
 * BusRouter：业务总线唯一入口（local Worker）
 * ============================================================================
 * 主线程 TelegramBusClient 发来的 { bus, op, input, context } 在这里查表执行：
 *   1. 按 accountId 取该账号唯一的 TelegramClient 与 RequestScheduler；
 *   2. 非媒体操作由路由表声明子池、默认优先级与 RPC 方法名，统一经调度器执行；
 *   3. 媒体操作（封面 / 完整文件 / 流分片）在总线内部自行调度（完整文件需嵌套 fullMedia + mediaPart）；
 *   4. 错误统一转为 TelegramBusError 领域错误，不向主线程抛 GramJS 异常对象。
 * 新增操作只需在 contracts/buses.ts 与本表各加一行；不存在任何方法字符串 if-chain 分发器。
 */
import type { TelegramClient } from 'telegram';
import type { BusInput, BusName, BusOpName, BusOutput } from '../contracts/buses';
import type { TelegramBusContext, TelegramBusError } from '../contracts/busContext';
import type { SchedulerLane, SchedulerPriority } from '../contracts/monitor';
import { classifyTelegramError } from '../../chat/telegramErrors';
import { schedulerFor, type AccountRequestScheduler, type BusTaskOptions } from './requestScheduler';
import { createCancelToken, type CancelToken } from './fileTransfer';
import { emitLocalSpan } from '../telemetry/localSpans';
import { probeAccountHealth, spawnPendingSlot } from '../buses/accountSessionBus';
import { getDialogs, getHistory, getHistoryAround, syncFrom } from '../buses/chatReadBus';
import { searchMessages } from '../buses/searchBus';
import { downloadAvatar, downloadDocumentThumb, downloadPhoto } from '../buses/coverBus';
import { downloadDocument } from '../buses/mediaAssetBus';
import { downloadDocumentPart } from '../buses/streamBus';
import {
  batchCheckChannels, batchSetDialogsArchived, checkChatInvite, deleteChat, importChatInvite,
  joinChat, leaveChat, resolveUsername, sendMessage, setDialogArchived,
} from '../buses/chatCommandBus';
import { detectCurrentBotPage, extractBotCandidatesFromMessage, findNextBotPageButton, hasBotPaginationControls, resolvePairedQueryForBotMessage } from '../buses/botHarvesterParser';
import { pressBotCallback, startBot } from '../buses/botInteractionBus';
import { cloneNoForwardsToVault, ensureVaultForumTopics, forwardToVault, syncBeaconCredentials } from '../buses/vaultTransferBus';

/** 路由执行环境：由 tg.worker 注入（账号客户端查找、连接重试包装、进度回传）。 */
export interface BusRuntime {
  clientFor(accountId: string): TelegramClient | null;
  /** 非媒体 RPC 的瞬时网络错误重试（不把业务错误当作断线）。 */
  withConnection<T>(accountId: string, operation: () => Promise<T>): Promise<T>;
  progress(requestId: string, loaded: number, total: number): void;
}

interface ExecEnv {
  client: TelegramClient;
  scheduler: AccountRequestScheduler;
  task: BusTaskOptions;
  token: CancelToken;
  onProgress: (loaded: number, total: number) => void;
}

type Exec<B extends BusName, O extends BusOpName<B>> = (input: BusInput<B, O>, env: ExecEnv) => Promise<BusOutput<B, O>>;

/** 非媒体操作：路由层调度。 */
interface ScheduledRoute<B extends BusName, O extends BusOpName<B>> {
  kind: 'scheduled';
  lane: SchedulerLane;
  priority: SchedulerPriority;
  method: string;
  run: Exec<B, O>;
}

/** 媒体操作：总线内部调度。 */
interface SelfRoute<B extends BusName, O extends BusOpName<B>> {
  kind: 'self';
  priority: SchedulerPriority;
  run: Exec<B, O>;
}

type Route<B extends BusName, O extends BusOpName<B>> = ScheduledRoute<B, O> | SelfRoute<B, O>;
type RouteTable = { [B in BusName]: { [O in BusOpName<B>]: Route<B, O> } };

const scheduled = <B extends BusName, O extends BusOpName<B>>(lane: SchedulerLane, priority: SchedulerPriority, method: string, run: Exec<B, O>): Route<B, O> => ({ kind: 'scheduled', lane, priority, method, run });
const self = <B extends BusName, O extends BusOpName<B>>(priority: SchedulerPriority, run: Exec<B, O>): Route<B, O> => ({ kind: 'self', priority, run });

const ROUTES: RouteTable = {
  account: {
    probeHealth: scheduled('account', 'background', 'account.GetAuthorizations', (i, e) => probeAccountHealth(e.client, i.ensureTtlDays)),
    spawnPendingSlot: scheduled('account', 'interactive', 'auth.ExportLoginToken', (i, e) => spawnPendingSlot(e.client, i)),
  },
  chatRead: {
    getDialogs: scheduled('chatRead', 'visible', 'messages.GetDialogs', (i, e) => getDialogs(e.client, i.folderId ?? 0, i.cursor, i.limit)),
    getHistory: scheduled('chatRead', 'interactive', 'messages.GetHistory', (i, e) => getHistory(e.client, i.peer, i.offsetId, i.limit)),
    getHistoryAround: scheduled('chatRead', 'interactive', 'messages.GetHistory', (i, e) => getHistoryAround(e.client, i.peer, i.messageId, i.limit)),
    syncFrom: scheduled('chatRead', 'visible', 'updates.GetDifference', (i, e) => syncFrom(e.client, i.state)),
  },
  search: {
    searchMessages: scheduled('search', 'interactive', 'messages.Search', (i, e) => searchMessages(e.client, i)),
  },
  cover: {
    avatar: self('visible', (i, e) => downloadAvatar(e.scheduler, e.task, e.client, i.peer, i.photoId, i.dcId, i.containerPeer, i.messageId)),
    photo: self('visible', (i, e) => downloadPhoto(e.scheduler, e.task, i.origin ?? 'chat', e.client, i.peer, i.messageId, i.photo, i.size)),
    documentThumb: self('visible', (i, e) => downloadDocumentThumb(e.scheduler, e.task, i.origin ?? 'chat', e.client, i.peer, i.messageId, i.document, i.size)),
  },
  mediaAsset: {
    document: self('interactive', (i, e) => downloadDocument(e.scheduler, e.task, e.client, i.peer, i.messageId, i.document, i.size, i.mimeType, e.token, e.onProgress)),
  },
  stream: {
    part: self('interactive', (i, e) => downloadDocumentPart(e.scheduler, e.task, e.client, i.peer, i.messageId, i.document, i.offset, i.limit, i.size, i.mimeType, e.token)),
  },
  chatCommand: {
    setArchived: scheduled('chatCommand', 'interactive', 'folders.EditPeerFolders', (i, e) => setDialogArchived(e.client, i.peer, i.archived)),
    batchSetArchived: scheduled('chatCommand', 'interactive', 'folders.EditPeerFolders', (i, e) => batchSetDialogsArchived(e.client, i.peers, i.archived)),
    resolveUsername: scheduled('chatCommand', 'interactive', 'contacts.ResolveUsername', (i, e) => resolveUsername(e.client, i.username)),
    join: scheduled('chatCommand', 'interactive', 'channels.JoinChannel', (i, e) => joinChat(e.client, i.peer)),
    leave: scheduled('chatCommand', 'interactive', 'channels.LeaveChannel', (i, e) => leaveChat(e.client, i.peer)),
    deleteChat: scheduled('chatCommand', 'interactive', 'messages.DeleteHistory', (i, e) => deleteChat(e.client, i.peer, i.revoke)),
    sendMessage: scheduled('chatCommand', 'interactive', 'messages.SendMessage', (i, e) => sendMessage(e.client, i.peer, i.text, i.replyToMsgId)),
    checkInvite: scheduled('chatCommand', 'interactive', 'messages.CheckChatInvite', (i, e) => checkChatInvite(e.client, i.hash)),
    importInvite: scheduled('chatCommand', 'interactive', 'messages.ImportChatInvite', (i, e) => importChatInvite(e.client, i.hash)),
    batchCheckChannels: scheduled('chatCommand', 'background', 'channels.GetChannels', (i, e) => batchCheckChannels(e.client, i.channels)),
  },
  bot: {
    metadata: scheduled('bot', 'visible', 'local.bot.metadata', (i) => Promise.resolve({
      page: detectCurrentBotPage(i.message),
      hasPagination: hasBotPaginationControls(i.message.replyMarkup ?? []),
      pairedQuery: resolvePairedQueryForBotMessage(i.message, i.windowMessages, i.fallbackLastQuery),
    })),
    findNextButton: scheduled('bot', 'visible', 'local.bot.findNextButton', (i) => Promise.resolve(findNextBotPageButton(i.rows, i.nextPageNum))),
    extractCandidates: scheduled('bot', 'visible', 'local.bot.extractCandidates', (i) => Promise.resolve(extractBotCandidatesFromMessage(i.message, i.pageNum))),
    start: scheduled('bot', 'interactive', 'messages.StartBot', (i, e) => startBot(e.client, i.bot, i.startParam)),
    pressCallback: scheduled('bot', 'interactive', 'messages.GetBotCallbackAnswer', (i, e) => pressBotCallback(e.client, i.peer, i.messageId, i.data)),
  },
  vault: {
    forward: scheduled('vault', 'background', 'messages.ForwardMessages', (i, e) => forwardToVault(e.client, i)),
    cloneNoForwards: scheduled('vault', 'background', 'messages.SendMedia', (i, e) => cloneNoForwardsToVault(e.client, i)),
    ensureTopics: scheduled('vault', 'background', 'channels.CreateForumTopic', (i, e) => ensureVaultForumTopics(e.client, i)),
    syncBeacon: scheduled('vault', 'background', 'messages.Search', (i, e) => syncBeaconCredentials(e.client, i)),
  },
};

/** 进行中请求的取消令牌：busCancel(requestId) 触发，调度器排队中的任务立即出队。 */
const cancelTokens = new Map<string, CancelToken>();

export function cancelBusRequest(requestId: string) {
  cancelTokens.get(requestId)?.cancel();
}

/** 账号切换 / 拆除时中断全部进行中的请求。 */
export function cancelAllBusRequests() {
  for (const token of cancelTokens.values()) token.cancel();
}

export function toBusError(error: unknown): TelegramBusError {
  const info = classifyTelegramError(error);
  const seconds = info.bucket === 'FLOOD_WAIT' ? Number(/(\d+)$/.exec(info.code)?.[1] ?? 0) : 0;
  const raw = error instanceof Error ? error.message : '';
  return {
    code: info.code === 'UNKNOWN' && raw ? raw.toUpperCase().slice(0, 120) : info.code,
    message: raw || info.description,
    bucket: info.bucket,
    retryable: info.retryable,
    retryAfterMs: seconds > 0 ? seconds * 1000 : undefined,
  };
}

function notConnected(): Error {
  return Object.assign(new Error('Telegram 账户尚未连接'), { code: 'TG_NOT_CONNECTED' });
}

/** 执行一次总线请求；返回值可直接 postMessage（媒体字节由调用方 transfer）。 */
export async function routeBusRequest<B extends BusName, O extends BusOpName<B>>(
  runtime: BusRuntime,
  bus: B,
  op: O,
  input: BusInput<B, O>,
  context: TelegramBusContext,
): Promise<BusOutput<B, O>> {
  const route = (ROUTES[bus] as Record<string, Route<B, O>> | undefined)?.[op];
  if (!route) throw Object.assign(new Error(`未知的总线操作 ${bus}.${op}`), { code: 'TG_UNKNOWN_OP' });
  const client = runtime.clientFor(context.accountId);
  if (!client) throw notConnected();
  const scheduler = schedulerFor(context.accountId);
  const token = createCancelToken();
  cancelTokens.set(context.requestId, token);
  const priority = context.priority ?? route.priority;
  const env: ExecEnv = {
    client,
    scheduler,
    task: { priority, traceId: context.traceId, signal: token.signal },
    token,
    onProgress: (loaded, total) => runtime.progress(context.requestId, loaded, total),
  };
  const startedAt = Date.now();
  try {
    const result = route.kind === 'scheduled'
      ? await scheduler.run(
        route.lane,
        () => runtime.withConnection(context.accountId, () => route.run(input, env)),
        { priority, traceId: context.traceId, signal: token.signal, method: route.method, operation: `${bus}.${op}` },
      )
      : await route.run(input, env);
    emitLocalSpan({ traceId: context.traceId, domain: 'bus.request', action: 'ok', level: 'DEBUG', durMs: Date.now() - startedAt, tags: { bus, op, source: context.source, accountId: context.accountId } });
    return result;
  } catch (error) {
    const info = classifyTelegramError(error);
    emitLocalSpan({
      traceId: context.traceId,
      domain: 'bus.request',
      action: info.bucket === 'CANCELLED' ? 'cancelled' : 'error',
      level: info.bucket === 'CANCELLED' ? 'DEBUG' : 'WARN',
      durMs: Date.now() - startedAt,
      message: info.description,
      tags: { bus, op, source: context.source, accountId: context.accountId, bucket: info.bucket, code: info.code },
    });
    throw error;
  } finally {
    cancelTokens.delete(context.requestId);
  }
}
