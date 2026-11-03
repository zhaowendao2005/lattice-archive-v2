/**
 * ============================================================================
 * B7 ChatCommandBus · 归档、加入、退出、删除、发送、邀请处理（全部为 interactive 写操作）
 * ============================================================================
 * 只在 local Worker 内运行，由 BusRouter 经 RequestScheduler 调度后调用；
 * 输入输出均为 contracts/buses.ts 定义的 DTO，不向上游暴露 Api.* 类型。
 */
import type { TelegramClient } from 'telegram';
import { Api } from 'telegram/tl';
import { returnBigInt } from 'telegram/Helpers';
import type { TgDialogDto, TgInvitePreview, TgJoinChatResult, TgMessageDto, TgPeerKey, TgPeerRef } from '../../chatProtocol';
import { isSelfKey, peerInfo, peerKeyOf, rememberEntities, toPeerDialog } from '../converters/converters';
import { startLocalTrace } from '../telemetry/localSpans';
import { invokeWithGateway, resolveInputPeer } from '../runtime/transportKernel';
import { ingestUpdatesResult, currentEngineState, firstNewMessageOf, nextRandomId } from '../runtime/updateEngine';

/** 阶段 8：通过 folders.EditPeerFolders 归档或取消归档会话。 */
export async function setDialogArchived(client: TelegramClient, ref: TgPeerRef, archived: boolean): Promise<{ folderId: 0 | 1 }> {
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

export async function resolveUsername(client: TelegramClient, raw: string): Promise<TgDialogDto | null> {
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
export async function joinChat(client: TelegramClient, ref: TgPeerRef): Promise<TgJoinChatResult> {
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
export async function leaveChat(client: TelegramClient, ref: TgPeerRef): Promise<{ ok: true }> {
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
export async function deleteChat(client: TelegramClient, ref: TgPeerRef, revoke = true): Promise<{ ok: true }> {
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
      { peerKey: `user-${ref.id}`, state: currentEngineState(), advancePts: true },
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
      { peerKey: `chat-${ref.id}`, state: currentEngineState(), advancePts: true },
    );
    ingestUpdatesResult(result);
    return { ok: true };
  }
  if (ref.type === 'channel') {
    return leaveChat(client, ref);
  }
  throw Object.assign(new Error('不支持的会话类型'), { code: 'PEER_TYPE_UNSUPPORTED' });
}

/** 发送文本消息（支持搜索群关键词输入、命令发送、回复指定消息）。 */
export async function sendMessage(client: TelegramClient, ref: TgPeerRef, text: string, replyToMsgId?: number): Promise<TgMessageDto | null> {
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
      { peerKey, state: currentEngineState(), advancePts: true, trace },
    );
    const dto = firstNewMessageOf(result, peerKey, trimmed, replyToMsgId, trace);
    trace.finishRoot({ msgId: dto?.id, pts: currentEngineState()?.pts }, 'INFO');
    return dto;
  } catch (err) {
    trace.finishRoot({ ok: false }, 'ERROR');
    throw err;
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
export async function checkChatInvite(client: TelegramClient, rawHash: string): Promise<TgInvitePreview> {
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
export async function importChatInvite(client: TelegramClient, rawHash: string): Promise<TgJoinChatResult> {
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
export async function batchSetDialogsArchived(
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
export async function batchCheckChannels(
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
