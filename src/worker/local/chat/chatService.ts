/**
 * 本地 Worker 内的只读聊天服务：
 * - 会话列表 / 历史分页 / 公共更新补差三类 RPC；
 * - 单实例实时更新引擎：把 GramJS Raw updates 转为 DTO 批量广播，并跟踪公共 pts 发现缺口。
 * 只持有内存态，不落盘；持久缓存由主线程 chat 域负责。
 */
import { Buffer } from 'buffer';
import { TelegramClient } from 'telegram';
import { CustomFile } from 'telegram/client/uploads';
import { Api } from 'telegram/tl';
import { StringSession } from 'telegram/sessions';
import { computeCheck } from 'telegram/Password';
import { returnBigInt } from 'telegram/Helpers';
import { UpdateConnectionState } from 'telegram/network';
import type {
  TgAccountHealthReport, TgCallbackAnswer, TgChatRequest, TgChatUpdate, TgDialogCursor, TgDialogDto, TgDialogPage,
  TgHistoryPage, TgInvitePreview, TgJoinChatResult, TgMessageDto, TgPeerKey, TgPeerRef, TgSearchMessagesPage,
  TgSpawnedSlotResult, TgSyncResult, TgUpdatesState, TgVaultTopicsInfo,
} from '../chatProtocol';
import { indexMessages, isSelfKey, peerInfo, peerKeyOf, rememberEntities, resetPeerCache, selfUserId, toDialog, toMessage, toPeerDialog, toShortMessage } from './converters';
import {
  advancePtsFromRpcResult,
  configureMtprotoGateway,
  emitLocalSpan,
  invokeWithGateway,
  startLocalTrace,
  type LocalDebugEmitter,
  type LocalTraceContext,
} from './mtprotoGateway';
import { classifyTelegramError } from './telegramErrors';

type ConnectionReporter = (state: 'online' | 'reconnecting', message?: string) => void;
/** 更新广播器：把批量 DTO + 最新 pts 状态交给 Worker 主入口去 postMessage */
type UpdatesEmitter = (accountId: string, updates: TgChatUpdate[], state?: TgUpdatesState) => void;

/** 实时更新引擎的内部状态（同一时刻只会存在一个） */
interface Engine {
  client: TelegramClient;
  accountId: string;
  state: TgUpdatesState | null;
  disconnected: boolean;
  queue: TgChatUpdate[];
  flushTimer?: ReturnType<typeof setTimeout>;
  emitUpdates: UpdatesEmitter;
  reportConnection: ConnectionReporter;
}

/** 差异分片最多连续拉取的次数；超过即视为差异过大，交给调用方重建。 */
const MAX_DIFFERENCE_SLICES = 8;
// 更新合并窗口：40ms 内的多条更新合成一批，减少跨线程通信次数（类似 requestAnimationFrame 节流）
const FLUSH_DELAY_MS = 40;

/** 只有公共消息盒的更新参与 pts 连续性校验；频道更新各自维护 pts，不在此列。 */
const COMMON_PTS_UPDATES = [
  Api.UpdateNewMessage, Api.UpdateEditMessage, Api.UpdateDeleteMessages, Api.UpdateReadHistoryInbox,
  Api.UpdateReadHistoryOutbox, Api.UpdateReadMessagesContents, Api.UpdateWebPage, Api.UpdatePinnedMessages,
  Api.UpdateFolderPeers, Api.UpdateShortMessage, Api.UpdateShortChatMessage,
];

let engine: Engine | null = null;

/** 调试开关跟随 Worker init 或 setDebug 动态标志；结构化分级 Span 通过 emitter 推回主线程。 */
let debugEnabled = false;
export function setChatDebug(enabled: boolean, emitter?: LocalDebugEmitter) {
  debugEnabled = enabled;
  configureMtprotoGateway({ enabled, emitter });
}
function chatDebug(stage: string, detail: Record<string, unknown>) {
  if (debugEnabled) {
    emitLocalSpan({
      domain: 'chat.service',
      action: stage,
      level: 'DEBUG',
      tags: detail as Record<string, string | number | boolean | undefined>,
    });
  }
}

function toState(state: Api.updates.State): TgUpdatesState {
  return { pts: state.pts, qts: state.qts, date: state.date, seq: state.seq };
}

/** 多个标签页可能以不同旧状态补差，引擎只接受更新的 pts，防止回退。 */
function adoptState(state: TgUpdatesState) {
  if (!engine) return;
  if (!engine.state || state.pts >= engine.state.pts) engine.state = { ...state };
}

/** 把 DTO 更新压入队列，并用 40ms 定时器合并成一批发出 */
function enqueue(updates: TgChatUpdate[]) {
  if (!engine || updates.length === 0) return;
  engine.queue.push(...updates);
  if (engine.flushTimer) return;
  const current = engine;
  current.flushTimer = setTimeout(() => {
    current.flushTimer = undefined;
    if (engine !== current || current.queue.length === 0) return;
    const batch = current.queue;
    current.queue = [];
    current.emitUpdates(current.accountId, batch, current.state ? { ...current.state } : undefined);
  }, FLUSH_DELAY_MS);
}

/** 把单条 TL 更新映射为 0..n 条 DTO 更新；实时与补差两条路径共用。 */
function convertUpdate(update: Api.TypeUpdate | Api.TypeUpdates): TgChatUpdate[] {
  if (update instanceof Api.UpdateNewMessage || update instanceof Api.UpdateNewChannelMessage) {
    const message = toMessage(update.message);
    return message ? [{ type: 'newMessage', message }] : [];
  }
  if (update instanceof Api.UpdateEditMessage || update instanceof Api.UpdateEditChannelMessage) {
    const message = toMessage(update.message);
    return message ? [{ type: 'editMessage', message }] : [];
  }
  if (update instanceof Api.UpdateShortMessage || update instanceof Api.UpdateShortChatMessage) return [{ type: 'newMessage', message: toShortMessage(update) }];
  if (update instanceof Api.UpdateDeleteMessages) return [{ type: 'deleteMessages', ids: update.messages }];
  if (update instanceof Api.UpdateDeleteChannelMessages) return [{ type: 'deleteMessages', peerKey: `channel-${update.channelId.toString()}`, ids: update.messages }];
  if (update instanceof Api.UpdateReadHistoryInbox) return [{ type: 'readInbox', peerKey: peerKeyOf(update.peer), maxId: update.maxId, stillUnreadCount: update.stillUnreadCount }];
  if (update instanceof Api.UpdateReadChannelInbox) return [{ type: 'readInbox', peerKey: `channel-${update.channelId.toString()}`, maxId: update.maxId, stillUnreadCount: update.stillUnreadCount }];
  if (update instanceof Api.UpdateReadHistoryOutbox) return [{ type: 'readOutbox', peerKey: peerKeyOf(update.peer), maxId: update.maxId }];
  if (update instanceof Api.UpdateReadChannelOutbox) return [{ type: 'readOutbox', peerKey: `channel-${update.channelId.toString()}`, maxId: update.maxId }];
  if (update instanceof Api.UpdateChannelTooLong) return [{ type: 'channelTooLong', peerKey: `channel-${update.channelId.toString()}` }];
  if (update instanceof Api.UpdatesTooLong) return [{ type: 'gap' }];
  if (update instanceof Api.UpdateFolderPeers) {
    const peers = update.folderPeers
      .filter((item): item is Api.FolderPeer => item instanceof Api.FolderPeer)
      .map((item) => ({ peerKey: peerKeyOf(item.peer), folderId: (item.folderId === 1 ? 1 : 0) as 0 | 1 }));
    return peers.length > 0 ? [{ type: 'folderPeers', peers }, { type: 'dialogsChanged' }] : [{ type: 'dialogsChanged' }];
  }
  if (update instanceof Api.UpdateDialogPinned && update.peer instanceof Api.DialogPeer) {
    return [{ type: 'dialogPinned', peerKey: peerKeyOf(update.peer.peer), folderId: update.folderId === 1 ? 1 : 0, pinned: Boolean(update.pinned) }, { type: 'dialogsChanged' }];
  }
  if (update instanceof Api.UpdateDialogUnreadMark && update.peer instanceof Api.DialogPeer) {
    return [{ type: 'dialogUnreadMark', peerKey: peerKeyOf(update.peer.peer), unreadMark: Boolean(update.unread) }];
  }
  if (update instanceof Api.UpdateChannel) {
    const peerKey = `channel-${update.channelId.toString()}`;
    const info = peerInfo(peerKey);
    if (info?.left || info?.kicked) return [{ type: 'peerLeft', peerKey, kicked: info.kicked }, { type: 'dialogsChanged' }];
    return [{ type: 'dialogsChanged' }];
  }
  if (update instanceof Api.UpdateChat) {
    const peerKey = `chat-${update.chatId.toString()}`;
    const info = peerInfo(peerKey);
    if (info?.left || info?.kicked) return [{ type: 'peerLeft', peerKey, kicked: info.kicked }, { type: 'dialogsChanged' }];
    return [{ type: 'dialogsChanged' }];
  }
  if (update instanceof Api.UpdatePinnedDialogs) return [{ type: 'dialogsChanged' }];
  return [];
}

/** 将主动变更 RPC（归档、加入、退出、发消息等）返回的 Updates 合并进实体缓存、推进 pts 并推入实时更新流。 */
function ingestUpdatesResult(result: unknown, trace?: LocalTraceContext) {
  if (engine?.state) {
    advancePtsFromRpcResult(engine.state, result, trace, 'ingestUpdatesResult');
  }
  if (result instanceof Api.Updates || result instanceof Api.UpdatesCombined) {
    rememberEntities(result.users, result.chats);
    const converted = result.updates.flatMap((item) => convertUpdate(item));
    if (converted.length > 0) enqueue(converted);
  }
}

/**
 * 公共消息盒的 pts 连续性校验：
 *   apply = 正好接上，可以照常下发；
 *   skip  = 旧的重复更新，丢弃；
 *   gap   = 中间漏了东西，需要让前端走 getDifference 补差。
 */
function checkCommonPts(update: unknown): 'apply' | 'skip' | 'gap' {
  if (!engine?.state || !COMMON_PTS_UPDATES.some((type) => update instanceof type)) return 'apply';
  const { pts, ptsCount } = update as { pts: number; ptsCount: number };
  const oldPts = engine.state.pts;
  const className = (update as { className?: string }).className ?? 'Update';
  if (oldPts + ptsCount === pts) {
    engine.state.pts = pts;
    emitLocalSpan({
      domain: 'chat.pts',
      action: 'check_pts',
      level: 'INFO',
      tags: { update: className, oldPts, incomingPts: pts, ptsCount, verdict: 'apply' },
    });
    return 'apply';
  }
  if (pts <= oldPts) {
    emitLocalSpan({
      domain: 'chat.pts',
      action: 'check_pts',
      level: 'DEBUG',
      tags: { update: className, oldPts, incomingPts: pts, ptsCount, verdict: 'skip' },
    });
    return 'skip';
  }
  engine.state.pts = pts;
  emitLocalSpan({
    domain: 'chat.pts',
    action: 'pts_gap_detected',
    level: 'WARN',
    tags: { update: className, oldPts, incomingPts: pts, ptsCount, verdict: 'gap' },
  });
  return 'gap';
}

/** GramJS 原始更新入口：先处理连接状态，再转 DTO 并入队 */
function handleRawUpdate(update: unknown) {
  if (!engine) return;
  if (update instanceof UpdateConnectionState) {
    if (update.state === UpdateConnectionState.connected) {
      if (!engine.disconnected) return;
      engine.disconnected = false;
      emitLocalSpan({
        domain: 'tg.connection',
        action: 'state_change',
        level: 'INFO',
        tags: { accountId: engine.accountId, state: 'online' },
      });
      engine.reportConnection('online');
      // 断线期间可能漏掉更新，由各标签页按自身状态补差。
      enqueue([{ type: 'gap' }]);
      return;
    }
    engine.disconnected = true;
    emitLocalSpan({
      domain: 'tg.connection',
      action: 'state_change',
      level: 'WARN',
      tags: { accountId: engine.accountId, state: 'reconnecting' },
    });
    engine.reportConnection('reconnecting', 'Telegram 连接中断，正在重连…');
    return;
  }
  const entities = (update as { _entities?: Map<string, Api.TypeUser | Api.TypeChat> })._entities;
  if (entities?.size) rememberEntities([...entities.values()]);
  const verdict = checkCommonPts(update);
  if (verdict === 'skip') return;
  const converted = convertUpdate(update as Api.TypeUpdate);
  const date = (update as { message?: { date?: number }; date?: number }).message?.date ?? (update as { date?: number }).date;
  if (engine.state && typeof date === 'number' && date > engine.state.date) engine.state.date = date;
  for (const item of converted) {
    if (item.type === 'newMessage' || item.type === 'editMessage') {
      emitLocalSpan({
        domain: 'chat.updates',
        action: item.type,
        level: 'INFO',
        tags: {
          peer: item.message.peerKey,
          msgId: item.message.id,
          out: item.message.out,
          hasButtons: Boolean(item.message.replyMarkup?.length),
          verdict,
        },
      });
    } else if (item.type === 'deleteMessages') {
      emitLocalSpan({
        domain: 'chat.updates',
        action: 'deleteMessages',
        level: 'INFO',
        tags: {
          peer: item.peerKey ?? 'global',
          ids: item.ids.join(','),
          verdict,
        },
      });
    }
  }
  enqueue(verdict === 'gap' ? [...converted, { type: 'gap' }] : converted);
}

/** 授权完成（恢复或新登录）后启动；同一时间只服务一个账户。 */
export function startChatEngine(client: TelegramClient, accountId: string, selfId: string, emitUpdates: UpdatesEmitter, reportConnection: ConnectionReporter) {
  stopChatEngine();
  resetPeerCache(selfId);
  const current: Engine = { client, accountId, state: null, disconnected: false, queue: [], emitUpdates, reportConnection };
  engine = current;
  client.addEventHandler((update: unknown) => { if (engine === current) handleRawUpdate(update); });
  // GetState 既初始化缺口检测基线，也让服务端开始向本连接推送更新。
  void client.invoke(new Api.updates.GetState()).then((state) => { if (engine === current) adoptState(toState(state)); }).catch(() => undefined);
}

/** 停止引擎并清掉未发出的定时器 */
export function stopChatEngine() {
  if (engine?.flushTimer) clearTimeout(engine.flushTimer);
  engine = null;
}

/** 健康检查：引擎绑定的是该账户、未断线、且底层连接仍在 */
export function isChatEngineHealthy(accountId: string): boolean {
  return Boolean(engine && engine.accountId === accountId && !engine.disconnected && engine.client.connected);
}

/**
 * 把 DTO 里的 peer 引用转成 GramJS 的 InputPeer。
 * 优先用调用方给的 accessHash，其次用实体缓存，都没有则让 GramJS 自己去解析。
 * 「自己」需要特殊处理成 InputPeerSelf。
 */
export async function resolveInputPeer(client: TelegramClient, ref: TgPeerRef): Promise<Api.TypeInputPeer> {
  if (ref.type === 'user' && isSelfKey(`user-${ref.id}`)) return new Api.InputPeerSelf();
  if (ref.type === 'chat') return new Api.InputPeerChat({ chatId: returnBigInt(ref.id) });
  const key = `${ref.type}-${ref.id}` as TgPeerKey;
  const accessHash = ref.accessHash ?? peerInfo(key)?.ref.accessHash;
  if (accessHash !== undefined) {
    return ref.type === 'user'
      ? new Api.InputPeerUser({ userId: returnBigInt(ref.id), accessHash: returnBigInt(accessHash) })
      : new Api.InputPeerChannel({ channelId: returnBigInt(ref.id), accessHash: returnBigInt(accessHash) });
  }
  const peer = ref.type === 'user' ? new Api.PeerUser({ userId: returnBigInt(ref.id) }) : new Api.PeerChannel({ channelId: returnBigInt(ref.id) });
  try {
    return await client.getInputEntity(peer);
  } catch {
    // 若该会话位于归档文件夹 (folderId=1) 或尚未拉取进缓存，尝试拉取归档与活动会话首页填充实体字典
    for (const folderId of [1, 0] as const) {
      try {
        const res = await client.invoke(new Api.messages.GetDialogs({
          offsetDate: 0,
          offsetId: 0,
          offsetPeer: new Api.InputPeerEmpty(),
          limit: 100,
          hash: returnBigInt(0),
          excludePinned: false,
          folderId,
        }));
        if (!(res instanceof Api.messages.DialogsNotModified)) {
          rememberEntities(res.users, res.chats);
        }
        const hydrated = peerInfo(key)?.ref.accessHash;
        if (hydrated !== undefined) {
          return ref.type === 'user'
            ? new Api.InputPeerUser({ userId: returnBigInt(ref.id), accessHash: returnBigInt(hydrated) })
            : new Api.InputPeerChannel({ channelId: returnBigInt(ref.id), accessHash: returnBigInt(hydrated) });
        }
      } catch {
        // 忽略拉取异常，继续尝试
      }
    }
    return client.getInputEntity(peer);
  }
}

/** 把一批原始 Dialog 转成 DTO，过滤掉无法识别的类型 */
function dialogsOf(list: Api.TypeDialog[], messages: Parameters<typeof toDialog>[1], folderId: 0 | 1): TgDialogDto[] {
  return list.flatMap((item) => {
    if (!(item instanceof Api.Dialog)) return [];
    const dialog = toDialog(item, messages, folderId);
    return dialog ? [dialog] : [];
  });
}

/**
 * 会话列表分页：首页额外拉一次置顶会话（用于渲染置顶区与归档入口）。
 * 游标由「最后一条 Dialog 的 topMessage 日期 + ID + peer」组成，不能用数组下标。
 */
async function getDialogs(client: TelegramClient, folderId: 0 | 1, cursor: TgDialogCursor | undefined, limit: number): Promise<TgDialogPage> {
  const offsetPeer = cursor ? await resolveInputPeer(client, cursor.offsetPeer) : new Api.InputPeerEmpty();
  const [pinnedResult, result] = await Promise.all([
    cursor ? Promise.resolve(null) : client.invoke(new Api.messages.GetPinnedDialogs({ folderId })),
    client.invoke(new Api.messages.GetDialogs({
      offsetDate: cursor?.offsetDate ?? 0,
      offsetId: cursor?.offsetId ?? 0,
      offsetPeer,
      limit,
      hash: returnBigInt(0),
      excludePinned: true,
      folderId,
    })),
  ]);
  let pinned: TgDialogDto[] = [];
  let hasArchive = false;
  if (pinnedResult) {
    rememberEntities(pinnedResult.users, pinnedResult.chats);
    pinned = dialogsOf(pinnedResult.dialogs, indexMessages(pinnedResult.messages), folderId);
    hasArchive = folderId === 0 && pinnedResult.dialogs.some((item) => item instanceof Api.DialogFolder);
  }
  const pinnedKeys = cursor ? undefined : pinned.map((dialog) => dialog.key);
  const archiveHint = cursor || folderId !== 0 ? undefined : hasArchive;
  if (result instanceof Api.messages.DialogsNotModified) return { pinnedKeys, dialogs: pinned, hasMore: false, totalCount: pinned.length, hasArchive: archiveHint };
  rememberEntities(result.users, result.chats);
  const messages = indexMessages(result.messages);
  const dialogs = dialogsOf(result.dialogs, messages, folderId);
  if (!cursor && folderId === 0 && result.dialogs.some((item) => item instanceof Api.DialogFolder)) hasArchive = true;
  const lastRaw = [...result.dialogs].reverse().find((item): item is Api.Dialog => item instanceof Api.Dialog);
  const lastInfo = lastRaw ? peerInfo(peerKeyOf(lastRaw.peer)) : undefined;
  const nextCursor = lastRaw && lastInfo
    ? { offsetDate: messages.get(`${peerKeyOf(lastRaw.peer)}:${lastRaw.topMessage}`)?.date ?? 0, offsetId: lastRaw.topMessage, offsetPeer: lastInfo.ref }
    : undefined;
  const isSlice = result instanceof Api.messages.DialogsSlice;
  const hasMore = isSlice && result.dialogs.length > 0 && nextCursor !== undefined;
  const totalCount = isSlice ? result.count : pinned.length + dialogs.length;
  chatDebug('dialogs:page', { folderId, cursor: Boolean(cursor), raw: result.dialogs.length, converted: dialogs.length, pinned: pinned.length, slice: isSlice, total: totalCount, hasArchive });
  return { pinnedKeys, dialogs: [...pinned, ...dialogs], nextCursor, hasMore, totalCount, hasArchive: cursor || folderId !== 0 ? undefined : hasArchive };
}

/** 历史消息分页：返回按 id 升序的消息，并告知是否还有更早的 */
async function getHistory(client: TelegramClient, ref: TgPeerRef, offsetId: number, limit: number): Promise<TgHistoryPage> {
  const result = await client.invoke(new Api.messages.GetHistory({
    peer: await resolveInputPeer(client, ref),
    offsetId,
    offsetDate: 0,
    addOffset: 0,
    limit,
    maxId: 0,
    minId: 0,
    hash: returnBigInt(0),
  }));
  if (result instanceof Api.messages.MessagesNotModified) return { messages: [], hasOlder: false };
  rememberEntities(result.users, result.chats);
  const messages = result.messages.flatMap((item) => { const message = toMessage(item); return message ? [message] : []; }).sort((a, b) => a.id - b.id);
  // messages.Messages 表示一次返回了全部历史；分片返回不足 limit 说明已到最早。
  const hasOlder = !(result instanceof Api.messages.Messages) && result.messages.length >= limit;
  return { messages, hasOlder };
}

/** 拉取指定消息 ID 前后的历史上下文（用于跨历史跳转定位与被回复消息补全）。 */
async function getHistoryAround(client: TelegramClient, ref: TgPeerRef, messageId: number, limit: number): Promise<TgHistoryPage> {
  const startedAt = Date.now();
  const safeLimit = Math.max(10, limit);
  const half = Math.floor(safeLimit / 2);
  const peerKey = `${ref.type}-${ref.id}` as TgPeerKey;
  try {
    const result = await client.invoke(new Api.messages.GetHistory({
      peer: await resolveInputPeer(client, ref),
      offsetId: messageId,
      offsetDate: 0,
      addOffset: -half,
      limit: safeLimit,
      maxId: 0,
      minId: 0,
      hash: returnBigInt(0),
    }));
    if (result instanceof Api.messages.MessagesNotModified) return { messages: [], hasOlder: false };
    rememberEntities(result.users, result.chats);
    const messages = result.messages.flatMap((item) => { const message = toMessage(item); return message ? [message] : []; }).sort((a, b) => a.id - b.id);
    const hasOlder = !(result instanceof Api.messages.Messages) && result.messages.length > 0;
    if (debugEnabled) {
      emitLocalSpan({
        domain: 'chat.history',
        action: 'history_around_ok',
        level: 'DEBUG',
        durMs: Date.now() - startedAt,
        tags: { peerKey, messageId, limit: safeLimit, returned: messages.length, hasOlder },
      });
    }
    return { messages, hasOlder };
  } catch (error) {
    const info = classifyTelegramError(error);
    emitLocalSpan({
      domain: 'chat.history',
      action: 'history_around_error',
      level: 'WARN',
      durMs: Date.now() - startedAt,
      message: info.description,
      tags: { peerKey, messageId, limit: safeLimit, bucket: info.bucket, code: info.code, retryable: info.retryable },
    });
    throw error;
  }
}

/** 无本地状态时的新基线：拿当前 pts，不返回任何更新 */
async function resetState(client: TelegramClient): Promise<TgSyncResult> {
  const state = toState(await client.invoke(new Api.updates.GetState()));
  adoptState(state);
  return { kind: 'reset', state, updates: [] };
}

/** 从调用方的旧状态补差；结果只回给请求方，实时更新仍走广播。 */
async function syncFrom(client: TelegramClient, from: TgUpdatesState | null): Promise<TgSyncResult> {
  if (!from) return resetState(client);
  let current = { ...from };
  const updates: TgChatUpdate[] = [];
  for (let slice = 0; slice < MAX_DIFFERENCE_SLICES; slice += 1) {
    const difference = await client.invoke(new Api.updates.GetDifference({ pts: current.pts, date: current.date, qts: current.qts }));
    if (difference instanceof Api.updates.DifferenceEmpty) {
      current = { ...current, date: difference.date, seq: difference.seq };
      adoptState(current);
      return { kind: 'difference', state: current, updates };
    }
    if (difference instanceof Api.updates.DifferenceTooLong) return resetState(client);
    rememberEntities(difference.users, difference.chats);
    for (const message of difference.newMessages) {
      const dto = toMessage(message);
      if (dto) updates.push({ type: 'newMessage', message: dto });
    }
    for (const update of difference.otherUpdates) updates.push(...convertUpdate(update));
    if (difference instanceof Api.updates.Difference) {
      current = toState(difference.state);
      adoptState(current);
      // 补差结果本身已覆盖缺口，过滤掉其中再次出现的缺口信号。
      return { kind: 'difference', state: current, updates: updates.filter((item) => item.type !== 'gap') };
    }
    current = toState(difference.intermediateState);
  }
  return resetState(client);
}

async function dispatchChatRequest(
  client: TelegramClient,
  request: Exclude<TgChatRequest, { method: 'getAvatar' | 'getPhoto' | 'getDocumentThumb' | 'getDocument' | 'getDocumentPart' }>,
): Promise<unknown> {
  if (request.method === 'getDialogs') return getDialogs(client, request.folderId ?? 0, request.cursor, request.limit);
  if (request.method === 'getHistory') return getHistory(client, request.peer, request.offsetId, request.limit);
  if (request.method === 'getHistoryAround') return getHistoryAround(client, request.peer, request.messageId, request.limit);
  if (request.method === 'syncFrom') return syncFrom(client, request.state);
  if (request.method === 'setDialogArchived') return setDialogArchived(client, request.peer, request.archived);
  if (request.method === 'resolveUsername') return resolveUsername(client, request.username);
  if (request.method === 'joinChat') return joinChat(client, request.peer);
  if (request.method === 'leaveChat') return leaveChat(client, request.peer);
  if (request.method === 'deleteChat') return deleteChat(client, request.peer, request.revoke);
  if (request.method === 'sendMessage') return sendMessage(client, request.peer, request.text, request.replyToMsgId);
  if (request.method === 'startBot') return startBot(client, request.bot, request.startParam);
  if (request.method === 'pressBotCallback') return pressBotCallback(client, request.peer, request.messageId, request.data);
  if (request.method === 'checkChatInvite') return checkChatInvite(client, request.hash);
  if (request.method === 'importChatInvite') return importChatInvite(client, request.hash);
  if (request.method === 'batchSetDialogsArchived') return batchSetDialogsArchived(client, request.peers, request.archived);
  if (request.method === 'batchCheckChannels') return batchCheckChannels(client, request.channels);
  if (request.method === 'searchMessages') return searchMessages(client, request);
  if (request.method === 'forwardToVault') return forwardToVault(client, request);
  if (request.method === 'cloneNoForwardsToVault') return cloneNoForwardsToVault(client, request);
  if (request.method === 'ensureVaultForumTopics') return ensureVaultForumTopics(client, request);
  if (request.method === 'syncBeaconCredentials') return syncBeaconCredentials(client, request);
  if (request.method === 'probeAccountHealth') return probeAccountHealth(client, request.ensureTtlDays);
  return spawnPendingSlot(client, request);
}

/**
 * 所有主线程 → Worker 聊天请求的统一入口。
 * 在分发前后统一记录 `chat.rpc`（方法、耗时、错误分桶），
 * 保证任何 Telegram 交互都有可检索的日志，即使具体业务函数忘了埋点。
 */
export async function runChatRequest(
  client: TelegramClient,
  request: Exclude<TgChatRequest, { method: 'getAvatar' | 'getPhoto' | 'getDocumentThumb' | 'getDocument' | 'getDocumentPart' }>,
): Promise<unknown> {
  const startedAt = Date.now();
  try {
    const result = await dispatchChatRequest(client, request);
    emitLocalSpan({
      domain: 'chat.rpc',
      action: 'request_ok',
      level: 'DEBUG',
      durMs: Date.now() - startedAt,
      tags: { method: request.method },
    });
    return result;
  } catch (error) {
    const info = classifyTelegramError(error);
    emitLocalSpan({
      domain: 'chat.rpc',
      action: 'request_error',
      level: 'ERROR',
      durMs: Date.now() - startedAt,
      message: info.description,
      tags: {
        method: request.method,
        bucket: info.bucket,
        code: info.code,
        retryable: info.retryable,
      },
    });
    throw error;
  }
}

/** 阶段 8：通过 folders.EditPeerFolders 归档或取消归档会话。 */
async function setDialogArchived(client: TelegramClient, ref: TgPeerRef, archived: boolean): Promise<{ folderId: 0 | 1 }> {
  if (ref.type === 'user' && isSelfKey(`user-${ref.id}`)) {
    throw Object.assign(new Error('收藏夹不支持归档'), { code: 'TG_CANNOT_ARCHIVE_SELF' });
  }
  const folderId: 0 | 1 = archived ? 1 : 0;
  const peer = await resolveInputPeer(client, ref);
  const result = await client.invoke(new Api.folders.EditPeerFolders({
    folderPeers: [new Api.InputFolderPeer({ peer, folderId })],
  }));
  ingestUpdatesResult(result);
  return { folderId };
}

/** 提取合法的公开用户名（支持 @username 或 t.me/username）。 */
export function cleanUsername(raw: string): string | null {
  const trimmed = raw.trim().replace(/^(?:https?:\/\/)?(?:t\.me|telegram\.me)\//i, '').replace(/^@/, '').split(/[/?#]/)[0]?.trim() ?? '';
  return /^[a-zA-Z][a-zA-Z0-9_]{3,31}$/.test(trimmed) ? trimmed : null;
}

async function resolveUsername(client: TelegramClient, raw: string): Promise<TgDialogDto | null> {
  const username = cleanUsername(raw);
  if (!username) return null;
  const result = await client.invoke(new Api.contacts.ResolveUsername({ username }));
  rememberEntities(result.users, result.chats);
  const key = peerKeyOf(result.peer);
  return toPeerDialog(key) ?? null;
}

/**
 * 阶段 9：加入公开频道或超级群组。
 * - 直接成功：合并服务端返回的 Channel 与 Updates，返回 status='joined'；
 * - 需管理员审批（INVITE_REQUEST_SENT）：返回 status='pending'，不得当作已加入；
 * - 需 WebView 验证：返回 status='webview'。
 */
async function joinChat(client: TelegramClient, ref: TgPeerRef): Promise<TgJoinChatResult> {
  if (ref.type !== 'channel') {
    throw Object.assign(new Error('仅支持直接加入公开频道或超级群组'), { code: 'TG_JOIN_UNSUPPORTED' });
  }
  const input = await resolveInputPeer(client, ref);
  if (!(input instanceof Api.InputPeerChannel)) {
    throw Object.assign(new Error('无法识别目标频道或群组'), { code: 'CHANNEL_INVALID' });
  }
  try {
    const result = await client.invoke(new Api.channels.JoinChannel({
      channel: new Api.InputChannel({ channelId: input.channelId, accessHash: input.accessHash }),
    }));
    if ((result as { className?: string })?.className === 'messages.ChatInviteJoinResultWebView') {
      return { status: 'webview' };
    }
    ingestUpdatesResult(result);
    return { status: 'joined', dialog: toPeerDialog(`channel-${ref.id}`) };
  } catch (error) {
    const code = String((error as { errorMessage?: string })?.errorMessage ?? (error instanceof Error ? error.message : '')).toUpperCase();
    if (code.includes('INVITE_REQUEST_SENT')) return { status: 'pending' };
    throw error;
  }
}

/**
 * 阶段 9：退出频道、超级群组或基础群组。
 * - 创建者（creator）受角色保护，需先转让所有权，拒绝直接退出；
 * - 频道 / 超级群组走 channels.LeaveChannel，基础群组走 messages.DeleteChatUser。
 */
async function leaveChat(client: TelegramClient, ref: TgPeerRef): Promise<{ ok: true }> {
  const key = `${ref.type}-${ref.id}`;
  const info = peerInfo(key);
  if (info?.creator) {
    throw Object.assign(new Error('你是该群组或频道的创建者，暂不支持直接退出，请先在官方客户端转让所有权'), { code: 'TG_OWNER_CANNOT_LEAVE' });
  }
  if (ref.type === 'channel') {
    const input = await resolveInputPeer(client, ref);
    if (!(input instanceof Api.InputPeerChannel)) {
      throw Object.assign(new Error('无法识别目标频道或群组'), { code: 'CHANNEL_INVALID' });
    }
    const result = await client.invoke(new Api.channels.LeaveChannel({
      channel: new Api.InputChannel({ channelId: input.channelId, accessHash: input.accessHash }),
    }));
    ingestUpdatesResult(result);
    return { ok: true };
  }
  if (ref.type === 'chat') {
    const result = await client.invoke(new Api.messages.DeleteChatUser({
      chatId: returnBigInt(ref.id),
      userId: new Api.InputUserSelf(),
      revokeHistory: false,
    }));
    ingestUpdatesResult(result);
    return { ok: true };
  }
  throw Object.assign(new Error('私聊会话不支持退出群组操作'), { code: 'TG_LEAVE_UNSUPPORTED' });
}

/**
 * 删除会话：
 * - 用户间私聊（user）：调用 messages.DeleteHistory，当 revoke 为 true 时双向删除（删除对方的聊天）；
 * - 基础群组（chat）：调用 messages.DeleteChatUser；
 * - 频道 / 超级群组（channel）：转入 leaveChat 退出频道。
 */
async function deleteChat(client: TelegramClient, ref: TgPeerRef, revoke = true): Promise<{ ok: true }> {
  if (ref.type === 'user') {
    const input = await resolveInputPeer(client, ref);
    const affected = await invokeWithGateway(
      client,
      new Api.messages.DeleteHistory({
        peer: input,
        maxId: 0,
        justClear: false,
        revoke,
      }),
      { peerKey: `user-${ref.id}`, state: engine?.state, advancePts: true },
    );
    ingestUpdatesResult(affected);
    return { ok: true };
  }
  if (ref.type === 'chat') {
    const result = await invokeWithGateway(
      client,
      new Api.messages.DeleteChatUser({
        chatId: returnBigInt(ref.id),
        userId: new Api.InputUserSelf(),
        revokeHistory: revoke,
      }),
      { peerKey: `chat-${ref.id}`, state: engine?.state, advancePts: true },
    );
    ingestUpdatesResult(result);
    return { ok: true };
  }
  if (ref.type === 'channel') {
    return leaveChat(client, ref);
  }
  throw Object.assign(new Error('不支持的会话类型'), { code: 'PEER_TYPE_UNSUPPORTED' });
}

function nextRandomId() {
  return returnBigInt(`${Date.now()}${String(Math.floor(Math.random() * 1000)).padStart(3, '0')}`);
}

function firstNewMessageOf(
  result: unknown,
  peerKey: string,
  text: string,
  replyToMsgId?: number,
  trace?: LocalTraceContext,
): TgMessageDto | null {
  if (result instanceof Api.Updates || result instanceof Api.UpdatesCombined) {
    ingestUpdatesResult(result, trace);
    for (const item of result.updates) {
      if (item instanceof Api.UpdateNewMessage || item instanceof Api.UpdateNewChannelMessage) {
        const dto = toMessage(item.message);
        if (dto) return dto;
      }
    }
    return null;
  }
  if (result instanceof Api.UpdateShortSentMessage) {
    // 关键修复：UpdateShortSentMessage 携带了本次发送消息分配的 pts 与 ptsCount，必须立即推进 engine.state.pts，
    // 否则机器人 200ms 后回复时 checkCommonPts 会因为本地 pts 少 1 而误判为 gap 触发全量重同步覆盖窗口！
    if (engine?.state) {
      advancePtsFromRpcResult(engine.state, result, trace, 'UpdateShortSentMessage');
    }
    const selfId = selfUserId();
    const dto: TgMessageDto = {
      id: result.id,
      peerKey,
      date: result.date,
      out: true,
      kind: 'message',
      senderKey: selfId ? `user-${selfId}` : undefined,
      senderName: '你',
      text,
      replyToId: replyToMsgId,
      replyTo: replyToMsgId ? { id: replyToMsgId } : undefined,
    };
    enqueue([{ type: 'newMessage', message: dto }]);
    return dto;
  }
  return null;
}

/** 发送文本消息（支持搜索群关键词输入、命令发送、回复指定消息）。 */
async function sendMessage(client: TelegramClient, ref: TgPeerRef, text: string, replyToMsgId?: number): Promise<TgMessageDto | null> {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const peerKey = `${ref.type}-${ref.id}`;
  const trace = startLocalTrace('chat.send', 'sendMessage', {
    peer: peerKey,
    textLen: trimmed.length,
    replyToMsgId,
  });
  try {
    const peer = await resolveInputPeer(client, ref);
    const result = await invokeWithGateway(
      client,
      new Api.messages.SendMessage({
        peer,
        message: trimmed,
        randomId: nextRandomId(),
        noWebpage: false,
        replyTo: replyToMsgId ? new Api.InputReplyToMessage({ replyToMsgId }) : undefined,
      }),
      { peerKey, state: engine?.state, advancePts: true, trace },
    );
    const dto = firstNewMessageOf(result, peerKey, trimmed, replyToMsgId, trace);
    trace.finishRoot({ msgId: dto?.id, pts: engine?.state?.pts }, 'INFO');
    return dto;
  } catch (err) {
    trace.finishRoot({ ok: false }, 'ERROR');
    throw err;
  }
}

/** 唤醒机器人并传递深链参数（messages.StartBot 或直接发送 /start）。 */
async function startBot(client: TelegramClient, botRef: TgPeerRef, startParam: string): Promise<TgMessageDto | null> {
  const param = startParam.trim();
  if (!param) return sendMessage(client, botRef, '/start');
  const peerKey = `user-${botRef.id}`;
  const trace = startLocalTrace('chat.send', 'startBot', { peer: peerKey, startParam: param });
  const peer = await resolveInputPeer(client, botRef);
  if (!(peer instanceof Api.InputPeerUser)) {
    return sendMessage(client, botRef, `/start ${param}`);
  }
  const bot = new Api.InputUser({ userId: peer.userId, accessHash: peer.accessHash });
  const result = await invokeWithGateway(
    client,
    new Api.messages.StartBot({
      bot,
      peer,
      randomId: nextRandomId(),
      startParam: param,
    }),
    { peerKey, state: engine?.state, advancePts: true, trace },
  );
  const dto = firstNewMessageOf(result, peerKey, `/start ${param}`, undefined, trace);
  trace.finishRoot({ msgId: dto?.id, pts: engine?.state?.pts }, 'INFO');
  return dto;
}

/** 点击消息下方的 Callback 内联按钮（messages.GetBotCallbackAnswer）。 */
async function pressBotCallback(client: TelegramClient, ref: TgPeerRef, messageId: number, data: string): Promise<TgCallbackAnswer> {
  const peerKey = `${ref.type}-${ref.id}`;
  const trace = startLocalTrace('bot.callback', 'pressBotCallback', {
    peer: peerKey,
    messageId,
  });
  const peer = await resolveInputPeer(client, ref);
  try {
    const result = await invokeWithGateway<Api.messages.BotCallbackAnswer>(
      client,
      new Api.messages.GetBotCallbackAnswer({
        peer,
        msgId: messageId,
        data: Buffer.from(data, 'base64'),
      }),
      { peerKey, trace },
    );
    trace.finishRoot({ hasMessage: Boolean(result.message), hasUrl: Boolean(result.url) }, 'INFO');
    return {
      message: result.message || undefined,
      alert: Boolean(result.alert) || undefined,
      url: result.url || undefined,
    };
  } catch (error) {
    // 关键修复：大量 Telegram 搜索机器人在收到翻页 Callback 后仅调用 editMessageText 更新消息与按钮，
    // 而不调用 answerCallbackQuery，导致 Telegram 服务端在 ~10s 后返回 BOT_RESPONSE_TIMEOUT。
    // 此类情形并非错误，必须优雅降级为正常空回调结果，避免中断自动翻页或弹出假性报错。
    const code = String(
      (error as { errorMessage?: string })?.errorMessage ??
        (error instanceof Error ? error.message : ''),
    ).toUpperCase();
    if (code.includes('BOT_RESPONSE_TIMEOUT') || code.includes('DATA_INVALID')) {
      trace.childSpan(
        'bot.callback',
        'callback_timeout_normalized',
        { peer: peerKey, messageId, code },
        'INFO',
      );
      trace.finishRoot({ normalizedTimeout: true }, 'INFO');
      return {};
    }
    trace.finishRoot({ ok: false, code }, 'ERROR');
    throw error;
  }
}

/** 提取合法的私有邀请哈希（支持 +hash 或 joinchat/hash）。 */
export function cleanInviteHash(raw: string): string | null {
  const trimmed = raw.trim()
    .replace(/^(?:https?:\/\/)?(?:t\.me|telegram\.me)\/(?:joinchat\/|\+)/i, '')
    .replace(/^tg:\/\/join\?invite=/i, '')
    .replace(/^\+/, '')
    .split(/[/?#&]/)[0]?.trim() ?? '';
  return /^[a-zA-Z0-9_-]{4,64}$/.test(trimmed) ? trimmed : null;
}

/** 检查私有邀请链接（messages.CheckChatInvite）。 */
async function checkChatInvite(client: TelegramClient, rawHash: string): Promise<TgInvitePreview> {
  const hash = cleanInviteHash(rawHash) ?? rawHash.trim();
  const result = await client.invoke(new Api.messages.CheckChatInvite({ hash }));
  if (result instanceof Api.ChatInviteAlready) {
    rememberEntities([], [result.chat]);
    const id = result.chat.id.toString();
    const isChannel = result.chat instanceof Api.Channel || result.chat instanceof Api.ChannelForbidden;
    const key = isChannel ? `channel-${id}` : `chat-${id}`;
    const dialog = toPeerDialog(key);
    return {
      hash,
      status: 'already',
      title: dialog?.title ?? '已加入的会话',
      participantsCount: dialog?.participantsCount,
      isChannel,
      peer: dialog?.peer,
      dialog,
    };
  }
  if (result instanceof Api.ChatInvitePeek) {
    rememberEntities([], [result.chat]);
    const id = result.chat.id.toString();
    const isChannel = result.chat instanceof Api.Channel || result.chat instanceof Api.ChannelForbidden;
    const key = isChannel ? `channel-${id}` : `chat-${id}`;
    const dialog = toPeerDialog(key);
    return {
      hash,
      status: 'peek',
      title: dialog?.title ?? '公开预览会话',
      participantsCount: dialog?.participantsCount,
      isChannel,
      peekExpiresAt: result.expires * 1000,
      peer: dialog?.peer,
      dialog,
    };
  }
  return {
    hash,
    status: 'invite',
    title: result.title || '私有群组 / 频道',
    about: result.about || undefined,
    participantsCount: result.participantsCount,
    isChannel: Boolean(result.channel || result.broadcast),
    joinRequest: Boolean(result.requestNeeded) || undefined,
  };
}

/** 通过私有邀请链接加入群组或频道（messages.ImportChatInvite）。 */
async function importChatInvite(client: TelegramClient, rawHash: string): Promise<TgJoinChatResult> {
  const hash = cleanInviteHash(rawHash) ?? rawHash.trim();
  try {
    const result = await client.invoke(new Api.messages.ImportChatInvite({ hash }));
    if ((result as { className?: string })?.className === 'messages.ChatInviteJoinResultWebView') {
      return { status: 'webview' };
    }
    ingestUpdatesResult(result);
    if (result instanceof Api.Updates || result instanceof Api.UpdatesCombined) {
      const chat = result.chats[0];
      if (chat) {
        const isChannel = chat instanceof Api.Channel || chat instanceof Api.ChannelForbidden;
        const key = isChannel ? `channel-${chat.id.toString()}` : `chat-${chat.id.toString()}`;
        return { status: 'joined', dialog: toPeerDialog(key) };
      }
    }
    return { status: 'joined' };
  } catch (error) {
    const code = String((error as { errorMessage?: string })?.errorMessage ?? (error instanceof Error ? error.message : '')).toUpperCase();
    if (code.includes('INVITE_REQUEST_SENT')) return { status: 'pending' };
    throw error;
  }
}

/**
 * 批量静默归档/取消归档（单次 EditPeerFolders 最多打包 100 个 InputFolderPeer）
 */
async function batchSetDialogsArchived(
  client: TelegramClient,
  refs: TgPeerRef[],
  archived: boolean,
): Promise<{ folderId: 0 | 1; count: number }> {
  const folderId: 0 | 1 = archived ? 1 : 0;
  let totalCount = 0;
  const CHUNK_SIZE = 100;

  for (let i = 0; i < refs.length; i += CHUNK_SIZE) {
    const chunk = refs.slice(i, i + CHUNK_SIZE);
    const folderPeers: Api.InputFolderPeer[] = [];
    for (const ref of chunk) {
      if (ref.type === 'user' && isSelfKey(`user-${ref.id}`)) continue;
      try {
        const peer = await resolveInputPeer(client, ref);
        folderPeers.push(new Api.InputFolderPeer({ peer, folderId }));
      } catch {
        // skip unresolvable peer
      }
    }
    if (folderPeers.length > 0) {
      const result = await client.invoke(new Api.folders.EditPeerFolders({ folderPeers }));
      ingestUpdatesResult(result);
      totalCount += folderPeers.length;
    }
  }

  return { folderId, count: totalCount };
}

/**
 * 批量巡检频道/超级群组状态与 access_hash（单次 channels.GetChannels 最多打包 100 个）
 */
async function batchCheckChannels(
  client: TelegramClient,
  channels: TgPeerRef[],
): Promise<{ dialogs: TgDialogDto[]; invalidKeys: TgPeerKey[] }> {
  const dialogs: TgDialogDto[] = [];
  const invalidKeys: TgPeerKey[] = [];
  const CHUNK_SIZE = 100;

  for (let i = 0; i < channels.length; i += CHUNK_SIZE) {
    const chunk = channels.slice(i, i + CHUNK_SIZE);
    const inputChannels: Api.InputChannel[] = [];
    const expectedKeys = new Set<TgPeerKey>();

    for (const ref of chunk) {
      if (ref.type !== 'channel') continue;
      const key: TgPeerKey = `channel-${ref.id}`;
      expectedKeys.add(key);
      const cached = peerInfo(key)?.ref.accessHash ?? ref.accessHash;
      if (!cached) {
        invalidKeys.push(key);
        continue;
      }
      inputChannels.push(
        new Api.InputChannel({
          channelId: returnBigInt(ref.id),
          accessHash: returnBigInt(cached),
        }),
      );
    }

    if (inputChannels.length === 0) continue;

    try {
      const res = await client.invoke(new Api.channels.GetChannels({ id: inputChannels }));
      rememberEntities([], res.chats);
      for (const chat of res.chats) {
        const key: TgPeerKey = `channel-${chat.id.toString()}`;
        if (chat instanceof Api.ChannelForbidden || (chat as { className?: string }).className === 'ChannelEmpty') {
          invalidKeys.push(key);
          continue;
        }
        const dto = toPeerDialog(key);
        if (dto) {
          dialogs.push(dto);
        }
      }
    } catch {
      for (const key of expectedKeys) {
        invalidKeys.push(key);
      }
    }
  }

  return { dialogs, invalidKeys };
}

function buildMessagesFilter(filter?: 'all' | 'video' | 'photo' | 'document' | 'music' | 'url'): Api.TypeMessagesFilter {
  switch (filter) {
    case 'video':
      return new Api.InputMessagesFilterVideo();
    case 'photo':
      return new Api.InputMessagesFilterPhotos();
    case 'document':
      return new Api.InputMessagesFilterDocument();
    case 'music':
      return new Api.InputMessagesFilterMusic();
    case 'url':
      return new Api.InputMessagesFilterUrl();
    default:
      return new Api.InputMessagesFilterEmpty();
  }
}

/** 统计一页搜索结果里可用的缩略图档位，用于判断「没有封面」是数据缺失还是下载失败。 */
function summarizeSearchThumbs(messages: TgMessageDto[]) {
  let photoCount = 0;
  let videoCount = 0;
  let fileCount = 0;
  let withStripped = 0;
  let withPreviewOnly = 0;
  let noThumbSource = 0;
  let noMedia = 0;

  for (const message of messages) {
    const media = message.media;
    if (!media) {
      noMedia += 1;
      continue;
    }
    if (media.photo) {
      photoCount += 1;
      if (media.photo.thumb) withStripped += 1;
      else if (media.photo.preview) withPreviewOnly += 1;
      else noThumbSource += 1;
    } else if (media.video) {
      videoCount += 1;
      if (media.video.cover?.thumb || media.video.thumb) withStripped += 1;
      else if (media.video.preview) withPreviewOnly += 1;
      else noThumbSource += 1;
    } else if (media.file) {
      fileCount += 1;
      if (media.file.thumb) withStripped += 1;
      else if (media.file.preview) withPreviewOnly += 1;
      else noThumbSource += 1;
    } else {
      noMedia += 1;
    }
  }

  return { photoCount, videoCount, fileCount, withStripped, withPreviewOnly, noThumbSource, noMedia };
}

/**
 * 服务端消息搜索（支持单会话 messages.Search 与全局 messages.SearchGlobal，下推 6 大过滤算子）
 */
async function searchMessages(
  client: TelegramClient,
  req: Extract<TgChatRequest, { method: 'searchMessages' }>,
): Promise<TgSearchMessagesPage> {
  const startedAt = Date.now();
  const mode = req.peer ? 'peer' : 'global';
  const limit = Math.max(1, Math.min(100, req.limit || 30));
  const baseTags = {
    mode,
    filter: req.filter ?? 'all',
    limit,
    qLen: (req.query ?? '').length,
    offsetId: req.offsetId ?? 0,
    offsetRate: req.offsetRate ?? 0,
    hasPeer: Boolean(req.peer),
  };

  emitLocalSpan({
    domain: 'chat.search',
    action: 'search_start',
    level: 'DEBUG',
    tags: baseTags,
  });

  try {
    const tlFilter = buildMessagesFilter(req.filter);

    let rawResult: Api.messages.TypeMessages;
    if (req.peer) {
      const inputPeer = await resolveInputPeer(client, req.peer);
      const fromId = req.fromPeer ? await resolveInputPeer(client, req.fromPeer) : undefined;
      rawResult = await client.invoke(
        new Api.messages.Search({
          peer: inputPeer,
          q: req.query || '',
          filter: tlFilter,
          minDate: req.minDate ?? 0,
          maxDate: req.maxDate ?? 0,
          offsetId: req.offsetId ?? 0,
          addOffset: 0,
          limit,
          maxId: 0,
          minId: 0,
          hash: returnBigInt(0),
          fromId,
          topMsgId: req.topMsgId,
        }),
      );
    } else {
      const offsetPeer = req.offsetPeer
        ? await resolveInputPeer(client, req.offsetPeer)
        : new Api.InputPeerEmpty();
      rawResult = await client.invoke(
        new Api.messages.SearchGlobal({
          q: req.query || '',
          filter: tlFilter,
          minDate: req.minDate ?? 0,
          maxDate: req.maxDate ?? 0,
          offsetRate: req.offsetRate ?? 0,
          offsetPeer,
          offsetId: req.offsetId ?? 0,
          limit,
        }),
      );
    }

    if (rawResult instanceof Api.messages.MessagesNotModified) {
      emitLocalSpan({
        domain: 'chat.search',
        action: 'search_ok',
        level: 'DEBUG',
        durMs: Date.now() - startedAt,
        tags: { ...baseTags, raw: 0, converted: 0, dialogs: 0, totalCount: 0, hasMore: false, notModified: true },
      });
      return { messages: [], dialogs: {}, totalCount: 0, hasMore: false };
    }

    rememberEntities(rawResult.users, rawResult.chats);
    const messages: TgMessageDto[] = [];
    const dialogs: Record<TgPeerKey, TgDialogDto> = {};
    let skippedServiceCount = 0;

    for (const rawMsg of rawResult.messages) {
      const dto = toMessage(rawMsg);
      if (dto && dto.kind === 'message') {
        messages.push(dto);
        if (!dialogs[dto.peerKey]) {
          const peerDto = toPeerDialog(dto.peerKey);
          if (peerDto) {
            dialogs[dto.peerKey] = peerDto;
          }
        }
      } else {
        skippedServiceCount += 1;
      }
    }

    const totalCount = 'count' in rawResult && typeof rawResult.count === 'number'
      ? rawResult.count
      : messages.length;
    const nextRate = 'nextRate' in rawResult && typeof rawResult.nextRate === 'number'
      ? rawResult.nextRate
      : undefined;
    const lastMsg = messages[messages.length - 1];
    const nextOffsetId = lastMsg?.id;
    const nextOffsetPeer = lastMsg ? dialogs[lastMsg.peerKey]?.peer : undefined;
    const hasMore = messages.length >= limit;

    emitLocalSpan({
      domain: 'chat.search',
      action: 'search_ok',
      level: 'INFO',
      durMs: Date.now() - startedAt,
      tags: {
        ...baseTags,
        raw: rawResult.messages.length,
        converted: messages.length,
        skippedServiceCount,
        dialogs: Object.keys(dialogs).length,
        totalCount,
        hasMore,
        nextOffsetId: nextOffsetId ?? 0,
        nextRate: nextRate ?? 0,
        nextHasPeer: Boolean(nextOffsetPeer),
        ...summarizeSearchThumbs(messages),
      },
    });

    return {
      messages,
      dialogs,
      totalCount,
      nextRate,
      nextOffsetId,
      nextOffsetPeer,
      hasMore,
    };
  } catch (error) {
    const info = classifyTelegramError(error);
    emitLocalSpan({
      domain: 'chat.search',
      action: 'search_error',
      level: 'ERROR',
      durMs: Date.now() - startedAt,
      message: info.description,
      tags: {
        ...baseTags,
        bucket: info.bucket,
        code: info.code,
        retryable: info.retryable,
      },
    });
    throw error;
  }
}

/**
 * 0 流量秒级换壳转存至共享私密保险库群（messages.ForwardMessages）
 */
async function forwardToVault(
  client: TelegramClient,
  req: Extract<TgChatRequest, { method: 'forwardToVault' }>,
): Promise<{ ok: true; forwardedMsgIds: number[] }> {
  const fromPeer = await resolveInputPeer(client, req.fromPeer);
  const toPeer = await resolveInputPeer(client, req.toPeer);
  const randomIds = req.messageIds.map(() => nextRandomId());

  const result = await client.invoke(
    new Api.messages.ForwardMessages({
      fromPeer,
      toPeer,
      id: req.messageIds,
      randomId: randomIds,
      dropAuthor: req.dropAuthor !== false,
      topMsgId: req.topMsgId,
    }),
  );

  ingestUpdatesResult(result);
  const forwardedMsgIds: number[] = [];
  if (result instanceof Api.Updates || result instanceof Api.UpdatesCombined) {
    for (const u of result.updates) {
      if (u instanceof Api.UpdateNewMessage || u instanceof Api.UpdateNewChannelMessage) {
        forwardedMsgIds.push(u.message.id);
      }
    }
  }
  return { ok: true, forwardedMsgIds };
}

/**
 * 针对 noforwards 媒体的 Worker 内 2MB 环形缓冲区云端克隆至共享保险库群
 */
async function cloneNoForwardsToVault(
  client: TelegramClient,
  req: Extract<TgChatRequest, { method: 'cloneNoForwardsToVault' }>,
): Promise<{ ok: true; message: TgMessageDto | null }> {
  const fromPeer = await resolveInputPeer(client, req.fromPeer);
  const toPeer = await resolveInputPeer(client, req.toPeer);

  const history = await client.invoke(
    new Api.messages.GetHistory({
      peer: fromPeer,
      offsetId: req.messageId + 1,
      offsetDate: 0,
      addOffset: 0,
      limit: 1,
      maxId: req.messageId + 1,
      minId: req.messageId - 1,
      hash: returnBigInt(0),
    }),
  );

  if (history instanceof Api.messages.MessagesNotModified || !history.messages.length) {
    throw new Error('未能定位需要克隆的源消息');
  }
  rememberEntities(history.users, history.chats);
  const srcMsg = history.messages[0];
  if (!(srcMsg instanceof Api.Message) || !srcMsg.media) {
    throw new Error('源消息不包含可克隆的媒体内容');
  }

  // 使用 GramJS 内置流式缓冲下载后通过 sendFile 上传到保险库指定 Topic
  const buffer = await client.downloadMedia(srcMsg, {});
  if (!buffer) {
    throw new Error('从源会话读取防转发媒体流失败');
  }

  const rawBuf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer as string);
  const uploaded = await client.uploadFile({
    file: new CustomFile(`vault-${req.messageId}.bin`, rawBuf.byteLength, '', rawBuf),
    workers: 1,
  });

  let inputMedia: Api.TypeInputMedia;
  if (srcMsg.media instanceof Api.MessageMediaPhoto) {
    inputMedia = new Api.InputMediaUploadedPhoto({ file: uploaded });
  } else if (srcMsg.media instanceof Api.MessageMediaDocument && srcMsg.media.document instanceof Api.Document) {
    inputMedia = new Api.InputMediaUploadedDocument({
      file: uploaded,
      mimeType: srcMsg.media.document.mimeType || 'application/octet-stream',
      attributes: srcMsg.media.document.attributes,
    });
  } else {
    throw new Error('暂不支持该媒体类型的防转发重传');
  }

  const sent = await client.invoke(
    new Api.messages.SendMedia({
      peer: toPeer,
      media: inputMedia,
      message: req.caption ?? srcMsg.message ?? '',
      randomId: nextRandomId(),
      replyTo: req.topMsgId ? new Api.InputReplyToMessage({ replyToMsgId: req.topMsgId }) : undefined,
    }),
  );

  const msgDto = firstNewMessageOf(
    sent,
    `${req.toPeer.type}-${req.toPeer.id}`,
    req.caption ?? srcMsg.message ?? '',
    req.topMsgId,
  );
  return { ok: true, message: msgDto };
}

/**
 * 创建或校验共享私密保险库超级群及其 5 个标准 Forum Topics
 */
async function ensureVaultForumTopics(
  client: TelegramClient,
  req: Extract<TgChatRequest, { method: 'ensureVaultForumTopics' }>,
): Promise<TgVaultTopicsInfo> {
  let vaultPeerRef = req.vaultPeer;
  let vaultTitle = req.title?.trim() || 'Lattice 跨账号私密归档保险库';

  if (!vaultPeerRef) {
    const created = await client.invoke(
      new Api.channels.CreateChannel({
        title: vaultTitle,
        about: 'Lattice Archive v2 多账号共享私密归档与凭据信标保险库',
        megagroup: true,
        forum: true,
      }),
    );
    ingestUpdatesResult(created);
    if (created instanceof Api.Updates || created instanceof Api.UpdatesCombined) {
      const ch = created.chats.find((c): c is Api.Channel => c instanceof Api.Channel);
      if (ch) {
        vaultPeerRef = {
          type: 'channel',
          id: ch.id.toString(),
          accessHash: ch.accessHash?.toString(),
        };
        vaultTitle = ch.title || vaultTitle;
      }
    }
  }

  if (!vaultPeerRef) {
    throw new Error('创建共享私密保险库超级群失败');
  }

  const inputPeer = await resolveInputPeer(client, vaultPeerRef);
  if (!(inputPeer instanceof Api.InputPeerChannel)) {
    throw new Error('共享保险库必须是超级群组 (Channel)');
  }
  const inputChannel = new Api.InputChannel({
    channelId: inputPeer.channelId,
    accessHash: inputPeer.accessHash,
  });

  // 确保开启 Forum 模式
  try {
    await client.invoke(
      new Api.channels.ToggleForum({
        channel: inputChannel,
        enabled: true,
      }),
    );
  } catch {
    // 若已开启 Forum 则忽略 CHANNEL_FORUM_MISSING / CHAT_NOT_MODIFIED
  }

  const standardTopics: { key: keyof TgVaultTopicsInfo['topics']; title: string }[] = [
    { key: 'video', title: '🎬 视频归档卷' },
    { key: 'photo', title: '🖼️ 图集原图卷' },
    { key: 'document', title: '📦 冷备文档卷' },
    { key: 'beacon', title: '📡 跨设备凭据信标卷' },
    { key: 'manifest', title: '🗂️ 归档索引清单卷' },
  ];

  const topicsMap: TgVaultTopicsInfo['topics'] = {
    video: 1,
    photo: 1,
    document: 1,
    beacon: 1,
    manifest: 1,
  };

  for (const item of standardTopics) {
    try {
      const topicRes = await client.invoke(
        new Api.channels.CreateForumTopic({
          channel: inputChannel,
          title: item.title,
          randomId: nextRandomId(),
        }),
      );
      ingestUpdatesResult(topicRes);
      if (topicRes instanceof Api.Updates || topicRes instanceof Api.UpdatesCombined) {
        for (const u of topicRes.updates) {
          if (u instanceof Api.UpdateNewChannelMessage) {
            topicsMap[item.key] = u.message.id;
            break;
          }
        }
      }
    } catch {
      // fallback topic ID 1
    }
  }

  return {
    vaultPeer: vaultPeerRef,
    vaultPeerKey: `channel-${vaultPeerRef.id}`,
    vaultTitle,
    topics: topicsMap,
  };
}

/**
 * 扫描共享私密保险库群的「📡 跨设备凭据信标卷」，提取当前账号专属的新鲜 access_hash
 */
async function syncBeaconCredentials(
  client: TelegramClient,
  req: Extract<TgChatRequest, { method: 'syncBeaconCredentials' }>,
): Promise<{ syncedDialogs: TgDialogDto[] }> {
  const inputPeer = await resolveInputPeer(client, req.vaultPeer);
  const res = await client.invoke(
    new Api.messages.GetHistory({
      peer: inputPeer,
      offsetId: 0,
      offsetDate: 0,
      addOffset: 0,
      limit: Math.min(100, req.limit || 50),
      maxId: 0,
      minId: 0,
      hash: returnBigInt(0),
    }),
  );

  if (res instanceof Api.messages.MessagesNotModified) {
    return { syncedDialogs: [] };
  }

  rememberEntities(res.users, res.chats);
  const syncedDialogs: TgDialogDto[] = [];
  for (const chat of res.chats) {
    const isChannel = chat instanceof Api.Channel || chat instanceof Api.ChannelForbidden;
    const key: TgPeerKey = isChannel ? `channel-${chat.id.toString()}` : `chat-${chat.id.toString()}`;
    if (key === `channel-${req.vaultPeer.id}`) continue;
    const dto = toPeerDialog(key);
    if (dto) {
      syncedDialogs.push(dto);
    }
  }

  return { syncedDialogs };
}

/**
 * 账号健康探针与自动续期（GetAuthorizations + GetState + SetAccountTTL + SetAuthorizationTTL）
 */
async function probeAccountHealth(
  client: TelegramClient,
  ensureTtlDays = 365,
): Promise<TgAccountHealthReport> {
  let accountTtlDays = ensureTtlDays;
  const authorizationTtlDays = ensureTtlDays;

  if (ensureTtlDays >= 365) {
    try {
      await client.invoke(
        new Api.account.SetAccountTTL({
          ttl: new Api.AccountDaysTTL({ days: 365 }),
        }),
      );
      await client.invoke(
        new Api.account.SetAuthorizationTTL({
          authorizationTtlDays: 365,
        }),
      );
    } catch {
      // ignore if restricted by <24h probation
    }
  }

  try {
    const ttlRes = await client.invoke(new Api.account.GetAccountTTL());
    accountTtlDays = ttlRes.days;
  } catch {
    // ignore
  }

  let activeSessionsCount = 1;
  let currentSessionCreatedAt: number | undefined;
  let currentSessionOfficial = false;

  try {
    const auths = await client.invoke(new Api.account.GetAuthorizations());
    activeSessionsCount = auths.authorizations.length;
    const current = auths.authorizations.find((a) => a.current);
    if (current) {
      currentSessionCreatedAt = current.dateCreated * 1000;
      currentSessionOfficial = Boolean(current.officialApp);
    }
  } catch {
    // ignore if <24h probation blocks GetAuthorizations
  }

  const stateRes = await client.invoke(new Api.updates.GetState());
  return {
    ok: true,
    accountId: selfUserId() || '',
    dcId: client.session.dcId,
    activeSessionsCount,
    currentSessionCreatedAt,
    currentSessionOfficial,
    accountTtlDays,
    authorizationTtlDays,
    pts: stateRes.pts,
    date: stateRes.date,
  };
}

/**
 * Worker 内环回接力派生预备槽位（ExportLoginToken <-> AcceptLoginToken + ChangeAuthorizationSettings）
 * 严格遵循架构规范 §3.2 的 6 步全自动环回接力链。
 */
async function spawnPendingSlot(
  motherClient: TelegramClient,
  req: Extract<TgChatRequest, { method: 'spawnPendingSlot' }>,
): Promise<TgSpawnedSlotResult> {
  const fp = req.deviceFingerprint;
  const childSession = new StringSession('');
  const childClient = new TelegramClient(childSession, req.apiId, req.apiHash, {
    connectionRetries: 2,
    useWSS: true,
    deviceModel: fp.deviceModel || 'Desktop',
    systemVersion: fp.systemVersion || 'Mac OS X',
    appVersion: fp.appVersion || '5.12.3',
    langCode: fp.langCode || 'zh-hans',
    systemLangCode: fp.systemLangCode || 'zh-CN',
  });

  try {
    await childClient.connect();

    // Step 1: Child 申请二维码登录令牌
    const exportRes = await childClient.invoke(
      new Api.auth.ExportLoginToken({
        apiId: req.apiId,
        apiHash: req.apiHash,
        exceptIds: [],
      }),
    );

    if (!(exportRes instanceof Api.auth.LoginToken)) {
      throw new Error('申请预备槽位登录令牌失败');
    }

    // Step 2: Mother 内部秒级代签 AcceptLoginToken
    const authorization = await motherClient.invoke(
      new Api.auth.AcceptLoginToken({
        token: exportRes.token,
      }),
    );

    // Step 3: Child 再次调用 ExportLoginToken 完成确认（处理跨 DC 迁移与 2FA）
    let confirmRes: Api.auth.TypeLoginToken;
    try {
      confirmRes = await childClient.invoke(
        new Api.auth.ExportLoginToken({
          apiId: req.apiId,
          apiHash: req.apiHash,
          exceptIds: [],
        }),
      );
    } catch (err) {
      const code = String((err as { errorMessage?: string })?.errorMessage ?? '');
      if (code.includes('SESSION_PASSWORD_NEEDED')) {
        if (!req.twoFaPassword) {
          throw new Error('该账号开启了两步验证密码 (2FA)，请输入两步验证密码以派生预备槽位');
        }
        const pwdInfo = await childClient.invoke(new Api.account.GetPassword());
        const srpCheck = await computeCheck(pwdInfo, req.twoFaPassword);
        await childClient.invoke(new Api.auth.CheckPassword({ password: srpCheck }));
        confirmRes = new Api.auth.LoginTokenSuccess({
          authorization: new Api.auth.Authorization({
            user: new Api.UserEmpty({ id: returnBigInt(0) }),
          }),
        });
      } else {
        throw err;
      }
    }

    if (confirmRes instanceof Api.auth.LoginTokenMigrateTo) {
      await childClient._switchDC(confirmRes.dcId);
      await childClient.invoke(
        new Api.auth.ImportLoginToken({
          token: confirmRes.token,
        }),
      );
    }

    // Step 5: Mother 立即确认新设备（消除 Unconfirmed 状态）
    let confirmedOfficial = false;
    if (authorization instanceof Api.Authorization && authorization.hash) {
      try {
        await motherClient.invoke(
          new Api.account.ChangeAuthorizationSettings({
            hash: authorization.hash,
            confirmed: true,
          }),
        );
        confirmedOfficial = true;
      } catch {
        // best-effort confirmation
      }
    }

    const savedSession = (childClient.session as StringSession).save();
    const dcId = childClient.session.dcId;
    return {
      ok: true,
      session: savedSession,
      confirmedOfficial,
      dcId,
      createdAtMs: Date.now(),
    };
  } finally {
    try {
      await childClient.disconnect();
    } catch {
      // ignore disconnect error
    }
  }
}
