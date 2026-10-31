/**
 * aspect bytes / 名称缓存条目的类型（只是为了给 peers Map 一个可读的类型名）
 */
/**
 * TL 对象 → 纯数据 DTO 的转换层。
 * 只做结构映射与中文标签，不发起任何网络请求；名称缓存仅驻留在 Worker 内存中。
 */
import { Api } from 'telegram/tl';
import { strippedPhotoToJpg } from 'telegram/Utils';
import type {
  TgAvatarInfo, TgChatKind, TgDialogDto, TgInlineButton, TgMessageDto, TgMessageEntity, TgMessageMedia,
  TgPeerKey, TgPeerRef, TgPhotoInfo, TgPhotoSize, TgReplyInfo, TgVideoInfo, TgVideoQuality, TgWebPagePreview,
} from '../chatProtocol';

type ChatEntity = Api.Chat | Api.ChatForbidden | Api.ChatEmpty | Api.Channel | Api.ChannelForbidden;
type AnyEntity = Api.TypeUser | Api.TypeChat;

/** 实体（用户 / 群 / 频道）展平后的展示信息，会被 peers 缓存复用 */
export interface PeerInfo {
  ref: TgPeerRef;
  kind: TgChatKind;
  title: string;
  avatar?: TgAvatarInfo;
  username?: string;
  participantsCount?: number;
  left?: boolean;
  kicked?: boolean;
  creator?: boolean;
  joinRequest?: boolean;
}

/** 实体名称 / 引用缓存：会话、历史、更新与差异结果都会写入，用于给缺少实体的更新补全发送者。 */
const peers = new Map<TgPeerKey, PeerInfo>();
let selfKey: TgPeerKey | undefined;

/** 切换账户时清空缓存；selfId 用于标记「我」自己（收藏夹与出站消息的发送者） */
export function resetPeerCache(selfId?: string) {
  peers.clear();
  selfKey = selfId ? `user-${selfId}` : undefined;
}

/** peer → 会话主键，形如 user-123 / chat-456 / channel-789（与路由参数一致） */
export function peerKeyOf(peer: Api.TypePeer): TgPeerKey {
  if (peer instanceof Api.PeerUser) return `user-${peer.userId.toString()}`;
  if (peer instanceof Api.PeerChat) return `chat-${peer.chatId.toString()}`;
  return `channel-${(peer as Api.PeerChannel).channelId.toString()}`;
}

export function peerInfo(key: TgPeerKey): PeerInfo | undefined { return peers.get(key); }
export function isSelfKey(key: TgPeerKey) { return key === selfKey; }
export function selfUserId(): string | undefined { return selfKey?.slice('user-'.length); }

/** 把 strippedThumb（极小的渐进式 JPEG 字节）转成 data URL，作为模糊占位图 */
function strippedBytesToDataUrl(bytes: Uint8Array | undefined): string | undefined {
  if (!bytes || bytes.length < 3) return undefined;
  try { return `data:image/jpeg;base64,${strippedPhotoToJpg(bytes as never).toString('base64')}`; } catch { return undefined; }
}

/** 头像定位信息（photoId + dcId + 极小缩略图），真正的大图由 mediaService 按需下载 */
function avatarInfoOf(photo: Api.TypeUserProfilePhoto | Api.TypeChatPhoto | undefined): TgAvatarInfo | undefined {
  if (!(photo instanceof Api.UserProfilePhoto) && !(photo instanceof Api.ChatPhoto)) return undefined;
  return {
    photoId: photo.photoId.toString(),
    dcId: photo.dcId,
    thumb: strippedBytesToDataUrl(photo.strippedThumb),
  };
}

/** 用户显示的标题：自己 → 收藏夹；已注销 → 已注销账户；否则 名+姓 / @username / 手机号 */
function userTitle(user: Api.User) {
  if (user.self) return '收藏夹';
  if (user.deleted) return '已注销账户';
  const name = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();
  return name || (user.username ? `@${user.username}` : user.phone ? `+${user.phone}` : '未知用户');
}

/**
 * 把单个实体写入缓存。
 * 难点：min 实体（精简版）不带 access_hash，而后续所有 RPC 都需要它，
 * 因此决不能用 min 实体覆盖已拿到的完整信息（ Especially 头像 / 用户名 / 成员数）。
 */
function rememberEntity(entity: AnyEntity) {
  if (entity instanceof Api.User) {
    const id = entity.id.toString();
    const previous = peers.get(`user-${id}`);
    // min 用户不带 access_hash，不能覆盖已经拿到的完整引用。
    const accessHash = entity.accessHash && !entity.min ? entity.accessHash.toString() : previous?.ref.accessHash;
    const avatar = entity.self ? undefined : (avatarInfoOf(entity.photo) ?? (entity.min ? previous?.avatar : undefined));
    peers.set(`user-${id}`, {
      ref: { type: 'user', id, accessHash },
      kind: entity.self ? 'self' : entity.bot ? 'bot' : 'user',
      title: userTitle(entity),
      avatar,
      username: entity.username || previous?.username,
    });
    if (entity.self) selfKey = `user-${id}`;
    return;
  }
  if (entity instanceof Api.UserEmpty) return;
  const chat = entity as ChatEntity;
  const id = chat.id.toString();
  if (chat instanceof Api.Channel || chat instanceof Api.ChannelForbidden) {
    const previous = peers.get(`channel-${id}`);
    const isMin = chat instanceof Api.Channel && Boolean(chat.min);
    const accessHash = chat.accessHash && !isMin ? chat.accessHash.toString() : previous?.ref.accessHash;
    const broadcast = Boolean(chat.broadcast);
    const isForbidden = chat instanceof Api.ChannelForbidden;
    peers.set(`channel-${id}`, {
      ref: { type: 'channel', id, accessHash },
      kind: broadcast ? 'channel' : 'supergroup',
      title: chat.title || '未命名频道',
      avatar: chat instanceof Api.Channel ? (avatarInfoOf(chat.photo) ?? (isMin ? previous?.avatar : undefined)) : previous?.avatar,
      username: chat instanceof Api.Channel ? (chat.username || previous?.username) : previous?.username,
      participantsCount: chat instanceof Api.Channel && chat.participantsCount !== undefined ? chat.participantsCount : previous?.participantsCount,
      left: isForbidden ? true : chat instanceof Api.Channel ? (isMin && previous?.left !== undefined ? previous.left : Boolean(chat.left)) : false,
      kicked: isForbidden,
      creator: chat instanceof Api.Channel ? (isMin ? previous?.creator : Boolean(chat.creator)) : false,
      joinRequest: chat instanceof Api.Channel ? (Boolean(chat.joinRequest) || undefined) : undefined,
    });
    return;
  }
  const previous = peers.get(`chat-${id}`);
  const isForbidden = chat instanceof Api.ChatForbidden || chat instanceof Api.ChatEmpty || Boolean(chat.deactivated);
  const title = chat instanceof Api.ChatEmpty ? '已删除的群组' : chat.title || '未命名群组';
  peers.set(`chat-${id}`, {
    ref: { type: 'chat', id },
    kind: 'group',
    title,
    avatar: chat instanceof Api.Chat ? avatarInfoOf(chat.photo) : previous?.avatar,
    participantsCount: chat instanceof Api.Chat ? chat.participantsCount : previous?.participantsCount,
    left: isForbidden ? true : chat instanceof Api.Chat ? Boolean(chat.left) : false,
    kicked: isForbidden,
    creator: chat instanceof Api.Chat ? Boolean(chat.creator) : false,
  });
}

/** 批量写入实体缓存（Users / Chats 两个数组） */
export function rememberEntities(users: AnyEntity[] = [], chats: AnyEntity[] = []) {
  for (const entity of users) rememberEntity(entity);
  for (const entity of chats) rememberEntity(entity);
}

function plural(count: number, unit: string) { return `${count} ${unit}`; }

/** 气泡预览档位上限：800px 档（x）在 2x 屏上覆盖约 400px 宽的气泡，不必为占位下载原图。 */
const PREVIEW_MAX_SIDE = 800;

/** Telegram 的 PhotoSize → 统一档位（含渐进式尺寸与内联缓存尺寸） */
function photoSizeOf(size: Api.TypePhotoSize): TgPhotoSize | undefined {
  if (size instanceof Api.PhotoSize) return { type: size.type, width: size.w, height: size.h, bytes: size.size };
  if (size instanceof Api.PhotoSizeProgressive) return { type: size.type, width: size.w, height: size.h, bytes: Math.max(0, ...size.sizes) };
  if (size instanceof Api.PhotoCachedSize) return { type: size.type, width: size.w, height: size.h, bytes: size.bytes.length };
  return undefined;
}

/** 找出 PhotoStrippedSize 并转成占位图 data URL */
function strippedThumbOf(sizes: Api.TypePhotoSize[]): string | undefined {
  const stripped = sizes.find((size): size is Api.PhotoStrippedSize => size instanceof Api.PhotoStrippedSize);
  return strippedBytesToDataUrl(stripped?.bytes);
}

/** 限时（阅后即焚）照片不提供下载信息：只读归档不应持久化这类内容。 */
function photoInfoOf(media: Api.MessageMediaPhoto): TgPhotoInfo | undefined {
  if (media.ttlSeconds) return undefined;
  return photoInfoFrom(media.photo, media.spoiler);
}

/** 从 Photo 对象构造完整的照片信息（档位排序、预览选档、占位图） */
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

/**
 * Telegram 的 long 字段可能是 BigInteger 也可能是 number，统一转 JS number（视频体积在 4GB 内安全）。
 */
function toNumber(value: { toJSNumber?: () => number } | number | undefined): number {
  if (typeof value === 'number') return value;
  return value?.toJSNumber ? value.toJSNumber() : Number(value ?? 0);
}

/** 秒数格式化成 m:ss 或 h:mm:ss（用于视频时长标签） */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = String(total % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${secs}` : `${minutes}:${secs}`;
}

/** 取 DocumentAttributeVideo（是否包含视频元信息） */
function videoAttributeOf(document: Api.Document) {
  return document.attributes.find((item): item is Api.DocumentAttributeVideo => item instanceof Api.DocumentAttributeVideo);
}

/** 把一个 Document 转成一个可播放画质版本；非视频则返回 undefined */
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

/** 消息媒体 → 统一媒体描述。这层只做「分类 + 取元信息」，不下载任何字节。 */
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

/** 取 peer 的显示名称；缺实体时退到「某人」 */
function nameOf(key: TgPeerKey | undefined, fallback = '某人') {
  if (!key) return fallback;
  if (key === selfKey) return '你';
  return peers.get(key)?.title ?? fallback;
}

function userNames(ids: { toString(): string }[]) { return ids.map((id) => nameOf(`user-${id.toString()}`)).join('、'); }

/** 服务消息（入群/改名/建群…）→ 中文句子 */
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

/** 提取消息中的富文本与隐藏链接实体（UTF-16 offset / length）。 */
function entityOf(entity: Api.TypeMessageEntity): TgMessageEntity | undefined {
  const { offset, length } = entity;
  if (length <= 0 || offset < 0) return undefined;
  if (entity instanceof Api.MessageEntityTextUrl) return { type: 'textUrl', offset, length, url: entity.url };
  if (entity instanceof Api.MessageEntityUrl) return { type: 'url', offset, length };
  if (entity instanceof Api.MessageEntityMention) return { type: 'mention', offset, length };
  if (entity instanceof Api.MessageEntityMentionName) return { type: 'mentionName', offset, length, userId: entity.userId.toString() };
  if (entity instanceof Api.MessageEntityHashtag) return { type: 'hashtag', offset, length };
  if (entity instanceof Api.MessageEntityCashtag) return { type: 'cashtag', offset, length };
  if (entity instanceof Api.MessageEntityBotCommand) return { type: 'botCommand', offset, length };
  if (entity instanceof Api.MessageEntityBold) return { type: 'bold', offset, length };
  if (entity instanceof Api.MessageEntityItalic) return { type: 'italic', offset, length };
  if (entity instanceof Api.MessageEntityUnderline) return { type: 'underline', offset, length };
  if (entity instanceof Api.MessageEntityStrike) return { type: 'strike', offset, length };
  if (entity instanceof Api.MessageEntityCode) return { type: 'code', offset, length };
  if (entity instanceof Api.MessageEntityPre) return { type: 'pre', offset, length, language: entity.language || undefined };
  if (entity instanceof Api.MessageEntitySpoiler) return { type: 'spoiler', offset, length };
  if (entity instanceof Api.MessageEntityBlockquote) return { type: 'blockquote', offset, length, collapsed: Boolean(entity.collapsed) || undefined };
  return undefined;
}

function entitiesOf(list: Api.TypeMessageEntity[] | undefined): TgMessageEntity[] | undefined {
  if (!list || list.length === 0) return undefined;
  const converted = list.map(entityOf).filter((item): item is TgMessageEntity => Boolean(item));
  return converted.length > 0 ? converted : undefined;
}

/** 提取消息下方的内联按键矩阵（ReplyInlineMarkup）。 */
function inlineButtonOf(button: Api.TypeKeyboardButton): TgInlineButton | undefined {
  const text = (button as { text?: string }).text?.trim() ?? '';
  if (!text) return undefined;
  if (button instanceof Api.KeyboardButtonCallback) {
    return { kind: 'callback', text, data: button.data.toString('base64') };
  }
  if (button instanceof Api.KeyboardButtonUrl) {
    return { kind: 'url', text, url: button.url };
  }
  if (button instanceof Api.KeyboardButtonUrlAuth) {
    return { kind: 'url', text, url: button.url };
  }
  if (button instanceof Api.KeyboardButtonSwitchInline) {
    return { kind: 'switchInline', text, query: button.query, samePeer: Boolean(button.samePeer) || undefined };
  }
  if (button instanceof Api.KeyboardButtonWebView || button instanceof Api.KeyboardButtonSimpleWebView) {
    return { kind: 'webview', text, url: button.url };
  }
  if (button instanceof Api.KeyboardButtonCopy) {
    return { kind: 'copy', text, copyText: button.copyText };
  }
  return { kind: 'other', text };
}

function replyMarkupOf(markup: Api.TypeReplyMarkup | undefined): TgInlineButton[][] | undefined {
  if (!(markup instanceof Api.ReplyInlineMarkup) || !markup.rows?.length) return undefined;
  const rows = markup.rows
    .map((row) => (row.buttons ?? []).map(inlineButtonOf).filter((btn): btn is TgInlineButton => Boolean(btn)))
    .filter((row) => row.length > 0);
  return rows.length > 0 ? rows : undefined;
}

/** 提取回复引用头（replyToMsgId + quoteText）。 */
function replyInfoOf(replyTo: Api.TypeMessageReplyHeader | undefined): TgReplyInfo | undefined {
  if (!(replyTo instanceof Api.MessageReplyHeader) || !replyTo.replyToMsgId) return undefined;
  return {
    id: replyTo.replyToMsgId,
    peerKey: replyTo.replyToPeerId ? peerKeyOf(replyTo.replyToPeerId) : undefined,
    quoteText: replyTo.quoteText || undefined,
  };
}

/** 提取网页预览卡片（MessageMediaWebPage）。 */
function webPageOf(media: Api.TypeMessageMedia | undefined): TgWebPagePreview | undefined {
  if (!(media instanceof Api.MessageMediaWebPage) || !(media.webpage instanceof Api.WebPage)) return undefined;
  const page = media.webpage;
  if (!page.title && !page.description && !page.siteName) return undefined;
  return {
    url: page.url,
    displayUrl: page.displayUrl || page.url,
    siteName: page.siteName || undefined,
    title: page.title || undefined,
    description: page.description || undefined,
    photo: photoInfoFrom(page.photo),
  };
}

/** 把一条 TL Message 转成可结构化克隆的 DTO（无法识别则返回 undefined） */
export function toMessage(message: Api.TypeMessage | undefined): TgMessageDto | undefined {
  if (!message || message instanceof Api.MessageEmpty) return undefined;
  const peerKey = peerKeyOf(message.peerId);
  const senderKey = senderKeyOf(message, peerKey);
  const senderName = nameOf(senderKey, peers.get(peerKey)?.title ?? '某人');
  const senderAvatar = senderKey ? peers.get(senderKey)?.avatar : undefined;
  const base = { id: message.id, peerKey, date: message.date ?? 0, out: Boolean(message.out), senderKey, senderName, senderAvatar };
  if (message instanceof Api.MessageService) {
    return { ...base, kind: 'service', text: serviceText(message.action, senderName, Boolean(message.out)) };
  }
  const replyTo = replyInfoOf(message.replyTo);
  const fwd = message.fwdFrom;
  const forwardedFrom = fwd ? (fwd.fromName ?? (fwd.fromId ? nameOf(peerKeyOf(fwd.fromId), '未知来源') : '未知来源')) : undefined;
  const repliesCount = message.replies?.replies && message.replies.replies > 0 ? message.replies.replies : undefined;
  return {
    ...base,
    kind: 'message',
    postAuthor: message.postAuthor || undefined,
    text: message.message ?? '',
    entities: entitiesOf(message.entities),
    media: mediaOf(message.media),
    webPage: webPageOf(message.media),
    editDate: message.editDate && !message.editHide ? message.editDate : undefined,
    replyToId: replyTo?.id,
    replyTo,
    replyMarkup: replyMarkupOf(message.replyMarkup),
    repliesCount,
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
  const replyTo = replyInfoOf(update.replyTo);
  return {
    id: update.id,
    peerKey,
    date: update.date,
    out: Boolean(update.out),
    kind: 'message',
    senderKey,
    senderName: nameOf(senderKey),
    text: update.message ?? '',
    entities: entitiesOf(update.entities),
    replyToId: replyTo?.id,
    replyTo,
    forwardedFrom: fwd ? (fwd.fromName ?? (fwd.fromId ? nameOf(peerKeyOf(fwd.fromId), '未知来源') : '未知来源')) : undefined,
  };
}

/** 把 Dialog 转成会话 DTO；缺实体信息时返回 undefined（宁可丢掉也不要展示无主条目） */
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
    avatar: info.avatar,
    username: info.username,
    participantsCount: info.participantsCount,
    left: info.left || undefined,
    kicked: info.kicked || undefined,
    creator: info.creator || undefined,
    joinRequest: info.joinRequest,
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

/** 由实体信息直接构造会话 DTO（用于公开 @username 搜索或刚加入但尚未收到 Dialog 条目的频道 / 群组）。 */
export function toPeerDialog(key: TgPeerKey, lastMessage?: TgMessageDto): TgDialogDto | undefined {
  const info = peers.get(key);
  if (!info) return undefined;
  return {
    key,
    peer: info.ref,
    kind: info.kind,
    title: info.title,
    avatar: info.avatar,
    username: info.username,
    participantsCount: info.participantsCount,
    left: info.left || undefined,
    kicked: info.kicked || undefined,
    creator: info.creator || undefined,
    joinRequest: info.joinRequest,
    pinned: false,
    folderId: 0,
    muted: false,
    unreadCount: 0,
    unreadMentions: 0,
    unreadMark: false,
    readInboxMaxId: 0,
    readOutboxMaxId: 0,
    topMessageId: lastMessage?.id ?? 0,
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
