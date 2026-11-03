/**
 * ============================================================================
 * Local Worker 结构化 Span 日志（纯函数，不依赖 GramJS）
 * ============================================================================
 * 统一输出 `[LATTICE]` 树状时间轴日志：LOCAL 调试标签开启时经 debugLog 事件回传主线程。
 * 自动脱敏 session / hash / password / token 等字段，绝不输出 auth_key 与会话内容。
 */
import type { TgDebugSpanEntry, TgLogLevel } from '../../protocol';

export type LocalDebugEmitter = (entry: TgDebugSpanEntry) => void;

let debugEnabled = false;
let debugEmitter: LocalDebugEmitter | null = null;
let traceSeq = 0;

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

export function configureLocalSpans(options: {
  enabled?: boolean;
  emitter?: LocalDebugEmitter;
}): void {
  if (options.enabled !== undefined) debugEnabled = options.enabled;
  if (options.emitter !== undefined) debugEmitter = options.emitter;
}

export function isLocalSpanEnabled(): boolean {
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
