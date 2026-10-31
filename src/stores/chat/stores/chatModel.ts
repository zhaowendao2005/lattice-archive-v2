/**
 * chat 域纯函数：消息窗口合并、会话排序、视图模型格式化、冷启动快照裁剪。
 * 不持有状态、不访问网络或 DOM，便于 Store 保持精简并可单独推理。
 */
import type { ChatCacheSnapshot, FeedItem, FeedPhoto, FeedRound, FeedVideoFile, MessageWindow, SessionListItem, TgDialogDto, TgMessageDto, TgPeerKey, TgPhotoInfo, TgPhotoSize, TgUpdatesState, TgVideoInfo, TgVideoQuality } from '../types';
import type { TgChatKind, TgHistoryPage } from '@/worker/local/chatProtocol';

/** 参考实现的会话批量为 100；消息批量大屏 60、小屏 40。 */
export const DIALOG_PAGE_SIZE = 100;
/** 会话列表翻页保护上限，防止游标异常时无限请求。 */
export const MAX_DIALOG_PAGES = 30;
export function historyPageSize() { return typeof window !== 'undefined' && window.innerWidth >= 1024 ? 60 : 40; }

/** 冷启动快照的裁剪上限：会话 200 条、最近会话 20 个、每个会话最新 60 条消息。 */
const CACHE_DIALOG_LIMIT = 200;
const CACHE_WINDOW_LIMIT = 20;
const CACHE_MESSAGES_PER_WINDOW = 60;
/** 离开会话时若窗口过长则裁剪，避免长时间浏览后内存与 DOM 无限增长。 */
const INACTIVE_WINDOW_MAX = 300;
const INACTIVE_WINDOW_KEEP = 100;

export function createWindow(messages: TgMessageDto[] = [], hasOlder = true, continuous = false): MessageWindow {
  return { messages, hasOlder, continuous, fresh: false, isLoadingLatest: false, isLoadingOlder: false, error: null, epoch: 0 };
}

/** 用服务器最新页校准窗口：有重叠则以服务器为准覆盖重叠区（顺带清除已删除消息），无重叠说明有缺口，整体替换。 */
export function mergeLatestPage(window: MessageWindow, page: TgHistoryPage) {
  const incoming = page.messages;
  if (incoming.length === 0) {
    window.messages = [];
    window.hasOlder = false;
  } else if (window.messages.length === 0) {
    window.messages = incoming;
    window.hasOlder = page.hasOlder;
  } else if (window.messages[window.messages.length - 1].id >= incoming[0].id) {
    const older = window.messages.filter((message) => message.id < incoming[0].id);
    window.messages = [...older, ...incoming];
    window.hasOlder = older.length > 0 ? window.hasOlder : page.hasOlder;
  } else {
    window.messages = incoming;
    window.hasOlder = page.hasOlder;
    window.epoch += 1;
  }
  window.continuous = true;
  window.fresh = true;
}

export function prependOlder(window: MessageWindow, page: TgHistoryPage) {
  const oldest = window.messages[0]?.id ?? Number.POSITIVE_INFINITY;
  const older = page.messages.filter((message) => message.id < oldest);
  window.messages = [...older, ...window.messages];
  window.hasOlder = page.hasOlder && older.length > 0;
}

/** 按 ID 插入或替换，保持升序。 */
export function upsertMessage(window: MessageWindow, message: TgMessageDto) {
  const list = window.messages;
  let low = 0;
  let high = list.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (list[mid].id < message.id) low = mid + 1; else high = mid;
  }
  if (list[low]?.id === message.id) list.splice(low, 1, message);
  else list.splice(low, 0, message);
}

export function trimInactiveWindow(window: MessageWindow): boolean {
  if (window.messages.length <= INACTIVE_WINDOW_MAX) return false;
  window.messages = window.messages.slice(-INACTIVE_WINDOW_KEEP);
  window.hasOlder = true;
  window.epoch += 1;
  return true;
}

export function orderDialogs(dialogs: Record<TgPeerKey, TgDialogDto>, pinnedOrder: TgPeerKey[], folderId: 0 | 1 = 0): TgDialogDto[] {
  const pinned = pinnedOrder
    .map((key) => dialogs[key])
    .filter((dialog): dialog is TgDialogDto => Boolean(dialog?.pinned && (dialog.folderId ?? 0) === folderId));
  const pinnedKeys = new Set(pinned.map((dialog) => dialog.key));
  const rest = Object.values(dialogs)
    .filter((dialog) => (dialog.folderId ?? 0) === folderId && !pinnedKeys.has(dialog.key))
    .sort((a, b) => b.date - a.date || b.topMessageId - a.topMessageId);
  return [...pinned, ...rest];
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const pad = (value: number) => String(value).padStart(2, '0');
function startOfDay(date: Date) { return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime(); }
function dayDiff(date: Date, now = new Date()) { return Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000); }
export function formatClock(seconds: number) { const date = new Date(seconds * 1000); return `${pad(date.getHours())}:${pad(date.getMinutes())}`; }
export function formatDateTime(seconds: number) { const date = new Date(seconds * 1000); return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()} ${formatClock(seconds)}`; }

export function formatListTime(seconds: number): string {
  if (!seconds) return '';
  const date = new Date(seconds * 1000);
  const diff = dayDiff(date);
  if (diff <= 0) return formatClock(seconds);
  if (diff === 1) return '昨天';
  if (diff < 7) return WEEKDAYS[date.getDay()];
  if (date.getFullYear() === new Date().getFullYear()) return `${date.getMonth() + 1}/${date.getDate()}`;
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
}

function formatDayLabel(date: Date): string {
  const diff = dayDiff(date);
  if (diff === 0) return '今天';
  if (diff === 1) return '昨天';
  if (date.getFullYear() === new Date().getFullYear()) return `${date.getMonth() + 1}月${date.getDate()}日 ${WEEKDAYS[date.getDay()]}`;
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

export function initialsOf(title: string | undefined): string {
  const words = (title ?? '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  const first = Array.from(words[0])[0] ?? '?';
  if (/[\u3400-\u9fff]/.test(first) || words.length === 1) return first.toUpperCase();
  return `${first}${Array.from(words[1])[0] ?? ''}`.toUpperCase();
}

const KIND_LABELS: Record<TgChatKind, string> = { self: '收藏夹', user: '私聊', bot: '机器人', group: '群组', supergroup: '超级群组', channel: '频道' };
export function kindLabel(kind: TgChatKind) { return KIND_LABELS[kind]; }
const isGroupKind = (kind: TgChatKind) => kind === 'group' || kind === 'supergroup';

export function messagePreview(message: TgMessageDto): string {
  if (message.kind === 'service') return message.text;
  const text = message.text.replace(/\s+/g, ' ').trim();
  if (message.media) return text ? `[${message.media.label}] ${text}` : `[${message.media.label}]`;
  return text || '[空消息]';
}

function dialogPreview(dialog: TgDialogDto): string {
  const message = dialog.lastMessage;
  if (!message) return '';
  const body = messagePreview(message);
  if (message.kind === 'service' || dialog.kind === 'channel' || dialog.kind === 'self') return body;
  if (message.out) return `你：${body}`;
  if (isGroupKind(dialog.kind) && message.senderName) return `${message.senderName.split(' ')[0]}：${body}`;
  return body;
}

export function toSessionItem(dialog: TgDialogDto): SessionListItem {
  return {
    key: dialog.key,
    title: dialog.title,
    initials: initialsOf(dialog.title),
    preview: dialogPreview(dialog),
    timeLabel: formatListTime(dialog.date),
    unreadCount: dialog.unreadCount,
    unreadMark: dialog.unreadMark,
    muted: dialog.muted,
    pinned: dialog.pinned,
    kindLabel: kindLabel(dialog.kind),
  };
}

/** 消息流视图模型：插入日期分隔、合并同一发送者的连续消息、合并相册、标注已读状态。 */
export function buildFeed(messages: TgMessageDto[], dialog: TgDialogDto | undefined): FeedItem[] {
  const items: FeedItem[] = [];
  const inGroup = dialog ? isGroupKind(dialog.kind) : false;
  const showReadState = dialog ? dialog.kind !== 'channel' && dialog.kind !== 'self' : false;
  let lastDay = '';
  let lastSender: string | undefined;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    const date = new Date(message.date * 1000);
    const day = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
    if (day !== lastDay) {
      items.push({ type: 'day', key: `day-${day}`, label: formatDayLabel(date) });
      lastDay = day;
      lastSender = undefined;
    }
    if (message.kind === 'service') {
      items.push({ type: 'service', key: `m-${message.id}`, text: message.text });
      lastSender = undefined;
      continue;
    }
    const album = collectAlbum(messages, index, day);
    index += album.length - 1;
    const last = album[album.length - 1];
    const captioned = album.find((item) => item.text) ?? message;
    const photos = album.flatMap((item) => { const visual = toFeedVisual(item); return visual ? [visual] : []; });
    const albumColumns = photos.length > 1 ? layoutAlbum(photos) : undefined;
    const round = toFeedRound(message);
    const videoFile = toFeedVideoFile(message);
    const showSender = inGroup && !message.out && message.senderKey !== lastSender;
    lastSender = message.senderKey;
    items.push({
      type: 'message',
      key: album.length > 1 ? `album-${message.groupedId}-${message.id}` : `m-${message.id}`,
      id: message.id,
      out: message.out,
      text: captioned.text,
      mediaLabel: photos.length > 0 || round || videoFile ? undefined : message.media?.label,
      photos: photos.length > 0 ? photos : undefined,
      videoFile,
      round,
      albumIds: album.length > 1 ? album.map((item) => item.id) : undefined,
      albumColumns,
      senderName: message.senderName,
      senderInitials: initialsOf(message.senderName),
      inGroup,
      showSender,
      timeLabel: formatClock(last.date),
      edited: album.some((item) => Boolean(item.editDate)),
      forwardedFrom: message.forwardedFrom,
      replyToId: message.replyToId,
      readState: message.out && showReadState && dialog ? (last.id <= dialog.readOutboxMaxId ? 'read' : 'sent') : undefined,
    });
  }
  return items;
}

/** 照片展示尺寸：限制最大宽高与极端长宽比（超出部分由 object-cover 裁切），下载前即锁定占位。 */
const PHOTO_MAX_WIDTH = 400;
const PHOTO_MAX_HEIGHT = 420;
const PHOTO_MIN_WIDTH = 160;
const PHOTO_ASPECT_MIN = 0.45;
const PHOTO_ASPECT_MAX = 2.6;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function photoKey(photo: TgPhotoInfo, size: TgPhotoSize) { return `photo:${photo.id}:${size.type}`; }
export function previewSizeOf(photo: TgPhotoInfo): TgPhotoSize { return photo.preview ?? photo.full; }
export function docThumbKey(video: TgVideoInfo, size: TgPhotoSize) { return `doc:${video.id}:${size.type}`; }
/** 完整视频文件的媒体键：按画质文档 ID 区分。 */
export function videoFileKey(quality: { id: string }) { return `video:${quality.id}`; }
export function mediaTarget(peerKey: TgPeerKey, messageId: number) { return `${peerKey}:${messageId}`; }
export function parseMediaTarget(target: string): { peerKey: TgPeerKey; messageId: number } | null {
  const index = target.lastIndexOf(':');
  const messageId = Number(target.slice(index + 1));
  return index > 0 && Number.isInteger(messageId) ? { peerKey: target.slice(0, index), messageId } : null;
}

/** 视频预览图来源：优先视频封面（照片预览档），其次文档缩略图档位；都没有时只能显示 stripped thumb。 */
export type VideoPreviewSource =
  | { kind: 'photo'; key: string; photo: TgPhotoInfo; size: TgPhotoSize }
  | { kind: 'document'; key: string; size: TgPhotoSize };

export function videoPreviewOf(video: TgVideoInfo): VideoPreviewSource | null {
  if (video.cover) { const size = previewSizeOf(video.cover); return { kind: 'photo', key: photoKey(video.cover, size), photo: video.cover, size }; }
  if (video.preview) return { kind: 'document', key: docThumbKey(video, video.preview), size: video.preview };
  return null;
}

export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = String(total % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${secs}` : `${minutes}:${secs}`;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.ceil(bytes / 1024))} KB`;
}

/** 画质标签取短边（竖屏 720×1280 记作 720p），与 Telegram 一致。 */
export function qualityHeight(quality: TgVideoQuality) { return Math.min(quality.width, quality.height) || quality.height; }
export function qualityLabel(quality: TgVideoQuality) { const height = qualityHeight(quality); return height > 0 ? `${height}p` : '原画'; }

/**
 * 自动画质：只在浏览器可播放的版本中选择短边不超过上限（默认 min(720, 屏幕物理高度)）的最高一档；
 * 没有满足条件的则取最小一档；全部不可播放时退回原片（交给播放器报告不支持）。
 */
export function chooseQuality(video: TgVideoInfo, isPlayable: (quality: TgVideoQuality) => boolean, maxHeight: number, screenHeight: number): TgVideoQuality {
  const original = video.qualities.find((item) => item.original) ?? video.qualities[0];
  const playable = video.qualities.filter(isPlayable);
  if (playable.length === 0) return original;
  const cap = maxHeight > 0 ? maxHeight : Math.min(720, Math.max(360, screenHeight));
  const sorted = [...playable].sort((a, b) => qualityHeight(b) - qualityHeight(a) || a.size - b.size);
  return sorted.find((item) => qualityHeight(item) <= cap) ?? sorted[sorted.length - 1];
}

function isAlbumVisual(message: TgMessageDto) {
  const media = message.media;
  return Boolean(media?.photo) || (media?.kind === 'video' && Boolean(media.video) && !media.video?.asFile);
}

function visualSize(width: number, height: number) {
  const aspectRatio = clamp(width / Math.max(1, height), PHOTO_ASPECT_MIN, PHOTO_ASPECT_MAX);
  return { aspectRatio, width: Math.round(clamp(PHOTO_MAX_HEIGHT * aspectRatio, PHOTO_MIN_WIDTH, PHOTO_MAX_WIDTH)) };
}

function toFeedVisual(message: TgMessageDto): FeedPhoto | undefined {
  const media = message.media;
  const photo = media?.photo;
  if (photo) {
    return {
      kind: 'photo',
      target: mediaTarget(message.peerKey, message.id),
      messageId: message.id,
      previewKey: photoKey(photo, previewSizeOf(photo)),
      thumb: photo.thumb,
      spoiler: Boolean(photo.spoiler),
      ...visualSize(photo.width, photo.height),
      span: 1,
    };
  }
  const video = media?.video;
  if (!video || video.asFile || (media?.kind !== 'video' && media?.kind !== 'gif')) return undefined;
  const hasSize = video.width > 0 && video.height > 0;
  return {
    kind: media.kind === 'gif' ? 'gif' : 'video',
    target: mediaTarget(message.peerKey, message.id),
    messageId: message.id,
    previewKey: videoPreviewOf(video)?.key ?? '',
    thumb: video.cover?.thumb ?? video.thumb,
    spoiler: Boolean(video.spoiler),
    ...visualSize(hasSize ? video.width : 16, hasSize ? video.height : 9),
    span: 1,
    durationLabel: media.kind === 'video' ? formatDuration(video.duration) : undefined,
    sizeLabel: media.kind === 'video' ? formatBytes(video.size) : undefined,
  };
}

function toFeedRound(message: TgMessageDto): FeedRound | undefined {
  const video = message.media?.kind === 'round' ? message.media.video : undefined;
  if (!video) return undefined;
  return { target: mediaTarget(message.peerKey, message.id), previewKey: videoPreviewOf(video)?.key ?? '', thumb: video.thumb, durationLabel: formatDuration(video.duration), duration: video.duration };
}

function toFeedVideoFile(message: TgMessageDto): FeedVideoFile | undefined {
  const video = message.media?.video;
  if (!video?.asFile) return undefined;
  const meta = [formatBytes(video.size), video.duration > 0 ? formatDuration(video.duration) : ''].filter(Boolean).join(' · ');
  return {
    target: mediaTarget(message.peerKey, message.id),
    fileName: video.fileName || `video-${message.id}.${video.mimeType.split('/')[1] ?? 'mp4'}`,
    metaLabel: meta,
    thumb: video.thumb,
    previewKey: videoPreviewOf(video)?.key ?? '',
    playable: video.mimeType !== 'video/webm' || typeof MediaSource !== 'undefined',
  };
}

/**
 * 相册网格：2 / 4 张用两列，3 张让首张横跨；其余三列，并让首张（必要时连同末张）横跨两列补齐末行，避免留下空格。
 * 每格固定比例（横跨格 2:1，普通格 1:1），与列数无关地保持行高一致，下载前尺寸即确定。
 */
function layoutAlbum(photos: FeedPhoto[]): 2 | 3 {
  const count = photos.length;
  if (count === 2 || count === 4) return 2;
  if (count === 3) { photos[0].span = 2; return 2; }
  if (count % 3 === 2) photos[0].span = 2;
  if (count % 3 === 1) { photos[0].span = 2; photos[count - 1].span = 2; }
  return 3;
}

/** 相册：同一 groupedId、同一发送者、同一天的连续照片 / 视频消息合并为一个气泡；GIF、圆形视频与文件保持独立展示。 */
function collectAlbum(messages: TgMessageDto[], start: number, day: string): TgMessageDto[] {
  const first = messages[start];
  if (!first.groupedId || !isAlbumVisual(first)) return [first];
  const album = [first];
  for (let index = start + 1; index < messages.length; index += 1) {
    const next = messages[index];
    const date = new Date(next.date * 1000);
    const sameDay = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}` === day;
    if (next.kind !== 'message' || next.groupedId !== first.groupedId || next.senderKey !== first.senderKey || !isAlbumVisual(next) || !sameDay) break;
    album.push(next);
  }
  return album;
}

interface SnapshotSource {
  ownerId: string;
  accountId: string;
  updatesState: TgUpdatesState | null;
  dialogs: Record<TgPeerKey, TgDialogDto>;
  pinnedOrder: TgPeerKey[];
  windows: Record<TgPeerKey, MessageWindow>;
  recentChatKeys: TgPeerKey[];
  activeChatKey: TgPeerKey | null;
  viewportAnchors: Record<TgPeerKey, number>;
}

/** 只保存与服务器连续的窗口最新片段；不连续的窗口落盘后会误导下次补差，直接丢弃。 */
export function buildSnapshot(source: SnapshotSource): ChatCacheSnapshot {
  const windows: ChatCacheSnapshot['windows'] = {};
  const viewportAnchors: Record<TgPeerKey, number> = {};
  for (const key of source.recentChatKeys.slice(0, CACHE_WINDOW_LIMIT)) {
    const window = source.windows[key];
    if (!window?.continuous || window.messages.length === 0) continue;
    const messages = window.messages.slice(-CACHE_MESSAGES_PER_WINDOW);
    windows[key] = { messages, hasOlder: window.hasOlder || window.messages.length > messages.length };
    const anchor = source.viewportAnchors[key];
    if (anchor && messages.some((message) => message.id === anchor)) viewportAnchors[key] = anchor;
  }
  return {
    version: 2,
    ownerId: source.ownerId,
    accountId: source.accountId,
    savedAt: Date.now(),
    updatesState: source.updatesState,
    dialogs: orderDialogs(source.dialogs, source.pinnedOrder).slice(0, CACHE_DIALOG_LIMIT),
    pinnedOrder: source.pinnedOrder,
    windows,
    recentChatKeys: source.recentChatKeys.slice(0, CACHE_WINDOW_LIMIT),
    activeChatKey: source.activeChatKey,
    viewportAnchors,
  };
}
