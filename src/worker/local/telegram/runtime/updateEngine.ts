/**
 * ============================================================================
 * Runtime Kernel · 实时更新引擎与公共 pts 状态机
 * ============================================================================
 * - 单实例：同一时刻只服务前台 P0 账号，把 GramJS Raw updates 转为 DTO 批量广播（40ms 合并窗口）；
 * - 公共 pts 只由本引擎与 TransportKernel 推进；写操作返回的 Updates / UpdateShortSentMessage 必须经 ingestUpdatesResult；
 * - 只持有内存态，不落盘；持久缓存由主线程 chat 域负责。
 */
import type { TelegramClient } from 'telegram';
import { Api } from 'telegram/tl';
import { returnBigInt } from 'telegram/Helpers';
import { UpdateConnectionState } from 'telegram/network';
import type { TgChatUpdate, TgMessageDto, TgUpdatesState } from '../../chatProtocol';
import { peerInfo, peerKeyOf, rememberEntities, resetPeerCache, selfUserId, toMessage, toShortMessage } from '../converters/converters';
import { emitLocalSpan, configureLocalSpans, type LocalDebugEmitter, type LocalTraceContext } from '../telemetry/localSpans';
import { advancePtsFromRpcResult } from './transportKernel';

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
/** ChatReadBus 补差时决定是否输出详细调试字段。 */
export function isChatDebugEnabled() { return debugEnabled; }

export function setChatDebug(enabled: boolean, emitter?: LocalDebugEmitter) {
  debugEnabled = enabled;
  configureLocalSpans({ enabled, emitter });
}

export function chatDebug(stage: string, detail: Record<string, unknown>) {
  if (debugEnabled) {
    emitLocalSpan({
      domain: 'chat.service',
      action: stage,
      level: 'DEBUG',
      tags: detail as Record<string, string | number | boolean | undefined>,
    });
  }
}

export function toState(state: Api.updates.State): TgUpdatesState {
  return { pts: state.pts, qts: state.qts, date: state.date, seq: state.seq };
}

/** 多个标签页可能以不同旧状态补差，引擎只接受更新的 pts，防止回退。 */
export function adoptState(state: TgUpdatesState) {
  if (!engine) return;
  if (!engine.state || state.pts >= engine.state.pts) engine.state = { ...state };
}

/** 把 DTO 更新压入队列，并用 40ms 定时器合并成一批发出 */
export function enqueue(updates: TgChatUpdate[]) {
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
export function convertUpdate(update: Api.TypeUpdate | Api.TypeUpdates): TgChatUpdate[] {
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
export function ingestUpdatesResult(result: unknown, trace?: LocalTraceContext) {
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

export function nextRandomId() {
  return returnBigInt(`${Date.now()}${String(Math.floor(Math.random() * 1000)).padStart(3, '0')}`);
}

export function firstNewMessageOf(
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

/** 当前引擎跟踪的公共更新状态（写操作推进 pts 用）；引擎未启动时为 null。 */
export function currentEngineState(): TgUpdatesState | null {
  return engine?.state ?? null;
}
