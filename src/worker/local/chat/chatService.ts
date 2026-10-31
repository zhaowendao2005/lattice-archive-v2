/**
 * 本地 Worker 内的只读聊天服务：
 * - 会话列表 / 历史分页 / 公共更新补差三类 RPC；
 * - 单实例实时更新引擎：把 GramJS Raw updates 转为 DTO 批量广播，并跟踪公共 pts 发现缺口。
 * 只持有内存态，不落盘；持久缓存由主线程 chat 域负责。
 */
import { Buffer } from 'buffer';
import type { TelegramClient } from 'telegram';
import { Api } from 'telegram/tl';
import { returnBigInt } from 'telegram/Helpers';
import { UpdateConnectionState } from 'telegram/network';
import type {
  TgCallbackAnswer, TgChatRequest, TgChatUpdate, TgDialogCursor, TgDialogDto, TgDialogPage,
  TgHistoryPage, TgInvitePreview, TgJoinChatResult, TgMessageDto, TgPeerRef, TgSyncResult, TgUpdatesState,
} from '../chatProtocol';
import { indexMessages, isSelfKey, peerInfo, peerKeyOf, rememberEntities, resetPeerCache, selfUserId, toDialog, toMessage, toPeerDialog, toShortMessage } from './converters';

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

/** 将主动变更 RPC（归档、加入、退出）返回的 Updates 合并进实体缓存与实时更新流。 */
function ingestUpdatesResult(result: unknown) {
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
  if (engine.state.pts + ptsCount === pts) { engine.state.pts = pts; return 'apply'; }
  if (pts <= engine.state.pts) return 'skip';
  engine.state.pts = pts;
  return 'gap';
}

/** GramJS 原始更新入口：先处理连接状态，再转 DTO 并入队 */
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
  const accessHash = ref.accessHash ?? peerInfo(`${ref.type}-${ref.id}`)?.ref.accessHash;
  if (accessHash !== undefined) {
    return ref.type === 'user'
      ? new Api.InputPeerUser({ userId: returnBigInt(ref.id), accessHash: returnBigInt(accessHash) })
      : new Api.InputPeerChannel({ channelId: returnBigInt(ref.id), accessHash: returnBigInt(accessHash) });
  }
  const peer = ref.type === 'user' ? new Api.PeerUser({ userId: returnBigInt(ref.id) }) : new Api.PeerChannel({ channelId: returnBigInt(ref.id) });
  return client.getInputEntity(peer);
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
  const safeLimit = Math.max(10, limit);
  const half = Math.floor(safeLimit / 2);
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
  return { messages, hasOlder };
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

export async function runChatRequest(
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
  return importChatInvite(client, request.hash);
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
    await client.invoke(new Api.messages.DeleteHistory({
      peer: input,
      maxId: 0,
      justClear: false,
      revoke,
    }));
    return { ok: true };
  }
  if (ref.type === 'chat') {
    const result = await client.invoke(new Api.messages.DeleteChatUser({
      chatId: returnBigInt(ref.id),
      userId: new Api.InputUserSelf(),
      revokeHistory: revoke,
    }));
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

function firstNewMessageOf(result: unknown, peerKey: string, text: string, replyToMsgId?: number): TgMessageDto | null {
  if (result instanceof Api.Updates || result instanceof Api.UpdatesCombined) {
    ingestUpdatesResult(result);
    for (const item of result.updates) {
      if (item instanceof Api.UpdateNewMessage || item instanceof Api.UpdateNewChannelMessage) {
        const dto = toMessage(item.message);
        if (dto) return dto;
      }
    }
    return null;
  }
  if (result instanceof Api.UpdateShortSentMessage) {
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
  const peer = await resolveInputPeer(client, ref);
  const result = await client.invoke(new Api.messages.SendMessage({
    peer,
    message: trimmed,
    randomId: nextRandomId(),
    noWebpage: false,
    replyTo: replyToMsgId ? new Api.InputReplyToMessage({ replyToMsgId }) : undefined,
  }));
  return firstNewMessageOf(result, `${ref.type}-${ref.id}`, trimmed, replyToMsgId);
}

/** 唤醒机器人并传递深链参数（messages.StartBot 或直接发送 /start）。 */
async function startBot(client: TelegramClient, botRef: TgPeerRef, startParam: string): Promise<TgMessageDto | null> {
  const param = startParam.trim();
  if (!param) return sendMessage(client, botRef, '/start');
  const peer = await resolveInputPeer(client, botRef);
  if (!(peer instanceof Api.InputPeerUser)) {
    return sendMessage(client, botRef, `/start ${param}`);
  }
  const bot = new Api.InputUser({ userId: peer.userId, accessHash: peer.accessHash });
  const result = await client.invoke(new Api.messages.StartBot({
    bot,
    peer,
    randomId: nextRandomId(),
    startParam: param,
  }));
  return firstNewMessageOf(result, `user-${botRef.id}`, `/start ${param}`);
}

/** 点击消息下方的 Callback 内联按钮（messages.GetBotCallbackAnswer）。 */
async function pressBotCallback(client: TelegramClient, ref: TgPeerRef, messageId: number, data: string): Promise<TgCallbackAnswer> {
  const peer = await resolveInputPeer(client, ref);
  const result = await client.invoke(new Api.messages.GetBotCallbackAnswer({
    peer,
    msgId: messageId,
    data: Buffer.from(data, 'base64'),
  }));
  return {
    message: result.message || undefined,
    alert: Boolean(result.alert) || undefined,
    url: result.url || undefined,
  };
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
