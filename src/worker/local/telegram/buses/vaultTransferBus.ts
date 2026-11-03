/**
 * ============================================================================
 * B9 VaultTransferBus · 转存、noforwards 中继、Forum Topic 与 Beacon 凭据同步（后台低优先级）
 * ============================================================================
 * 只在 local Worker 内运行，由 BusRouter 经 RequestScheduler 调度后调用；
 * 输入输出均为 contracts/buses.ts 定义的 DTO，不向上游暴露 Api.* 类型。
 */
import { Buffer } from 'buffer';
import type { TelegramClient } from 'telegram';
import { CustomFile } from 'telegram/client/uploads';
import { Api } from 'telegram/tl';
import { returnBigInt } from 'telegram/Helpers';
import type { TgDialogDto, TgMessageDto, TgPeerKey, TgVaultTopicsInfo } from '../../chatProtocol';
import type { ForwardToVaultInput, CloneNoForwardsInput, EnsureVaultTopicsInput, SyncBeaconInput } from '../contracts/buses';
import { rememberEntities, toPeerDialog } from '../converters/converters';
import { resolveInputPeer } from '../runtime/transportKernel';
import { ingestUpdatesResult, firstNewMessageOf, nextRandomId } from '../runtime/updateEngine';

/**
 * 0 流量秒级换壳转存至共享私密保险库群（messages.ForwardMessages）
 */
export async function forwardToVault(
  client: TelegramClient,
  req: ForwardToVaultInput,
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
export async function cloneNoForwardsToVault(
  client: TelegramClient,
  req: CloneNoForwardsInput,
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
export async function ensureVaultForumTopics(
  client: TelegramClient,
  req: EnsureVaultTopicsInput,
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
export async function syncBeaconCredentials(
  client: TelegramClient,
  req: SyncBeaconInput,
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
