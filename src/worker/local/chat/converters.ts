/**
 * TL 对象 → 纯数据 DTO 的转换层。
 * 只做结构映射与中文标签，不发起任何网络请求；名称缓存仅驻留在 Worker 内存中。
 */
import { Api } from 'telegram/tl';
import { strippedPhotoToJpg } from 'telegram/Utils';
import type { TgChatKind, TgDialogDto, TgMessageDto, TgMessageMedia, TgPeerKey, TgPeerRef, TgPhotoInfo, TgPhotoSize, TgVideoInfo, TgVideoQuality } from '../chatProtocol';

type ChatEntity = Api.Chat | Api.ChatForbidden | Api.ChatEmpty | Api.Channel | Api.ChannelForbidden;
type AnyEntity = Api.TypeUser | Api.TypeChat;

interface PeerInfo { ref: TgPeerRef; kind: TgChatKind; title: string }

/** 实体名称 / 引用缓存：会话、历史、更新与差异结果都会写入，用于给缺少实体的更新补全发送者。 */
const peers = new Map<TgPeerKey, PeerInfo>();
let selfKey: TgPeerKey | undefined;

export function resetPeerCache(selfId?: string) {
  peers.clear();
  selfKey = selfId ? `user-${selfId}` : undefined;
}

export function peerKeyOf(peer: Api.TypePeer): TgPeerKey {
  if (peer instanceof Api.PeerUser) return `user-${peer.userId.toString()}`;
  if (peer instanceof Api.PeerChat) return `chat-${peer.chatId.toString()}`;
  return `channel-${(peer as Api.PeerChannel).channelId.toString()}`;
}

export function peerInfo(key: TgPeerKey): PeerInfo | undefined { return peers.get(key); }
export function isSelfKey(key: TgPeerKey) { return key === selfKey; }

function userTitle(user: Api.User) {
  if (user.self) return '收藏夹';
  if (user.deleted) return '已注销账户';
  const name = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();
  return name || (user.username ? `@${user.username}` : user.phone ? `+${user.phone}` : '未知用户');
}

function rememberEntity(entity: AnyEntity) {
  if (entity instanceof Api.User) {
    const id = entity.id.toString();
    const previous = peers.get(`user-${id}`);
    // min 用户不带 access_hash，不能覆盖已经拿到的完整引用。
    const accessHash = entity.accessHash && !entity.min ? entity.accessHash.toString() : previous?.ref.accessHash;
    peers.set(`user-${id}`, {
      ref: { type: 'user', id, accessHash },
      kind: entity.self ? 'self' : entity.bot ? 'bot' : 'user',
      title: userTitle(entity),
    });
    if (entity.self) selfKey = `user-${id}`;
    return;
  }
  if (entity instanceof Api.UserEmpty) return;
  const chat = entity as ChatEntity;
  const id = chat.id.toString();
  if (chat instanceof Api.Channel || chat instanceof Api.ChannelForbidden) {
    const previous = peers.get(`channel-${id}`);
    const accessHash = chat.accessHash && !(chat instanceof Api.Channel && chat.min) ? chat.accessHash.toString() : previous?.ref.accessHash;
    const broadcast = chat instanceof Api.Channel ? Boolean(chat.broadcast) : Boolean(chat.broadcast);
    peers.set(`channel-${id}`, { ref: { type: 'channel', id, accessHash }, kind: broadcast ? 'channel' : 'supergroup', title: chat.title || '未命名频道' });
    return;
  }
  const title = chat instanceof Api.ChatEmpty ? '已删除的群组' : chat.title || '未命名群组';
  peers.set(`chat-${id}`, { ref: { type: 'chat', id }, kind: 'group', title });
}

export function rememberEntities(users: AnyEntity[] = [], chats: AnyEntity[] = []) {
  for (const entity of users) rememberEntity(entity);
  for (const entity of chats) rememberEntity(entity);
}

function plural(count: number, unit: string) { return `${count} ${unit}`; }

/** 气泡预览档位上限：800px 档（x）在 2x 屏上覆盖约 400px 宽的气泡，不必为占位下载原图。 */
const PREVIEW_MAX_SIDE = 800;

function photoSizeOf(size: Api.TypePhotoSize): TgPhotoSize | undefined {
  if (size instanceof Api.PhotoSize) return { type: size.type, width: size.w, height: size.h, bytes: size.size };
  if (size instanceof Api.PhotoSizeProgressive) return { type: size.type, width: size.w, height: size.h, bytes: Math.max(0, ...size.sizes) };
  if (size instanceof Api.PhotoCachedSize) return { type: size.type, width: size.w, height: size.h, bytes: size.bytes.length };
  return undefined;
}

function strippedThumbOf(sizes: Api.TypePhotoSize[]): string | undefined {
  const stripped = sizes.find((size): size is Api.PhotoStrippedSize => size instanceof Api.PhotoStrippedSize);
  if (!stripped || stripped.bytes.length < 3) return undefined;
  try { return `data:image/jpeg;base64,${strippedPhotoToJpg(stripped.bytes).toString('base64')}`; } catch { return undefined; }
}

/** 限时（阅后即焚）照片不提供下载信息：只读归档不应持久化这类内容。 */
function photoInfoOf(media: Api.MessageMediaPhoto): TgPhotoInfo | undefined {
  if (media.ttlSeconds) return undefined;
  return photoInfoFrom(media.photo, media.spoiler);
}

function photoInfoFrom(photo: Api.TypePhoto | undefined, spoiler?: boolean): TgPhotoInfo | undefined {
  if (!(photo instanceof Api.Photo)) return undefined;
  const sizes = photo.sizes.map(photoSizeOf).filter((size): size is TgPhotoSize => Boolean(size)).sort((a, b) => a.width * a.height - b.width * b.height);
  const full = sizes[sizes.length - 1];
  if (!full) return undefined;
  const preview = [...sizes].reverse().find((size) => Math.max(size.width, size.height) <= PREVIEW_MAX_SIDE);
  return {
    id: photo.id.toString(),
    accessHash: photo.accessHash.toString(),
    fileReference: photo.fileReference.toString('base64'),
    dcId: photo.dcId,
    width: full.width,
    height: full.height,
    thumb: strippedThumbOf(photo.sizes),
    preview: preview && preview.type !== full.type ? preview : undefined,
    full,
    spoiler: spoiler || undefined,
  };
}

/** 浏览器有机会直接播放的视频容器；其余格式（mkv / avi 等）只按普通文件展示。 */
const PLAYABLE_VIDEO_MIME = new Set(['video/mp4', 'video/quicktime', 'video/webm']);
const STORYBOARD_MIME = 'application/x-tgstoryboard';

function toNumber(value: { toJSNumber?: () => number } | number | undefined): number {
  if (typeof value === 'number') return value;
  return value?.toJSNumber ? value.toJSNumber() : Number(value ?? 0);
}

export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = String(total % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${secs}` : `${minutes}:${secs}`;
}

function videoAttributeOf(document: Api.Document) {
  return document.attributes.find((item): item is Api.DocumentAttributeVideo => item instanceof Api.DocumentAttributeVideo);
}

function qualityOf(document: Api.Document, original?: true): TgVideoQuality | undefined {
  const attribute = videoAttributeOf(document);
  if (!attribute || !document.mimeType.startsWith('video/')) return undefined;
  return {
    id: document.id.toString(),
    accessHash: document.accessHash.toString(),
    fileReference: document.fileReference.toString('base64'),
    dcId: document.dcId,
    width: attribute.w,
    height: attribute.h,
    size: toNumber(document.size),
    mimeType: document.mimeType,
    codec: attribute.videoCodec || undefined,
    original,
  };
}

/** 文档缩略图档位：取不超过 800px 的最大 PhotoSize（视频文档通常只有 m 档）。 */
function documentPreviewOf(document: Api.Document): TgPhotoSize | undefined {
  const sizes = (document.thumbs ?? []).map(photoSizeOf).filter((size): size is TgPhotoSize => Boolean(size) && size!.width > 0);
  return sizes.sort((a, b) => b.width * b.height - a.width * a.height).find((size) => Math.max(size.width, size.height) <= PREVIEW_MAX_SIDE);
}

/**
 * 视频文档 → TgVideoInfo。
 * - 有 DocumentAttributeVideo 且 MIME 为 video/*：消息视频（含 GIF / 圆形视频）；
 * - 否则若 MIME 属于可播放容器：以文件方式发送的视频（asFile）。
 */
function videoInfoOf(media: Api.MessageMediaDocument, document: Api.Document): TgVideoInfo | undefined {
  const original = qualityOf(document, true);
  const attribute = videoAttributeOf(document);
  const asFile = !original;
  if (asFile && !PLAYABLE_VIDEO_MIME.has(document.mimeType)) return undefined;
  const alternatives = (media.altDocuments ?? [])
    .filter((item): item is Api.Document => item instanceof Api.Document && item.mimeType !== STORYBOARD_MIME)
    .map((item) => qualityOf(item))
    .filter((item): item is TgVideoQuality => Boolean(item) && item!.id !== document.id.toString());
  const self: TgVideoQuality = original ?? {
    id: document.id.toString(),
    accessHash: document.accessHash.toString(),
    fileReference: document.fileReference.toString('base64'),
    dcId: document.dcId,
    width: attribute?.w ?? 0,
    height: attribute?.h ?? 0,
    size: toNumber(document.size),
    mimeType: document.mimeType,
    original: true,
  };
  const qualities = [self, ...alternatives].sort((a, b) => b.height - a.height || b.size - a.size);
  const fileName = (document.attributes.find((item) => item instanceof Api.DocumentAttributeFilename) as Api.DocumentAttributeFilename | undefined)?.fileName;
  return {
    id: self.id,
    accessHash: self.accessHash,
    fileReference: self.fileReference,
    dcId: self.dcId,
    mimeType: document.mimeType,
    size: self.size,
    duration: attribute?.duration ?? 0,
    width: self.width,
    height: self.height,
    supportsStreaming: Boolean(attribute?.supportsStreaming),
    noSound: Boolean(attribute?.nosound),
    codec: self.codec,
    fileName,
    thumb: strippedThumbOf(document.thumbs ?? []),
    preview: documentPreviewOf(document),
    cover: photoInfoFrom(media.videoCover),
    spoiler: media.spoiler || undefined,
    asFile: asFile || undefined,
    qualities: asFile ? [self] : qualities,
    startAt: media.videoTimestamp || undefined,
  };
}

function withDuration(label: string, video: TgVideoInfo | undefined) {
  return video && video.duration > 0 ? `${label} · ${formatDuration(video.duration)}` : label;
}

function mediaOf(media: Api.TypeMessageMedia | undefined): TgMessageMedia | undefined {
  if (!media || media instanceof Api.MessageMediaEmpty || media instanceof Api.MessageMediaWebPage) return undefined;
  if (media instanceof Api.MessageMediaPhoto) {
    if (media.ttlSeconds) return { kind: 'photo', label: '限时图片' };
    return { kind: 'photo', label: '图片', photo: photoInfoOf(media) };
  }
  if (media instanceof Api.MessageMediaDocument) {
    const document = media.document instanceof Api.Document ? media.document : undefined;
    // 已过期的限时视频 / 语音：document 为空，只保留类型标签。
    if (!document) return media.round ? { kind: 'round', label: '视频消息（已过期）' } : media.voice ? { kind: 'voice', label: '语音消息（已过期）' } : { kind: 'file', label: '文件已不可用' };
    const attributes = document.attributes;
    const video = videoAttributeOf(document);
    const audio = attributes.find((item) => item instanceof Api.DocumentAttributeAudio) as Api.DocumentAttributeAudio | undefined;
    const sticker = attributes.find((item) => item instanceof Api.DocumentAttributeSticker) as Api.DocumentAttributeSticker | undefined;
    const fileName = (attributes.find((item) => item instanceof Api.DocumentAttributeFilename) as Api.DocumentAttributeFilename | undefined)?.fileName;
    const animated = attributes.some((item) => item instanceof Api.DocumentAttributeAnimated);
    if (sticker) return { kind: 'sticker', label: sticker.alt ? `贴纸 ${sticker.alt}` : '贴纸' };
    // 限时视频不提供下载信息，与限时图片一致。
    const info = media.ttlSeconds ? undefined : videoInfoOf(media, document);
    if (animated) return { kind: 'gif', label: 'GIF', video: info && !info.asFile ? info : undefined };
    if (video?.roundMessage) return { kind: 'round', label: withDuration(media.ttlSeconds ? '限时视频消息' : '视频消息', info), video: info };
    if (video && document.mimeType.startsWith('video/')) return { kind: 'video', label: withDuration(media.ttlSeconds ? '限时视频' : '视频', info), video: info };
    if (audio?.voice) return { kind: 'voice', label: '语音消息' };
    if (audio) return { kind: 'audio', label: audio.title ? `音频 · ${audio.title}` : '音频' };
    return { kind: 'file', label: fileName ? `文件 · ${fileName}` : '文件', video: info?.asFile ? info : undefined };
  }
  if (media instanceof Api.MessageMediaGeo || media instanceof Api.MessageMediaGeoLive || media instanceof Api.MessageMediaVenue) return { kind: 'location', label: '位置' };
  if (media instanceof Api.MessageMediaContact) return { kind: 'contact', label: '联系人' };
  if (media instanceof Api.MessageMediaPoll) {
    const question = media.poll.question instanceof Api.TextWithEntities ? media.poll.question.text : '';
    return { kind: 'poll', label: question ? `投票 · ${question}` : '投票' };
  }
  if (media instanceof Api.MessageMediaDice) return { kind: 'other', label: media.emoticon || '骰子' };
  if (media instanceof Api.MessageMediaGame) return { kind: 'other', label: '游戏' };
  if (media instanceof Api.MessageMediaInvoice) return { kind: 'other', label: '账单' };
  if (media instanceof Api.MessageMediaStory) return { kind: 'other', label: '动态' };
  return { kind: 'other', label: '暂不支持的消息类型' };
}

function nameOf(key: TgPeerKey | undefined, fallback = '某人') {
  if (!key) return fallback;
  if (key === selfKey) return '你';
  return peers.get(key)?.title ?? fallback;
}

function userNames(ids: { toString(): string }[]) { return ids.map((id) => nameOf(`user-${id.toString()}`)).join('、'); }

function serviceText(action: Api.TypeMessageAction, actor: string, out: boolean): string {
  if (action instanceof Api.MessageActionChatCreate) return `${actor} 创建了群组「${action.title}」`;
  if (action instanceof Api.MessageActionChannelCreate) return `频道「${action.title}」已创建`;
  if (action instanceof Api.MessageActionChatEditTitle) return `${actor} 将名称修改为「${action.title}」`;
  if (action instanceof Api.MessageActionChatEditPhoto) return `${actor} 更新了头像`;
  if (action instanceof Api.MessageActionChatDeletePhoto) return `${actor} 移除了头像`;
  if (action instanceof Api.MessageActionChatAddUser) {
    const names = userNames(action.users);
    return names === actor ? `${actor} 加入了群组` : `${actor} 邀请了 ${names}`;
  }
  if (action instanceof Api.MessageActionChatDeleteUser) {
    const name = nameOf(`user-${action.userId.toString()}`);
    return name === actor ? `${actor} 离开了群组` : `${actor} 移出了 ${name}`;
  }
  if (action instanceof Api.MessageActionChatJoinedByLink || action instanceof Api.MessageActionChatJoinedByRequest) return `${actor} 通过邀请链接加入了群组`;
  if (action instanceof Api.MessageActionPinMessage) return `${actor} 置顶了一条消息`;
  if (action instanceof Api.MessageActionHistoryClear) return '聊天记录已清空';
  if (action instanceof Api.MessageActionChatMigrateTo || action instanceof Api.MessageActionChannelMigrateFrom) return '群组已升级为超级群组';
  if (action instanceof Api.MessageActionPhoneCall) {
    const kind = action.video ? '视频通话' : '语音通话';
    const duration = action.duration ? ` · ${plural(Math.max(1, Math.round(action.duration / 60)), '分钟')}` : '';
    return `${out ? '呼出' : '呼入'}${kind}${duration}`;
  }
  if (action instanceof Api.MessageActionGroupCall) return action.duration ? '群语音聊天已结束' : `${actor} 发起了群语音聊天`;
  if (action instanceof Api.MessageActionScreenshotTaken) return `${actor} 截取了屏幕`;
  if (action instanceof Api.MessageActionContactSignUp) return `${actor} 加入了 Telegram`;
  if (action instanceof Api.MessageActionSetMessagesTTL) return action.period ? `${actor} 开启了消息自动删除` : `${actor} 关闭了消息自动删除`;
  if (action instanceof Api.MessageActionTopicCreate) return `${actor} 创建了话题「${action.title}」`;
  if (action instanceof Api.MessageActionTopicEdit) return `${actor} 修改了话题`;
  return '系统消息';
}

/** senderKey：群组用 fromId；私聊入站消息没有 fromId，发送者就是对端；出站为本人。 */
function senderKeyOf(message: Api.Message | Api.MessageService, peerKey: TgPeerKey): TgPeerKey | undefined {
  if (message.fromId) return peerKeyOf(message.fromId);
  if (message.out) return selfKey;
  return peerKey;
}

export function toMessage(message: Api.TypeMessage | undefined): TgMessageDto | undefined {
  if (!message || message instanceof Api.MessageEmpty) return undefined;
  const peerKey = peerKeyOf(message.peerId);
  const senderKey = senderKeyOf(message, peerKey);
  const senderName = nameOf(senderKey, peers.get(peerKey)?.title ?? '某人');
  const base = { id: message.id, peerKey, date: message.date ?? 0, out: Boolean(message.out), senderKey, senderName };
  if (message instanceof Api.MessageService) {
    return { ...base, kind: 'service', text: serviceText(message.action, senderName, Boolean(message.out)) };
  }
  const replyToId = message.replyTo instanceof Api.MessageReplyHeader ? message.replyTo.replyToMsgId : undefined;
  const fwd = message.fwdFrom;
  const forwardedFrom = fwd ? (fwd.fromName ?? (fwd.fromId ? nameOf(peerKeyOf(fwd.fromId), '未知来源') : '未知来源')) : undefined;
  return {
    ...base,
    kind: 'message',
    text: message.message ?? '',
    media: mediaOf(message.media),
    editDate: message.editDate && !message.editHide ? message.editDate : undefined,
    replyToId,
    groupedId: message.groupedId ? message.groupedId.toString() : undefined,
    forwardedFrom,
    views: message.views,
  };
}

/** UpdateShortMessage / UpdateShortChatMessage 不携带完整 Message，按字段手工组装。 */
export function toShortMessage(update: Api.UpdateShortMessage | Api.UpdateShortChatMessage): TgMessageDto {
  const isPrivate = update instanceof Api.UpdateShortMessage;
  const peerKey = isPrivate ? `user-${update.userId.toString()}` : `chat-${update.chatId.toString()}`;
  const senderKey = update.out ? selfKey : isPrivate ? peerKey : `user-${update.fromId.toString()}`;
  const fwd = update.fwdFrom;
  return {
    id: update.id,
    peerKey,
    date: update.date,
    out: Boolean(update.out),
    kind: 'message',
    senderKey,
    senderName: nameOf(senderKey),
    text: update.message ?? '',
    replyToId: update.replyTo instanceof Api.MessageReplyHeader ? update.replyTo.replyToMsgId : undefined,
    forwardedFrom: fwd ? (fwd.fromName ?? (fwd.fromId ? nameOf(peerKeyOf(fwd.fromId), '未知来源') : '未知来源')) : undefined,
  };
}

export function toDialog(dialog: Api.Dialog, messages: Map<string, TgMessageDto>, defaultFolderId: 0 | 1 = 0): TgDialogDto | undefined {
  const key = peerKeyOf(dialog.peer);
  const info = peers.get(key);
  if (!info) return undefined;
  const lastMessage = messages.get(`${key}:${dialog.topMessage}`);
  const muteUntil = dialog.notifySettings instanceof Api.PeerNotifySettings ? dialog.notifySettings.muteUntil ?? 0 : 0;
  return {
    key,
    peer: info.ref,
    kind: info.kind,
    title: info.title,
    pinned: Boolean(dialog.pinned),
    folderId: dialog.folderId === 1 || defaultFolderId === 1 ? 1 : 0,
    muted: muteUntil > Math.floor(Date.now() / 1000),
    unreadCount: dialog.unreadCount,
    unreadMentions: dialog.unreadMentionsCount,
    unreadMark: Boolean(dialog.unreadMark),
    readInboxMaxId: dialog.readInboxMaxId,
    readOutboxMaxId: dialog.readOutboxMaxId,
    topMessageId: dialog.topMessage,
    date: lastMessage?.date ?? 0,
    lastMessage,
  };
}

/** 消息列表按「peer:id」索引，供会话结果查找 top message。 */
export function indexMessages(list: Api.TypeMessage[]) {
  const map = new Map<string, TgMessageDto>();
  for (const item of list) {
    const message = toMessage(item);
    if (message) map.set(`${message.peerKey}:${message.id}`, message);
  }
  return map;
}
