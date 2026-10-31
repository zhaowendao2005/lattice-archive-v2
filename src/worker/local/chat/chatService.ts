/**
 * 本地 Worker 内的只读聊天服务：
 * - 会话列表 / 历史分页 / 公共更新补差三类 RPC；
 * - 单实例实时更新引擎：把 GramJS Raw updates 转为 DTO 批量广播，并跟踪公共 pts 发现缺口。
 * 只持有内存态，不落盘；持久缓存由主线程 chat 域负责。
 */
import type { TelegramClient } from 'telegram';
import { Api } from 'telegram/tl';
import { returnBigInt } from 'telegram/Helpers';
import { UpdateConnectionState } from 'telegram/network';
import type { TgChatRequest, TgChatUpdate, TgDialogCursor, TgDialogDto, TgDialogPage, TgHistoryPage, TgPeerRef, TgSyncResult, TgUpdatesState } from '../chatProtocol';
import { indexMessages, isSelfKey, peerInfo, peerKeyOf, rememberEntities, resetPeerCache, toDialog, toMessage, toShortMessage } from './converters';

type ConnectionReporter = (state: 'online' | 'reconnecting', message?: string) => void;
type UpdatesEmitter = (accountId: string, updates: TgChatUpdate[], state?: TgUpdatesState) => void;

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
const FLUSH_DELAY_MS = 40;

/** 只有公共消息盒的更新参与 pts 连续性校验；频道更新各自维护 pts，不在此列。 */
const COMMON_PTS_UPDATES = [
  Api.UpdateNewMessage, Api.UpdateEditMessage, Api.UpdateDeleteMessages, Api.UpdateReadHistoryInbox,
  Api.UpdateReadHistoryOutbox, Api.UpdateReadMessagesContents, Api.UpdateWebPage, Api.UpdatePinnedMessages,
  Api.UpdateFolderPeers, Api.UpdateShortMessage, Api.UpdateShortChatMessage,
];

let engine: Engine | null = null;

/** 调试开关跟随 Worker init 的 debug 标志；只输出计数与阶段，不输出消息内容。 */
let debugEnabled = false;
export function setChatDebug(enabled: boolean) { debugEnabled = enabled; }
function chatDebug(stage: string, detail: Record<string, unknown>) { if (debugEnabled) console.info(`[lattice-tg] ${stage}`, detail); }

function toState(state: Api.updates.State): TgUpdatesState {
  return { pts: state.pts, qts: state.qts, date: state.date, seq: state.seq };
}

/** 多个标签页可能以不同旧状态补差，引擎只接受更新的 pts，防止回退。 */
function adoptState(state: TgUpdatesState) {
  if (!engine) return;
  if (!engine.state || state.pts >= engine.state.pts) engine.state = { ...state };
}

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
  if (update instanceof Api.UpdateDialogPinned || update instanceof Api.UpdatePinnedDialogs || update instanceof Api.UpdateFolderPeers || update instanceof Api.UpdateDialogUnreadMark) return [{ type: 'dialogsChanged' }];
  return [];
}

function checkCommonPts(update: unknown): 'apply' | 'skip' | 'gap' {
  if (!engine?.state || !COMMON_PTS_UPDATES.some((type) => update instanceof type)) return 'apply';
  const { pts, ptsCount } = update as { pts: number; ptsCount: number };
  if (engine.state.pts + ptsCount === pts) { engine.state.pts = pts; return 'apply'; }
  if (pts <= engine.state.pts) return 'skip';
  engine.state.pts = pts;
  return 'gap';
}

function handleRawUpdate(update: unknown) {
  if (!engine) return;
  if (update instanceof UpdateConnectionState) {
    if (update.state === UpdateConnectionState.connected) {
      if (!engine.disconnected) return;
      engine.disconnected = false;
      engine.reportConnection('online');
      // 断线期间可能漏掉更新，由各标签页按自身状态补差。
      enqueue([{ type: 'gap' }]);
      return;
    }
    engine.disconnected = true;
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

export function stopChatEngine() {
  if (engine?.flushTimer) clearTimeout(engine.flushTimer);
  engine = null;
}

export function isChatEngineHealthy(accountId: string): boolean {
  return Boolean(engine && engine.accountId === accountId && !engine.disconnected && engine.client.connected);
}

export async function resolveInputPeer(client: TelegramClient, ref: TgPeerRef): Promise<Api.TypeInputPeer> {
  if (ref.type === 'user' && isSelfKey(`user-${ref.id}`)) return new Api.InputPeerSelf();
  if (ref.type === 'chat') return new Api.InputPeerChat({ chatId: returnBigInt(ref.id) });
  const accessHash = ref.accessHash ?? peerInfo(`${ref.type}-${ref.id}`)?.ref.accessHash;
  if (accessHash !== undefined) {
    return ref.type === 'user'
      ? new Api.InputPeerUser({ userId: returnBigInt(ref.id), accessHash: returnBigInt(accessHash) })
      : new Api.InputPeerChannel({ channelId: returnBigInt(ref.id), accessHash: returnBigInt(accessHash) });
  }
  const peer = ref.type === 'user' ? new Api.PeerUser({ userId: returnBigInt(ref.id) }) : new Api.PeerChannel({ channelId: returnBigInt(ref.id) });
  return client.getInputEntity(peer);
}

function dialogsOf(list: Api.TypeDialog[], messages: Parameters<typeof toDialog>[1], folderId: 0 | 1): TgDialogDto[] {
  return list.flatMap((item) => {
    if (!(item instanceof Api.Dialog)) return [];
    const dialog = toDialog(item, messages, folderId);
    return dialog ? [dialog] : [];
  });
}

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

export async function runChatRequest(client: TelegramClient, request: Exclude<TgChatRequest, { method: 'getPhoto' | 'getDocumentThumb' | 'getDocument' }>): Promise<unknown> {
  if (request.method === 'getDialogs') return getDialogs(client, request.folderId ?? 0, request.cursor, request.limit);
  if (request.method === 'getHistory') return getHistory(client, request.peer, request.offsetId, request.limit);
  return syncFrom(client, request.state);
}
