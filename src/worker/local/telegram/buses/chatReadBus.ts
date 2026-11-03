/**
 * ============================================================================
 * B2 ChatReadBus · 会话列表、历史分页、上下文与公共更新补差
 * ============================================================================
 * 只在 local Worker 内运行，由 BusRouter 经 RequestScheduler 调度后调用；
 * 输入输出均为 contracts/buses.ts 定义的 DTO，不向上游暴露 Api.* 类型。
 */
import type { TelegramClient } from 'telegram';
import { Api } from 'telegram/tl';
import { returnBigInt } from 'telegram/Helpers';
import type { TgChatUpdate, TgDialogCursor, TgDialogDto, TgDialogPage, TgHistoryPage, TgPeerKey, TgPeerRef, TgSyncResult, TgUpdatesState } from '../../chatProtocol';
import { indexMessages, peerInfo, peerKeyOf, rememberEntities, toDialog, toMessage } from '../converters/converters';
import { emitLocalSpan } from '../telemetry/localSpans';
import { resolveInputPeer } from '../runtime/transportKernel';
import { adoptState, chatDebug, convertUpdate, isChatDebugEnabled, toState } from '../runtime/updateEngine';
import { classifyTelegramError } from '../../chat/telegramErrors';

/** 差异分片最多连续拉取的次数；超过即视为差异过大，交给调用方重建。 */
const MAX_DIFFERENCE_SLICES = 8;

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
export async function getDialogs(client: TelegramClient, folderId: 0 | 1, cursor: TgDialogCursor | undefined, limit: number): Promise<TgDialogPage> {
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
export async function getHistory(client: TelegramClient, ref: TgPeerRef, offsetId: number, limit: number): Promise<TgHistoryPage> {
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
export async function getHistoryAround(client: TelegramClient, ref: TgPeerRef, messageId: number, limit: number): Promise<TgHistoryPage> {
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
    if (isChatDebugEnabled()) {
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
export async function syncFrom(client: TelegramClient, from: TgUpdatesState | null): Promise<TgSyncResult> {
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
