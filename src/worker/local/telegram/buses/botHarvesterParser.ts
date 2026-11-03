/**
 * ============================================================================
 * 搜索机器人内联翻页解析与「发出查询 ↔ 回复结果」配对实现域 (botHarvesterParser.ts)
 * ============================================================================
 * 职责（归属 src/worker/local/chat 具体业务实现域）：
 * 1. 识别 2/3/4 按钮翻页布局（如 [首页][上一页][下一页][末页] 或 [⬅️][2/50][➡️][⏭]），精准排除首尾页与上一页干扰；
 * 2. 自动检测当前消息实际所处页码；
 * 3. 建立「我方发出的查询消息 (Outbox Query) ↔ 机器人回复的分页消息 (Inbox Bot Reply)」因果绑定；
 * 4. 从单页富文本 Entities、裸链接与按钮中提取 t.me 候选群组/频道/深链。
 */
import type { BotHarvestCandidateItem } from '../../../../stores/archive/types';
import type { TgInlineButton, TgMessageDto } from '../../chatProtocol';

const NEXT_BUTTON_REGEX = /(?:下[一]?页|next|▶|➡|➡️|👉|»|>|›)/i;
const PREV_OR_BOUND_BUTTON_REGEX = /(?:上[一]?页|回?到?首页|第一页|回?到?末页|尾页|最后一页|prev|previous|first|last|⏮|⏭|⏪|⬅)/i;

/**
 * 判断内联键盘是否包含搜索机器人的翻页按钮
 */
export function hasBotPaginationControls(rows: TgInlineButton[][]): boolean {
  for (const row of rows) {
    for (const btn of row) {
      if (
        btn.kind === 'callback' &&
        btn.data &&
        !PREV_OR_BOUND_BUTTON_REGEX.test(btn.text) &&
        NEXT_BUTTON_REGEX.test(btn.text)
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * 自动从按钮或消息正文中探测当前所处的实际页码（如 "2/30"、"第 2 页"、"[2]"）
 */
export function detectCurrentBotPage(msg: TgMessageDto | undefined): number | null {
  if (!msg) return null;
  if (msg.replyMarkup) {
    for (const row of msg.replyMarkup) {
      for (const btn of row) {
        const text = btn.text.trim();
        const slashMatch = /^(?:第\s*)?(\d{1,3})\s*\/\s*\d{1,4}(?:\s*页)?$/.exec(text);
        if (slashMatch) return Number(slashMatch[1]);
        const currentBracketMatch = /^(?:\[|【|·|\*)\s*(\d{1,3})\s*(?:\]|】|·|\*)$/.exec(text);
        if (currentBracketMatch) return Number(currentBracketMatch[1]);
      }
    }
  }
  const bodyMatch = /(?:当前第|第)\s*(\d{1,3})\s*(?:\/\s*\d+\s*)?页|page\s+(\d{1,3})\s+of\s+\d+/i.exec(msg.text || '');
  if (bodyMatch) {
    return Number(bodyMatch[1] ?? bodyMatch[2]);
  }
  return null;
}

/**
 * 在 2/3/4 按钮翻页矩阵中精准定位「下一页」按钮（排除「回到首页 / 上一页 / 回到末页」）
 */
export function findNextBotPageButton(
  rows: TgInlineButton[][],
  nextPageNum: number,
): TgInlineButton | null {
  // 1. 优先匹配明确的「下一页」按钮（排除含首页/末页/上一页字样的按钮）
  for (const row of rows) {
    for (const btn of row) {
      const label = btn.text.trim();
      if (
        btn.kind === 'callback' &&
        btn.data &&
        !PREV_OR_BOUND_BUTTON_REGEX.test(label) &&
        NEXT_BUTTON_REGEX.test(label)
      ) {
        return btn;
      }
    }
  }

  // 2. 备选：匹配数字页码按钮（如 "2" 或 "第2页"）
  for (const row of rows) {
    for (const btn of row) {
      const label = btn.text.trim();
      if (
        btn.kind === 'callback' &&
        btn.data &&
        (label === String(nextPageNum) || label === `第${nextPageNum}页`)
      ) {
        return btn;
      }
    }
  }
  return null;
}

/**
 * 关联「我们发出的查询消息 (Outbox) ↔ 机器人回复的分页消息 (Inbox)」：
 * 1. 优先按 replyToId 查找对应的发出消息；
 * 2. 若机器人未带 replyToId，则在当前会话消息窗口中逆序回溯紧邻该机器人消息之前的我方发出消息 (m.out && m.id < botMsg.id)；
 * 3. 若仍未找到，则回退到该会话最近一次发送记录或机器人消息首行关键词。
 */
export function resolvePairedQueryForBotMessage(
  botMsg: TgMessageDto | undefined,
  windowMessages: TgMessageDto[],
  fallbackLastQuery?: string,
): { queryText: string; queryMsgId?: number } {
  if (botMsg) {
    // 1. 显式 replyToId 关联
    if (botMsg.replyToId) {
      const replied = windowMessages.find((m) => m.id === botMsg.replyToId);
      if (replied && replied.text.trim()) {
        return {
          queryText: replied.text.trim().slice(0, 48),
          queryMsgId: replied.id,
        };
      }
    }

    // 2. 窗口逆序回溯紧邻机器人回复之前的我方发出消息
    for (let i = windowMessages.length - 1; i >= 0; i--) {
      const candidate = windowMessages[i]!;
      if (candidate.id < botMsg.id && candidate.out && candidate.text.trim()) {
        const clean = candidate.text.trim();
        if (!clean.startsWith('/start')) {
          return {
            queryText: clean.slice(0, 48),
            queryMsgId: candidate.id,
          };
        }
      }
    }

    // 3. 从机器人正文首行提取「关键词：xxx」或「搜索：xxx」
    const firstLine = (botMsg.text || '').split(/\r?\n/)[0]?.trim() ?? '';
    const kwMatch = /(?:关键词|关键字|搜索词|查询|search|keyword)[：:\s]+([^\s|｜，,]+)/i.exec(firstLine);
    if (kwMatch?.[1]) {
      return { queryText: kwMatch[1].slice(0, 48) };
    }
  }

  if (fallbackLastQuery?.trim()) {
    return { queryText: fallbackLastQuery.trim().slice(0, 48) };
  }

  return { queryText: '当前页检索' };
}

/**
 * 从单页机器人消息的文本、Entities 及内联按钮提取 t.me 链接候选条目
 */
export function extractBotCandidatesFromMessage(
  msg: TgMessageDto,
  pageNum: number,
): BotHarvestCandidateItem[] {
  const found: BotHarvestCandidateItem[] = [];
  const lines = (msg.text || '').split(/\r?\n/);

  const addRawUrl = (url: string, labelHint: string) => {
    const cleanUrl = url.trim();
    const inviteMatch = /(?:https?:\/\/)?(?:t\.me|telegram\.me)\/(?:\+|joinchat\/)([a-zA-Z0-9_-]+)/i.exec(cleanUrl);
    if (inviteMatch) {
      const hash = inviteMatch[1]!;
      found.push({
        key: `invite-${hash}`,
        title: labelHint || `私有群组/频道 (+${hash.slice(0, 6)})`,
        inviteHash: hash,
        kind: 'invite_hash',
        sourcePage: pageNum,
        sourceTextSnippet: `https://t.me/+${hash}`,
        alreadyInExplore: false,
        alreadyJoined: false,
        selected: true,
      });
      return;
    }

    const msgMatch = /(?:https?:\/\/)?(?:t\.me|telegram\.me)\/([a-zA-Z][a-zA-Z0-9_]{3,31})\/(\d+)/i.exec(cleanUrl);
    if (msgMatch) {
      const username = msgMatch[1]!;
      const messageId = Number(msgMatch[2]);
      found.push({
        key: `msg-${username}-${messageId}`,
        title: labelHint || `@${username} #${messageId}`,
        username,
        startParam: String(messageId),
        kind: 'deep_link',
        sourcePage: pageNum,
        sourceTextSnippet: `https://t.me/${username}/${messageId}`,
        alreadyInExplore: false,
        alreadyJoined: false,
        selected: true,
      });
      return;
    }

    const userMatch =
      /(?:https?:\/\/)?(?:t\.me|telegram\.me)\/(?!joinchat\/|\+|c\/|addstickers\/|proxy\b|share\/)([a-zA-Z][a-zA-Z0-9_]{3,31})/i.exec(
        cleanUrl,
      );
    if (userMatch) {
      const username = userMatch[1]!;
      found.push({
        key: `peer-${username.toLowerCase()}`,
        title: labelHint || `@${username}`,
        username,
        kind: 'username',
        sourcePage: pageNum,
        sourceTextSnippet: `https://t.me/${username}`,
        alreadyInExplore: false,
        alreadyJoined: false,
        selected: true,
      });
    }
  };

  if (msg.entities) {
    for (const ent of msg.entities) {
      const snippet = msg.text.slice(ent.offset, ent.offset + ent.length).trim();
      const line = lines.find((l) => l.includes(snippet))?.replace(/https?:\/\/\S+/g, '').trim() || snippet;
      if (ent.type === 'textUrl' && ent.url) {
        addRawUrl(ent.url, line || snippet);
      } else if (ent.type === 'url') {
        addRawUrl(snippet, line);
      } else if (ent.type === 'mention' && snippet.startsWith('@') && snippet.length >= 5) {
        addRawUrl(`https://t.me/${snippet.slice(1)}`, line || snippet);
      }
    }
  }

  const rawUrlRegex = /https?:\/\/(?:t\.me|telegram\.me)\/[^\s<>")]+/gi;
  let match: RegExpExecArray | null;
  while ((match = rawUrlRegex.exec(msg.text || '')) !== null) {
    const url = match[0];
    const line = lines.find((l) => l.includes(url))?.replace(url, '').trim() || url;
    addRawUrl(url, line);
  }

  if (msg.replyMarkup) {
    for (const row of msg.replyMarkup) {
      for (const btn of row) {
        if (btn.url) addRawUrl(btn.url, btn.text);
      }
    }
  }

  return found;
}
