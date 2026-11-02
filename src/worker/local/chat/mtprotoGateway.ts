/**
 * ============================================================================
 * 本地 Worker MTProto 统一居中请求与 PTS 状态机网关 (mtprotoGateway.ts)
 * ============================================================================
 * 核心职责：
 * 1. 统一收口所有主动发起的 `client.invoke` 请求，集中采集耗时、参数摘要与结构化分级 Trace Span；
 * 2. 统一推进公共消息盒 `pts` 状态机（覆盖 UpdateShortSentMessage / Updates / AffectedHistory / AffectedMessages），
 *    彻底根治私聊/机器人发消息漏推进 pts 引发假性 Gap 重置窗口吞消息的问题；
 * 3. 统一归一化非致命异常（如搜索机器人只调 editMessageText 不调 answerCallbackQuery 引发的 BOT_RESPONSE_TIMEOUT）；
 * 4. 实时将结构化分级树状时间轴日志回传主线程（当 LOCAL 调试标签开启时）。
 */
import type { TelegramClient } from 'telegram';
import { Api } from 'telegram/tl';
import type { TgUpdatesState } from '../chatProtocol';
import type { TgDebugSpanEntry, TgLogLevel } from '../protocol';

export type LocalDebugEmitter = (entry: TgDebugSpanEntry) => void;

let debugEnabled = false;
let debugEmitter: LocalDebugEmitter | null = null;
let traceSeq = 0;

/** 参与公共消息盒 pts 连续性推进的 TL 更新构造器集合 */
export const COMMON_PTS_UPDATE_TYPES = [
  Api.UpdateNewMessage,
  Api.UpdateEditMessage,
  Api.UpdateDeleteMessages,
  Api.UpdateReadHistoryInbox,
  Api.UpdateReadHistoryOutbox,
  Api.UpdateReadMessagesContents,
  Api.UpdateWebPage,
  Api.UpdatePinnedMessages,
  Api.UpdateFolderPeers,
  Api.UpdateShortMessage,
  Api.UpdateShortChatMessage,
];

const SENSITIVE_TAG_KEYS = /session|hash|password|token|secret|authkey/i;

function sanitizeTags(
  tags?: Record<string, string | number | boolean | undefined>,
): Record<string, string | number | boolean> | undefined {
  if (!tags) return undefined;
  const cleaned: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(tags)) {
    if (v === undefined) continue;
    if (SENSITIVE_TAG_KEYS.test(k)) {
      cleaned[k] = '[REDACTED]';
    } else if (typeof v === 'string' && v.length > 120) {
      cleaned[k] = `${v.slice(0, 117)}...`;
    } else {
      cleaned[k] = v;
    }
  }
  return Object.keys(cleaned).length > 0 ? cleaned : undefined;
}

export function nextShortTraceId(): string {
  traceSeq = (traceSeq + 1) & 0xffff;
  const timePart = (Date.now() & 0xfffff).toString(16).padStart(5, '0');
  const seqPart = traceSeq.toString(16).padStart(3, '0');
  return `${timePart}${seqPart}`.slice(0, 6);
}

export function configureMtprotoGateway(options: {
  enabled?: boolean;
  emitter?: LocalDebugEmitter;
}): void {
  if (options.enabled !== undefined) debugEnabled = options.enabled;
  if (options.emitter !== undefined) debugEmitter = options.emitter;
}

export function isGatewayDebugEnabled(): boolean {
  return debugEnabled;
}

export function emitLocalSpan(params: {
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  domain: string;
  action: string;
  level?: TgLogLevel;
  timestamp?: number;
  relMs?: number;
  durMs?: number;
  message?: string;
  tags?: Record<string, string | number | boolean | undefined>;
}): void {
  if (!debugEnabled || !debugEmitter) return;
  const now = params.timestamp ?? Date.now();
  const traceId = params.traceId ?? nextShortTraceId();
  const spanId = params.spanId ?? '01';
  debugEmitter({
    id: `loc-${now}-${Math.random().toString(36).slice(2, 7)}`,
    traceId,
    spanId,
    parentSpanId: params.parentSpanId,
    source: 'local',
    domain: params.domain,
    action: params.action,
    level: params.level ?? 'INFO',
    timestamp: now,
    relMs: Math.max(0, Math.round(params.relMs ?? 0)),
    durMs: params.durMs !== undefined ? Math.max(0, Math.round(params.durMs)) : undefined,
    message: params.message,
    tags: sanitizeTags(params.tags),
  });
}

export interface LocalTraceContext {
  traceId: string;
  rootStartMs: number;
  childCount: number;
  childSpan(
    domain: string,
    action: string,
    tags?: Record<string, string | number | boolean | undefined>,
    level?: TgLogLevel,
    durMs?: number,
    parentSpanId?: string,
  ): string;
  finishRoot(
    tags?: Record<string, string | number | boolean | undefined>,
    level?: TgLogLevel,
  ): void;
}

export function startLocalTrace(
  domain: string,
  action: string,
  rootTags?: Record<string, string | number | boolean | undefined>,
): LocalTraceContext {
  const traceId = nextShortTraceId();
  const rootStartMs = Date.now();
  let childCount = 0;

  return {
    traceId,
    rootStartMs,
    get childCount() {
      return childCount;
    },
    childSpan(subDomain, subAction, tags, level = 'INFO', durMs, parentSpanId = '01') {
      childCount += 1;
      const spanId = `${parentSpanId}.${String(childCount).padStart(2, '0')}`;
      const now = Date.now();
      emitLocalSpan({
        traceId,
        spanId,
        parentSpanId,
        domain: subDomain,
        action: subAction,
        level,
        timestamp: now,
        relMs: now - rootStartMs,
        durMs,
        tags,
      });
      return spanId;
    },
    finishRoot(extraTags, level = 'INFO') {
      const now = Date.now();
      emitLocalSpan({
        traceId,
        spanId: '01',
        domain,
        action,
        level,
        timestamp: rootStartMs,
        relMs: 0,
        durMs: now - rootStartMs,
        tags: { ...rootTags, ...extraTags },
      });
    },
  };
}

/**
 * 统一推进公共消息盒的 pts 水位（适用于主动写 RPC 返回的 Updates / UpdateShortSentMessage / AffectedHistory 等）
 */
export function advancePtsFromRpcResult(
  state: TgUpdatesState | null,
  result: unknown,
  trace?: LocalTraceContext,
  sourceMethod = 'rpc',
): void {
  if (!state || !result) return;

  const applySinglePts = (pts: number, ptsCount: number, date?: number, label = sourceMethod) => {
    const oldPts = state.pts;
    if (pts > state.pts) {
      const contiguous = oldPts + ptsCount === pts;
      state.pts = pts;
      if (typeof date === 'number' && date > state.date) state.date = date;
      trace?.childSpan(
        'chat.pts',
        'advance_pts',
        {
          source: label,
          oldPts,
          newPts: pts,
          ptsCount,
          verdict: contiguous ? 'apply_contiguous' : 'adopt_outbox_pts',
        },
        'INFO',
      );
    }
  };

  // 1. 私聊/机器人发送消息返回的 UpdateShortSentMessage
  if (result instanceof Api.UpdateShortSentMessage) {
    applySinglePts(result.pts, result.ptsCount, result.date, 'UpdateShortSentMessage');
    return;
  }

  // 2. 删除历史/消息返回的 AffectedHistory / AffectedMessages
  if (
    result instanceof Api.messages.AffectedHistory ||
    result instanceof Api.messages.AffectedMessages
  ) {
    applySinglePts(result.pts, result.ptsCount, undefined, result.className);
    return;
  }

  // 3. 标准 Updates / UpdatesCombined 容器
  if (result instanceof Api.Updates || result instanceof Api.UpdatesCombined) {
    const ptsItems: { pts: number; ptsCount: number; className: string }[] = [];
    for (const item of result.updates) {
      if (COMMON_PTS_UPDATE_TYPES.some((t) => item instanceof t)) {
        const u = item as unknown as { pts?: number; ptsCount?: number; className?: string };
        if (typeof u.pts === 'number' && typeof u.ptsCount === 'number') {
          ptsItems.push({
            pts: u.pts,
            ptsCount: u.ptsCount,
            className: u.className ?? 'Update',
          });
        }
      }
    }
    ptsItems.sort((a, b) => a.pts - b.pts);
    for (const item of ptsItems) {
      applySinglePts(item.pts, item.ptsCount, result.date, item.className);
    }
    if (typeof result.date === 'number' && result.date > state.date) {
      state.date = result.date;
    }
    if (typeof result.seq === 'number' && result.seq > state.seq) {
      state.seq = result.seq;
    }
  }
}

export interface GatewayInvokeOptions {
  accountId?: string;
  peerKey?: string;
  state?: TgUpdatesState | null;
  advancePts?: boolean;
  trace?: LocalTraceContext;
  tags?: Record<string, string | number | boolean | undefined>;
}

/**
 * 统一居中管理的 MTProto RPC 调用入口
 */
export async function invokeWithGateway<R>(
  client: TelegramClient,
  query: Api.AnyRequest,
  options: GatewayInvokeOptions = {},
): Promise<R> {
  const methodName = (query as { className?: string }).className ?? 'mtproto.Invoke';
  const startMs = Date.now();
  const ownTrace =
    options.trace ??
    startLocalTrace('tg.gateway', methodName, {
      accountId: options.accountId,
      peer: options.peerKey,
      ...options.tags,
    });

  try {
    const result = (await client.invoke(query)) as R;
    const durMs = Date.now() - startMs;

    if (options.advancePts && options.state) {
      advancePtsFromRpcResult(options.state, result, ownTrace, methodName);
    }

    if (options.trace) {
      ownTrace.childSpan(
        'tg.gateway',
        'rpc_invoke',
        {
          method: methodName,
          peer: options.peerKey,
          ok: true,
          ...options.tags,
        },
        'INFO',
        durMs,
      );
    } else {
      ownTrace.finishRoot({ ok: true, durMs }, 'INFO');
    }

    return result;
  } catch (error) {
    const durMs = Date.now() - startMs;
    const rawCode = String(
      (error as { errorMessage?: string })?.errorMessage ??
        (error instanceof Error ? error.message : 'UNKNOWN'),
    ).toUpperCase();

    if (options.trace) {
      ownTrace.childSpan(
        'tg.gateway',
        'rpc_error',
        {
          method: methodName,
          peer: options.peerKey,
          code: rawCode,
          ...options.tags,
        },
        rawCode.includes('BOT_RESPONSE_TIMEOUT') ? 'WARN' : 'ERROR',
        durMs,
      );
    } else {
      ownTrace.finishRoot(
        { ok: false, code: rawCode, durMs },
        rawCode.includes('BOT_RESPONSE_TIMEOUT') ? 'WARN' : 'ERROR',
      );
    }
    throw error;
  }
}
