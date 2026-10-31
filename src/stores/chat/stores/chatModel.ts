/**
 * chat 域纯函数：消息窗口合并、会话排序、视图模型格式化、冷启动快照裁剪。
 * 不持有状态、不访问网络或 DOM，便于 Store 保持精简并可单独推理。
 */
import type {
  ChatCacheSnapshot, FeedItem, FeedPhoto, FeedReplyPreview, FeedRound, FeedVideoFile, FeedWebPage,
  MessageWindow, ParsedTelegramLink, RichTextBlock, RichTextSegment, SessionListItem, TgAvatarInfo,
  TgDialogDto, TgMessageDto, TgMessageEntity, TgPeerKey, TgPhotoInfo, TgPhotoSize, TgUpdatesState,
  TgVideoInfo, TgVideoQuality,
} from '../types';
import type { TgChatKind, TgHistoryPage } from '@/worker/local/chatProtocol';

/** 参考实现的会话批量为 100；消息批量大屏 60、小屏 40。 */
export const DIALOG_PAGE_SIZE = 100;
/** 会话列表翻页保护上限，防止游标异常时无限请求。 */
export const MAX_DIALOG_PAGES = 30;
export function historyPageSize() { return typeof window !== 'undefined' && window.innerWidth >= 1024 ? 60 : 40; }

/** 冷启动快照的裁剪上限：活动会话 200 条、归档会话 20 条、最近会话 20 个、每个会话最新 60 条消息。 */
const CACHE_DIALOG_LIMIT = 200;
const CACHE_ARCHIVE_DIALOG_LIMIT = 20;
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

/**
 * 合并跨历史跳转（getHistoryAround）拉取到的上下文：
 * - 若与当前窗口重叠，则合并去重并保持 continuous 状态；
 * - 若不重叠（跳到了很早的历史片段），则替换为该片段并标记 continuous=false。
 */
export function mergeHistoryAround(window: MessageWindow, page: TgHistoryPage) {
  const incoming = page.messages;
  if (incoming.length === 0) return;
  const current = window.messages;
  if (current.length === 0) {
    window.messages = incoming;
    window.hasOlder = page.hasOlder;
    window.continuous = false;
    window.epoch += 1;
    return;
  }
  const minIn = incoming[0].id;
  const maxIn = incoming[incoming.length - 1].id;
  const minCur = current[0].id;
  const maxCur = current[current.length - 1].id;
  const overlaps = maxIn >= minCur && minIn <= maxCur;
  if (overlaps) {
    const map = new Map<number, TgMessageDto>();
    for (const msg of current) map.set(msg.id, msg);
    for (const msg of incoming) map.set(msg.id, msg);
    window.messages = [...map.values()].sort((a, b) => a.id - b.id);
    if (minIn < minCur) window.hasOlder = page.hasOlder;
  } else {
    window.messages = incoming;
    window.hasOlder = page.hasOlder;
    window.continuous = false;
    window.epoch += 1;
  }
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

export function avatarKey(peerKey: TgPeerKey, avatar: TgAvatarInfo): string {
  return `avatar:${peerKey}:${avatar.photoId}`;
}

export function toSessionItem(dialog: TgDialogDto): SessionListItem {
  const folderId: 0 | 1 = dialog.folderId === 1 ? 1 : 0;
  return {
    key: dialog.key,
    title: dialog.title,
    initials: initialsOf(dialog.title),
    avatarKey: dialog.avatar ? avatarKey(dialog.key, dialog.avatar) : undefined,
    avatarThumb: dialog.avatar?.thumb,
    preview: dialogPreview(dialog),
    timeLabel: formatListTime(dialog.date),
    unreadCount: dialog.unreadCount,
    unreadMark: dialog.unreadMark,
    muted: dialog.muted,
    pinned: dialog.pinned,
    folderId,
    canArchive: dialog.kind !== 'self' && !dialog.left && !dialog.kicked,
    kindLabel: kindLabel(dialog.kind),
  };
}

/**
 * 将消息 UTF-16 文本与 entities 切分为「段落 / 引用块 (Blockquote)」+「内联富文本与链接片段 (RichTextSegment)」。
 * JavaScript 的 string.slice(offset, offset + length) 原生按 UTF-16 代码单元寻址，与 Telegram Entity 规范完全一致。
 */
export function tokenizeMessageText(text: string, entities?: TgMessageEntity[], messageId = 0): RichTextBlock[] {
  if (!text) return [];
  const totalLen = text.length;
  const valid = (entities ?? [])
    .map((item) => {
      const start = Math.max(0, Math.min(totalLen, item.offset));
      const end = Math.max(start, Math.min(totalLen, item.offset + item.length));
      return { ...item, offset: start, length: end - start };
    })
    .filter((item) => item.length > 0);

  if (valid.length === 0) {
    return [{ kind: 'paragraph', segments: [{ text }] }];
  }

  const blockquotes = valid
    .filter((item) => item.type === 'blockquote')
    .sort((a, b) => a.offset - b.offset || b.length - a.length);
  const inlines = valid.filter((item) => item.type !== 'blockquote');

  interface RawBlock { kind: 'paragraph' | 'blockquote'; start: number; end: number; collapsed?: boolean }
  const rawBlocks: RawBlock[] = [];
  let cursor = 0;
  for (const bq of blockquotes) {
    const start = Math.max(cursor, bq.offset);
    const end = bq.offset + bq.length;
    if (end <= start) continue;
    if (start > cursor) rawBlocks.push({ kind: 'paragraph', start: cursor, end: start });
    rawBlocks.push({ kind: 'blockquote', start, end, collapsed: bq.collapsed });
    cursor = end;
  }
  if (cursor < totalLen) rawBlocks.push({ kind: 'paragraph', start: cursor, end: totalLen });

  const blocks: RichTextBlock[] = [];
  for (let idx = 0; idx < rawBlocks.length; idx += 1) {
    const raw = rawBlocks[idx];
    let blockStart = raw.start;
    let blockEnd = raw.end;
    if (raw.kind === 'paragraph') {
      // 消除紧邻 blockquote 前后的单个换行，避免出现多余空行。
      if (idx > 0 && rawBlocks[idx - 1].kind === 'blockquote' && text[blockStart] === '\n') blockStart += 1;
      if (idx + 1 < rawBlocks.length && rawBlocks[idx + 1].kind === 'blockquote' && blockEnd > blockStart && text[blockEnd - 1] === '\n') blockEnd -= 1;
      if (blockEnd <= blockStart) continue;
    }

    const blockInlines = inlines.filter((item) => item.offset < blockEnd && item.offset + item.length > blockStart);
    if (blockInlines.length === 0) {
      blocks.push({ kind: raw.kind, collapsed: raw.collapsed, segments: [{ text: text.slice(blockStart, blockEnd) }] });
      continue;
    }

    const points = new Set<number>([blockStart, blockEnd]);
    for (const item of blockInlines) {
      points.add(Math.max(blockStart, item.offset));
      points.add(Math.min(blockEnd, item.offset + item.length));
    }
    const sorted = [...points].sort((a, b) => a - b);
    const segments: RichTextSegment[] = [];

    for (let i = 0; i < sorted.length - 1; i += 1) {
      const segStart = sorted[i];
      const segEnd = sorted[i + 1];
      if (segEnd <= segStart) continue;
      const segText = text.slice(segStart, segEnd);
      const active = blockInlines.filter((item) => item.offset <= segStart && item.offset + item.length >= segEnd);
      const segment: RichTextSegment = { text: segText };

      for (const ent of active) {
        if (ent.type === 'bold') segment.bold = true;
        else if (ent.type === 'italic') segment.italic = true;
        else if (ent.type === 'underline') segment.underline = true;
        else if (ent.type === 'strike') segment.strike = true;
        else if (ent.type === 'code') segment.code = true;
        else if (ent.type === 'pre') { segment.pre = true; if (ent.language) segment.language = ent.language; }
        else if (ent.type === 'spoiler') { segment.spoiler = true; segment.spoilerKey = `${messageId}:${ent.offset}`; }
        else if (ent.type === 'textUrl' && ent.url) segment.link = { kind: 'url', target: ent.url };
        else if (ent.type === 'url' && !segment.link) {
          const fullUrl = text.slice(ent.offset, ent.offset + ent.length).trim();
          const href = /^(?:https?:\/\/|tg:\/\/)/i.test(fullUrl) ? fullUrl : `https://${fullUrl}`;
          segment.link = { kind: 'url', target: href };
        } else if (ent.type === 'mention' && !segment.link) {
          const mention = text.slice(ent.offset, ent.offset + ent.length).replace(/^@/, '').trim();
          if (mention) segment.link = { kind: 'mention', target: mention };
        } else if (ent.type === 'mentionName' && ent.userId && !segment.link) {
          segment.link = { kind: 'mentionName', target: `user-${ent.userId}` };
        } else if (ent.type === 'botCommand' && !segment.link) {
          const cmd = text.slice(ent.offset, ent.offset + ent.length).trim();
          if (cmd) segment.link = { kind: 'botCommand', target: cmd };
        } else if ((ent.type === 'hashtag' || ent.type === 'cashtag') && !segment.link) {
          const tag = text.slice(ent.offset, ent.offset + ent.length).trim();
          if (tag) segment.link = { kind: 'hashtag', target: tag };
        }
      }
      segments.push(segment);
    }

    blocks.push({ kind: raw.kind, collapsed: raw.collapsed, segments });
  }

  return blocks;
}

const RESERVED_TG_PATHS = new Set(['c', 'joinchat', 'addstickers', 'addemoji', 'share', 'iv', 'proxy', 'socks', 'bg', 'boost', 'login', 'invoice']);

/**
 * 解析任意 Telegram 链接（t.me / telegram.me / tg:// / @username）为 6 类动作目标。
 */
export function parseTelegramLink(rawUrl: string): ParsedTelegramLink {
  const raw = rawUrl.trim();
  if (!raw) return { kind: 'external', url: '' };

  if (raw.startsWith('@')) {
    const username = raw.slice(1).split(/[/?#]/)[0]?.trim() ?? '';
    if (/^[a-zA-Z][a-zA-Z0-9_]{3,31}$/.test(username)) {
      return { kind: 'username', username };
    }
  }

  if (/^tg:\/\//i.test(raw)) {
    try {
      const parsed = new URL(raw.replace(/^tg:\/\//i, 'https://tg.internal/'));
      const host = parsed.pathname.replace(/^\/+/, '').toLowerCase();
      if (host === 'join') {
        const hash = parsed.searchParams.get('invite')?.trim();
        if (hash) return { kind: 'invite', hash };
      }
      if (host === 'privatepost') {
        const channelId = parsed.searchParams.get('channel')?.trim();
        const post = Number(parsed.searchParams.get('post'));
        if (channelId && /^\d+$/.test(channelId) && Number.isInteger(post) && post > 0) {
          return { kind: 'privateMessage', channelId, messageId: post };
        }
      }
      if (host === 'resolve') {
        const domain = parsed.searchParams.get('domain')?.trim() ?? '';
        if (/^[a-zA-Z][a-zA-Z0-9_]{3,31}$/.test(domain)) {
          const start = parsed.searchParams.get('start') ?? parsed.searchParams.get('startgroup') ?? parsed.searchParams.get('startchannel');
          if (start !== null) return { kind: 'botStart', username: domain, startParam: start };
          const post = Number(parsed.searchParams.get('post'));
          if (Number.isInteger(post) && post > 0) return { kind: 'publicMessage', username: domain, messageId: post };
          return { kind: 'username', username: domain };
        }
      }
    } catch {
      return { kind: 'external', url: raw };
    }
  }

  const normalized = /^(?:https?:\/\/)/i.test(raw) ? raw : /^(?:t\.me|telegram\.me|telegram\.dog)\//i.test(raw) ? `https://${raw}` : raw;
  try {
    const url = new URL(normalized);
    const hostname = url.hostname.toLowerCase().replace(/^www\./, '');
    if (hostname === 't.me' || hostname === 'telegram.me' || hostname === 'telegram.dog') {
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts.length === 1 && parts[0].startsWith('+')) {
        const hash = parts[0].slice(1).trim();
        if (hash) return { kind: 'invite', hash };
      }
      if (parts.length >= 2 && parts[0].toLowerCase() === 'joinchat') {
        const hash = parts[1].trim();
        if (hash) return { kind: 'invite', hash };
      }
      if (parts.length >= 3 && parts[0].toLowerCase() === 'c' && /^\d+$/.test(parts[1])) {
        const msgId = Number(parts[parts.length - 1]);
        if (Number.isInteger(msgId) && msgId > 0) {
          return { kind: 'privateMessage', channelId: parts[1], messageId: msgId };
        }
      }
      if (parts.length >= 1) {
        const candidate = parts[0];
        if (!RESERVED_TG_PATHS.has(candidate.toLowerCase()) && /^[a-zA-Z][a-zA-Z0-9_]{3,31}$/.test(candidate)) {
          const start = url.searchParams.get('start') ?? url.searchParams.get('startgroup') ?? url.searchParams.get('startchannel');
          if (start !== null && parts.length === 1) {
            return { kind: 'botStart', username: candidate, startParam: start };
          }
          if (parts.length >= 2) {
            const msgId = Number(parts[parts.length - 1]);
            if (Number.isInteger(msgId) && msgId > 0) {
              return { kind: 'publicMessage', username: candidate, messageId: msgId };
            }
          }
          if (parts.length === 1) {
            return { kind: 'username', username: candidate };
          }
        }
      }
    }
  } catch {
    // 非标准 URL 按外链兜底
  }

  return { kind: 'external', url: normalized };
}

function buildReplyPreview(message: TgMessageDto, byId: Map<number, TgMessageDto>): FeedReplyPreview | undefined {
  const replyId = message.replyTo?.id ?? message.replyToId;
  if (!replyId) return undefined;
  const target = byId.get(replyId);
  const quote = message.replyTo?.quoteText?.replace(/\s+/g, ' ').trim();
  if (target) {
    return {
      messageId: replyId,
      senderName: target.senderName || (target.out ? '你' : '消息'),
      text: quote || messagePreview(target),
    };
  }
  return {
    messageId: replyId,
    senderName: '回复消息',
    text: quote || `消息 #${replyId}（点击定位）`,
  };
}

function toFeedWebPage(message: TgMessageDto): FeedWebPage | undefined {
  const page = message.webPage;
  if (!page) return undefined;
  return {
    url: page.url,
    displayUrl: page.displayUrl,
    siteName: page.siteName,
    title: page.title,
    description: page.description,
    thumb: page.photo?.thumb,
  };
}

/** 消息流视图模型：插入日期分隔、合并同一发送者的连续消息、合并相册、标注已读状态。 */
export function buildFeed(messages: TgMessageDto[], dialog: TgDialogDto | undefined): FeedItem[] {
  const items: FeedItem[] = [];
  const inGroup = dialog ? isGroupKind(dialog.kind) : false;
  const showReadState = dialog ? dialog.kind !== 'channel' && dialog.kind !== 'self' : false;
  const byId = new Map<number, TgMessageDto>();
  for (const item of messages) byId.set(item.id, item);

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
    const webPage = toFeedWebPage(captioned);
    const richBlocks = captioned.text ? tokenizeMessageText(captioned.text, captioned.entities, captioned.id) : undefined;
    const replyPreview = buildReplyPreview(message, byId);
    const replyMarkup = last.replyMarkup ?? message.replyMarkup;
    const showSender = inGroup && !message.out && message.senderKey !== lastSender;
    lastSender = message.senderKey;
    items.push({
      type: 'message',
      key: album.length > 1 ? `album-${message.groupedId}-${message.id}` : `m-${message.id}`,
      id: message.id,
      out: message.out,
      text: captioned.text,
      richBlocks,
      mediaLabel: photos.length > 0 || round || videoFile ? undefined : message.media?.label,
      photos: photos.length > 0 ? photos : undefined,
      videoFile,
      round,
      webPage,
      albumIds: album.length > 1 ? album.map((item) => item.id) : undefined,
      albumColumns,
      senderName: message.senderName,
      senderInitials: initialsOf(message.senderName),
      senderAvatarTarget: showSender && message.senderAvatar && message.senderKey ? mediaTarget(message.peerKey, message.id) : undefined,
      senderAvatarKey: showSender && message.senderAvatar && message.senderKey ? avatarKey(message.senderKey, message.senderAvatar) : undefined,
      senderAvatarThumb: showSender ? message.senderAvatar?.thumb : undefined,
      postAuthor: message.postAuthor,
      inGroup,
      showSender,
      timeLabel: formatClock(last.date),
      edited: album.some((item) => Boolean(item.editDate)),
      forwardedFrom: message.forwardedFrom,
      replyToId: message.replyToId,
      replyPreview,
      replyMarkup,
      repliesCount: last.repliesCount ?? message.repliesCount,
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
  archivePinnedOrder?: TgPeerKey[];
  hasArchivedChats?: boolean;
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
  const activeDialogs = orderDialogs(source.dialogs, source.pinnedOrder, 0).slice(0, CACHE_DIALOG_LIMIT);
  const archivedDialogs = orderDialogs(source.dialogs, source.archivePinnedOrder ?? [], 1).slice(0, CACHE_ARCHIVE_DIALOG_LIMIT);
  return {
    version: 2,
    ownerId: source.ownerId,
    accountId: source.accountId,
    savedAt: Date.now(),
    updatesState: source.updatesState,
    dialogs: [...activeDialogs, ...archivedDialogs],
    pinnedOrder: source.pinnedOrder,
    archivePinnedOrder: source.archivePinnedOrder,
    hasArchivedChats: source.hasArchivedChats || archivedDialogs.length > 0,
    windows,
    recentChatKeys: source.recentChatKeys.slice(0, CACHE_WINDOW_LIMIT),
    activeChatKey: source.activeChatKey,
    viewportAnchors,
  };
}
