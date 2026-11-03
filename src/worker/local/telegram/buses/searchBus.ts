/**
 * ============================================================================
 * B3 SearchBus · 单会话 messages.Search 与全局 messages.SearchGlobal
 * ============================================================================
 * 只在 local Worker 内运行，由 BusRouter 经 RequestScheduler 调度后调用；
 * 输入输出均为 contracts/buses.ts 定义的 DTO，不向上游暴露 Api.* 类型。
 */
import type { TelegramClient } from 'telegram';
import { Api } from 'telegram/tl';
import { returnBigInt } from 'telegram/Helpers';
import type { TgDialogDto, TgMessageDto, TgPeerKey, TgSearchMessagesPage } from '../../chatProtocol';
import type { SearchMessagesInput } from '../contracts/buses';
import { rememberEntities, toMessage, toPeerDialog } from '../converters/converters';
import { emitLocalSpan } from '../telemetry/localSpans';
import { resolveInputPeer } from '../runtime/transportKernel';
import { classifyTelegramError } from '../../chat/telegramErrors';

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
export async function searchMessages(
  client: TelegramClient,
  req: SearchMessagesInput,
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
