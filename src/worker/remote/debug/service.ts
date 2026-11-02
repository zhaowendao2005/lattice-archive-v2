/**
 * ============================================================================
 * 远端调试快照与 Agent 四阶渐进式日志查询服务 (src/worker/remote/debug/service.ts)
 * ============================================================================
 */
import { hashSessionToken } from '../auth/crypto';
import { AuthError } from '../auth/types';
import {
  deleteAgentKeyById,
  deleteSnapshotById,
  findAgentKeyByHash,
  findSnapshotMetaById,
  insertAgentKey,
  insertSnapshotChunks,
  listKeysByUser,
  listSnapshotChunksByUser,
  listSnapshotMetaByUser,
  snapshotIdExists,
  touchAgentKeyLastUsed,
} from './repository';
import {
  DEBUG_SNAPSHOT_CHUNK_CHARS,
  DEBUG_SNAPSHOT_MAX_ENTRIES,
  DEBUG_SNAPSHOT_MAX_ROW_BYTES,
  DEBUG_SNAPSHOT_MAX_TOTAL_B64_CHARS,
  type AgentDebugKeyDto,
  type AgentDebugKeyRow,
  type AgentKeyTtlPreset,
  type AgentQueryMode,
  type DebugSnapshotChunkRow,
  type DebugSnapshotMeta,
  type LatticeLogEntry,
} from './types';

const TTL_MS_BY_PRESET: Record<AgentKeyTtlPreset, number> = {
  '1h': 3600_000,
  '24h': 24 * 3600_000,
  '7d': 7 * 24 * 3600_000,
  '30d': 30 * 24 * 3600_000,
  never: 0,
};

function toKeyDto(row: AgentDebugKeyRow, now = Date.now()): AgentDebugKeyDto {
  return {
    id: row.id,
    name: row.name,
    keyPrefix: row.key_prefix,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    expired: row.expires_at > 0 && row.expires_at <= now,
  };
}

function randomHex(byteLen: number): string {
  const bytes = new Uint8Array(byteLen);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

/** 将任意长度的 Base64 载荷按单行预算切成连续分片；预算按 4 字符对齐，保证拼接后仍是合法 Base64。 */
function splitBase64Payload(b64: string): string[] {
  const chunks: string[] = [];
  for (let offset = 0; offset < b64.length; offset += DEBUG_SNAPSHOT_CHUNK_CHARS) {
    chunks.push(b64.slice(offset, offset + DEBUG_SNAPSHOT_CHUNK_CHARS));
  }
  return chunks;
}

/** 解压后的 JSON 上限，防止高压缩比载荷变成解压炸弹。 */
const MAX_DECOMPRESSED_BYTES = 32_000_000;

async function readLimitedText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_DECOMPRESSED_BYTES) {
        await reader.cancel();
        throw new AuthError('INVALID_REQUEST', '日志快照解压后体积超限', 400);
      }
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    merged.set(part, offset);
    offset += part.byteLength;
  }
  return new TextDecoder().decode(merged);
}

/** 解码并解压快照载荷，返回原始 JSON 数组；gzip 与无 CompressionStream 时的原始 JSON fallback 都兼容。 */
async function decodeBytesToEntries(bytes: Uint8Array): Promise<unknown[]> {
  let text: string;
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    if (typeof DecompressionStream === 'undefined') {
      throw new AuthError('INVALID_REQUEST', '当前运行环境不支持解压日志快照', 400);
    }
    const ab = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(ab).set(bytes);
    const stream = new Blob([ab]).stream().pipeThrough(new DecompressionStream('gzip'));
    text = await readLimitedText(stream);
  } else {
    text = new TextDecoder().decode(bytes);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new AuthError('INVALID_REQUEST', '日志快照内容不是合法的 JSON', 400);
  }
  if (!Array.isArray(parsed)) {
    throw new AuthError('INVALID_REQUEST', '日志快照必须是日志数组', 400);
  }
  return parsed;
}

async function decodeBase64ToEntries(b64: string): Promise<unknown[]> {
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(b64);
  } catch {
    throw new AuthError('INVALID_REQUEST', '日志快照不是合法的 Base64 数据', 400);
  }
  return decodeBytesToEntries(bytes);
}

const DEBUG_LOG_SOURCES = new Set(['local', 'remote', 'frontend']);
const DEBUG_LOG_LEVELS = new Set(['DEBUG', 'INFO', 'WARN', 'ERROR']);

/** 只保留查询引擎实际依赖的字段，挡住会让时间线格式化崩溃的坏数据。 */
function normalizeEntries(raw: unknown[]): LatticeLogEntry[] {
  if (raw.length === 0) {
    throw new AuthError('INVALID_REQUEST', '日志快照不能为空', 400);
  }
  if (raw.length > DEBUG_SNAPSHOT_MAX_ENTRIES) {
    throw new AuthError('INVALID_REQUEST', `单条快照最多包含 ${DEBUG_SNAPSHOT_MAX_ENTRIES} 条日志`, 400);
  }

  return raw.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new AuthError('INVALID_REQUEST', '日志快照包含非法条目', 400);
    }
    const entry = item as Record<string, unknown>;
    const stringFields = ['id', 'traceId', 'spanId', 'domain', 'action'] as const;
    for (const field of stringFields) {
      if (typeof entry[field] !== 'string' || !(entry[field] as string).trim()) {
        throw new AuthError('INVALID_REQUEST', `日志条目缺少有效字段 ${field}`, 400);
      }
    }
    if (
      typeof entry.timestamp !== 'number' ||
      !Number.isFinite(entry.timestamp) ||
      entry.timestamp < 0 ||
      entry.timestamp > 8_640_000_000_000_000
    ) {
      throw new AuthError('INVALID_REQUEST', '日志条目时间戳无效', 400);
    }
    if (!DEBUG_LOG_SOURCES.has(String(entry.source))) {
      throw new AuthError('INVALID_REQUEST', '日志条目来源无效', 400);
    }
    if (!DEBUG_LOG_LEVELS.has(String(entry.level))) {
      throw new AuthError('INVALID_REQUEST', '日志条目级别无效', 400);
    }
    if (typeof entry.relMs !== 'number' || !Number.isFinite(entry.relMs)) {
      entry.relMs = 0;
    }
    return entry as unknown as LatticeLogEntry;
  });
}

function toSnapshotMeta(row: DebugSnapshotChunkRow): DebugSnapshotMeta {
  return {
    snapshotId: row.snapshot_id,
    entryCount: row.entry_count,
    minTime: row.min_time,
    maxTime: row.max_time,
    sizeChars: row.total_size_chars,
    sizeBytes: row.total_bytes,
    chunkCount: row.chunk_count,
    createdAt: row.created_at,
    updatedAt: row.created_at,
    maxRowBytes: DEBUG_SNAPSHOT_MAX_ROW_BYTES,
  };
}

interface TimelineEntry {
  entry: LatticeLogEntry;
  createdAt: number;
  sequence: number;
}

interface LoadedSnapshotEntries {
  entries: LatticeLogEntry[];
  snapshotCount: number;
  invalidSnapshotCount: number;
  latestCreatedAt: number;
}

/** 读取当前账号全部快照，按整体时间线合并；单条损坏快照只跳过并计数，不阻塞其余查询。 */
async function loadUserSnapshotEntries(
  db: D1Database,
  userId: string,
): Promise<LoadedSnapshotEntries> {
  const rows = await listSnapshotChunksByUser(db, userId);
  if (rows.length === 0) {
    return { entries: [], snapshotCount: 0, invalidSnapshotCount: 0, latestCreatedAt: 0 };
  }

  const grouped = new Map<string, DebugSnapshotChunkRow[]>();
  for (const row of rows) {
    const list = grouped.get(row.snapshot_id) ?? [];
    list.push(row);
    grouped.set(row.snapshot_id, list);
  }

  const timeline: TimelineEntry[] = [];
  const seenEntryIds = new Set<string>();
  let invalidSnapshotCount = 0;
  let latestCreatedAt = 0;

  for (const chunks of grouped.values()) {
    chunks.sort((a, b) => a.chunk_index - b.chunk_index);
    const createdAt = chunks[0]?.created_at ?? 0;
    latestCreatedAt = Math.max(latestCreatedAt, createdAt);

    const expectedChunkCount = chunks[0]?.chunk_count ?? 0;
    const contiguous =
      chunks.length === expectedChunkCount &&
      chunks.every((chunk, index) => chunk.chunk_index === index);
    if (!contiguous) {
      invalidSnapshotCount += 1;
      continue;
    }

    try {
      const raw = await decodeBase64ToEntries(chunks.map((chunk) => chunk.chunk_gzip_b64).join(''));
      const entries = normalizeEntries(raw);
      entries.forEach((entry, sequence) => {
        // 上传响应丢失后的重试可能让同一条日志落进多条快照；合并时间线时按条目 ID 去重。
        if (seenEntryIds.has(entry.id)) return;
        seenEntryIds.add(entry.id);
        timeline.push({ entry, createdAt, sequence });
      });
    } catch {
      invalidSnapshotCount += 1;
    }
  }

  timeline.sort(
    (a, b) =>
      a.entry.timestamp - b.entry.timestamp ||
      a.createdAt - b.createdAt ||
      a.sequence - b.sequence,
  );

  return {
    entries: timeline.map((item) => item.entry),
    snapshotCount: grouped.size,
    invalidSnapshotCount,
    latestCreatedAt,
  };
}

export function formatEntryGrepLine(entry: LatticeLogEntry): string {
  const iso = new Date(entry.timestamp).toISOString();
  const durPart = entry.durMs !== undefined ? `[dur:${entry.durMs}ms]` : '';
  const srcUpper = entry.source.toUpperCase();
  const tagPairs = entry.tags
    ? Object.entries(entry.tags)
        .map(([k, v]) => `${k}=${typeof v === 'string' && /\s/.test(v) ? `"${v}"` : String(v)}`)
        .join(' ')
    : '';
  const msgPart = entry.message ? `msg="${entry.message}" ` : '';
  const tail = `${msgPart}${tagPairs}`.trim();
  return `[LATTICE][T:${entry.traceId}][S:${entry.spanId}][${iso}][+${entry.relMs}ms]${durPart}[${entry.level}][${srcUpper}:${entry.domain}] ${entry.action}${tail ? ` | ${tail}` : ''}`;
}

function parseTimeBound(
  raw: string | null,
  minTime: number,
  maxTime: number,
): number | null {
  if (!raw || !raw.trim()) return null;
  const s = raw.trim();

  // Relative to maxTime: e.g. -5m, -30s, -2h, -5000ms
  const negRel = /^-(\d+(?:\.\d+)?)(ms|s|m|h)$/i.exec(s);
  if (negRel) {
    const val = Number(negRel[1]);
    const unit = negRel[2]!.toLowerCase();
    const mult = unit === 'h' ? 3600_000 : unit === 'm' ? 60_000 : unit === 's' ? 1000 : 1;
    return maxTime - Math.round(val * mult);
  }

  // Relative to minTime: e.g. +1200ms, +10s
  const posRel = /^\+(\d+(?:\.\d+)?)(ms|s|m|h)$/i.exec(s);
  if (posRel) {
    const val = Number(posRel[1]);
    const unit = posRel[2]!.toLowerCase();
    const mult = unit === 'h' ? 3600_000 : unit === 'm' ? 60_000 : unit === 's' ? 1000 : 1;
    return minTime + Math.round(val * mult);
  }

  if (/^\d{10,13}$/.test(s)) {
    const n = Number(s);
    return s.length === 10 ? n * 1000 : n;
  }

  const parsedDate = Date.parse(s);
  return Number.isNaN(parsedDate) ? null : parsedDate;
}

export async function listUserAgentKeys(
  env: Env,
  userId: string,
): Promise<{ keys: AgentDebugKeyDto[] }> {
  const rows = await listKeysByUser(env.AUTH_DB, userId);
  const now = Date.now();
  return { keys: rows.map((r) => toKeyDto(r, now)) };
}

export async function createUserAgentKey(
  env: Env,
  userId: string,
  body: Record<string, unknown>,
): Promise<{ rawKey: string; key: AgentDebugKeyDto }> {
  const name = typeof body.name === 'string' && body.name.trim()
    ? body.name.trim().slice(0, 64)
    : 'Agent 调试密钥';
  const presetRaw = String(body.ttlPreset ?? '24h') as AgentKeyTtlPreset;
  const ttlMs = presetRaw in TTL_MS_BY_PRESET ? TTL_MS_BY_PRESET[presetRaw] : TTL_MS_BY_PRESET['24h'];

  const rawKey = `lat_agk_${randomHex(20)}`;
  const keyHash = await hashSessionToken(rawKey);
  const now = Date.now();
  const expiresAt = ttlMs > 0 ? now + ttlMs : 0;
  const row: AgentDebugKeyRow = {
    id: `agk_${randomHex(8)}`,
    user_id: userId,
    name,
    key_prefix: `${rawKey.slice(0, 14)}…${rawKey.slice(-4)}`,
    key_hash: keyHash,
    expires_at: expiresAt,
    created_at: now,
    last_used_at: 0,
  };

  await insertAgentKey(env.AUTH_DB, row);
  return {
    rawKey,
    key: toKeyDto(row, now),
  };
}

export async function revokeUserAgentKey(
  env: Env,
  userId: string,
  keyId: string,
): Promise<{ ok: true }> {
  await deleteAgentKeyById(env.AUTH_DB, userId, keyId);
  return { ok: true };
}

/** 设置页/上传响应使用的快照 ID 规则；legacy_ 前缀只用于迁移出来的历史快照。 */
const SNAPSHOT_ID_PATTERN = /^snap_[a-f0-9]{32}$/i;
const SNAPSHOT_DELETE_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,160}$/;

export async function listUserDebugSnapshots(
  env: Env,
  userId: string,
): Promise<{ snapshots: DebugSnapshotMeta[] }> {
  const rows = await listSnapshotMetaByUser(env.AUTH_DB, userId);
  return { snapshots: rows.map(toSnapshotMeta) };
}

export async function deleteUserDebugSnapshot(
  env: Env,
  userId: string,
  snapshotId: string,
): Promise<{ ok: true; deleted: boolean }> {
  if (!SNAPSHOT_DELETE_ID_PATTERN.test(snapshotId)) {
    throw new AuthError('INVALID_REQUEST', '快照标识无效', 400);
  }
  const deleted = await deleteSnapshotById(env.AUTH_DB, userId, snapshotId);
  return { ok: true, deleted };
}

/**
 * 创建一条新的日志快照记录。
 * 兼容旧版单字段 snapshotGzipB64：服务端按同一分片预算自动拆分，避免旧客户端上传失败。
 */
export async function saveUserDebugSnapshot(
  env: Env,
  userId: string,
  body: Record<string, unknown>,
): Promise<DebugSnapshotMeta> {
  const isChunkUpload = Array.isArray(body.chunks);
  let chunks: string[];

  if (isChunkUpload) {
    chunks = (body.chunks as unknown[]).map((chunk) => {
      if (typeof chunk !== 'string') {
        throw new AuthError('INVALID_REQUEST', '日志快照分片格式无效', 400);
      }
      return chunk.trim();
    });
  } else {
    const legacy = typeof body.snapshotGzipB64 === 'string' ? body.snapshotGzipB64.trim() : '';
    chunks = legacy ? splitBase64Payload(legacy) : [];
  }

  if (chunks.length === 0) {
    throw new AuthError('INVALID_REQUEST', '日志快照不能为空', 400);
  }

  let totalChars = 0;
  chunks.forEach((chunk, index) => {
    if (!chunk) {
      throw new AuthError('INVALID_REQUEST', '日志快照包含空分片', 400);
    }
    if (chunk.length > DEBUG_SNAPSHOT_CHUNK_CHARS) {
      throw new AuthError('INVALID_REQUEST', '单个日志快照分片超出 D1 单行安全上限', 400);
    }
    if (index < chunks.length - 1 && chunk.length !== DEBUG_SNAPSHOT_CHUNK_CHARS) {
      throw new AuthError(
        'INVALID_REQUEST',
        '除最后一片外，每个日志快照分片必须填满单行预算，以减少 D1 行数',
        400,
      );
    }
    totalChars += chunk.length;
  });

  if (totalChars > DEBUG_SNAPSHOT_MAX_TOTAL_B64_CHARS) {
    throw new AuthError(
      'INVALID_REQUEST',
      `日志快照体积超出上限（${DEBUG_SNAPSHOT_MAX_TOTAL_B64_CHARS} Base64 字符），请减少日志范围后重试`,
      400,
    );
  }
  if (totalChars % 4 !== 0) {
    throw new AuthError('INVALID_REQUEST', '日志快照 Base64 长度不是 4 的倍数', 400);
  }
  if (typeof body.chunkCount === 'number' && Math.floor(body.chunkCount) !== chunks.length) {
    throw new AuthError('INVALID_REQUEST', '日志快照分片数量不一致', 400);
  }

  const combined = chunks.join('');
  let payloadBytes: Uint8Array;
  try {
    payloadBytes = base64ToBytes(combined);
  } catch {
    throw new AuthError('INVALID_REQUEST', '日志快照不是合法的 Base64 数据', 400);
  }
  const entries = normalizeEntries(await decodeBytesToEntries(payloadBytes));

  let computedMinTime = Number.POSITIVE_INFINITY;
  let computedMaxTime = Number.NEGATIVE_INFINITY;
  for (const entry of entries) {
    computedMinTime = Math.min(computedMinTime, entry.timestamp);
    computedMaxTime = Math.max(computedMaxTime, entry.timestamp);
  }

  if (isChunkUpload) {
    if (typeof body.entryCount === 'number' && Math.floor(body.entryCount) !== entries.length) {
      throw new AuthError('INVALID_REQUEST', '日志条数与快照内容不一致', 400);
    }
    if (typeof body.minTime === 'number' && Math.floor(body.minTime) !== computedMinTime) {
      throw new AuthError('INVALID_REQUEST', '日志起始时间与快照内容不一致', 400);
    }
    if (typeof body.maxTime === 'number' && Math.floor(body.maxTime) !== computedMaxTime) {
      throw new AuthError('INVALID_REQUEST', '日志结束时间与快照内容不一致', 400);
    }
  }

  const snapshotIdRaw = typeof body.snapshotId === 'string' ? body.snapshotId.trim() : '';
  if (snapshotIdRaw && !SNAPSHOT_ID_PATTERN.test(snapshotIdRaw)) {
    throw new AuthError('INVALID_REQUEST', '快照标识格式无效', 400);
  }
  const snapshotId = snapshotIdRaw || `snap_${randomHex(16)}`;
  const createdAt = Date.now();

  const existing = await findSnapshotMetaById(env.AUTH_DB, userId, snapshotId);
  if (existing) {
    const samePayload =
      existing.chunk_count === chunks.length &&
      existing.total_size_chars === totalChars &&
      existing.total_bytes === payloadBytes.length &&
      existing.entry_count === entries.length;
    if (samePayload) {
      return toSnapshotMeta(existing);
    }
    throw new AuthError('SNAPSHOT_CONFLICT', '该快照标识已存在且内容不同，请重新生成后重试', 409);
  }
  if (await snapshotIdExists(env.AUTH_DB, snapshotId)) {
    throw new AuthError('SNAPSHOT_CONFLICT', '快照标识冲突，请重新生成后重试', 409);
  }

  const rows: DebugSnapshotChunkRow[] = chunks.map((chunk, index) => ({
    snapshot_id: snapshotId,
    chunk_index: index,
    user_id: userId,
    chunk_gzip_b64: chunk,
    chunk_count: chunks.length,
    total_size_chars: totalChars,
    total_bytes: payloadBytes.length,
    entry_count: entries.length,
    min_time: computedMinTime,
    max_time: computedMaxTime,
    created_at: createdAt,
  }));

  await insertSnapshotChunks(env.AUTH_DB, rows);

  return toSnapshotMeta(rows[0]!);
}

export async function authenticateAgentKey(
  request: Request,
  env: Env,
): Promise<AgentDebugKeyRow> {
  const url = new URL(request.url);
  const header = request.headers.get('Authorization');
  const bearer = header?.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const queryKey = url.searchParams.get('key')?.trim() ?? '';
  const rawKey = bearer || queryKey;

  if (!rawKey || !rawKey.startsWith('lat_agk_') || rawKey.length > 128) {
    throw new AuthError('UNAUTHORIZED', '缺少有效的 Agent 访问密钥 (lat_agk_...)', 401);
  }

  const keyHash = await hashSessionToken(rawKey);
  const row = await findAgentKeyByHash(env.AUTH_DB, keyHash);
  const now = Date.now();
  if (!row || (row.expires_at > 0 && row.expires_at <= now)) {
    throw new AuthError('UNAUTHORIZED', 'Agent 访问密钥无效或已过期，请在设置页重新生成', 401);
  }

  await touchAgentKeyLastUsed(env.AUTH_DB, row.id, now);
  return row;
}

/**
 * 四阶渐进式日志查询引擎（支持 overview / timeline / grep / trace 与时间区间过滤）
 */
export async function executeProgressiveAgentQuery(
  env: Env,
  userId: string,
  params: URLSearchParams,
): Promise<Record<string, unknown>> {
  const loaded = await loadUserSnapshotEntries(env.AUTH_DB, userId);
  if (loaded.snapshotCount === 0) {
    return {
      ok: true,
      hasSnapshot: false,
      message: '当前尚无已上传的运行日志快照。请在网页端「设置 -> 开发者选项」点亮采集标签并点击「手动同步」或「复制 Agent 凭证」。',
    };
  }

  const allEntries = loaded.entries;
  const minTime = allEntries[0]?.timestamp ?? 0;
  const maxTime = allEntries[allEntries.length - 1]?.timestamp ?? 0;

  const fromBound = parseTimeBound(params.get('from'), minTime, maxTime);
  const toBound = parseTimeBound(params.get('to'), minTime, maxTime);

  const sourceFilterRaw = params.get('source')?.trim().toLowerCase() ?? '';
  const sourceSet = sourceFilterRaw
    ? new Set(sourceFilterRaw.split(',').map((s) => s.trim()).filter(Boolean))
    : null;

  const domainPrefix = params.get('domain')?.trim().toLowerCase().replace(/^\/?(?:local|remote|frontend)\//, '') ?? '';

  const levelFilterRaw = params.get('level')?.trim().toUpperCase() ?? '';
  const levelSet = levelFilterRaw
    ? new Set(levelFilterRaw.split(',').map((s) => s.trim()).filter(Boolean))
    : null;

  const filtered = allEntries.filter((e) => {
    if (fromBound !== null && e.timestamp < fromBound) return false;
    if (toBound !== null && e.timestamp > toBound) return false;
    if (sourceSet && !sourceSet.has(e.source)) return false;
    if (domainPrefix && !e.domain.toLowerCase().startsWith(domainPrefix)) return false;
    if (levelSet && !levelSet.has(e.level)) return false;
    return true;
  });

  const modeRaw = (params.get('mode')?.trim().toLowerCase() || 'overview');
  const mode: AgentQueryMode = (
    ['overview', 'timeline', 'grep', 'trace'] as const
  ).includes(modeRaw as AgentQueryMode)
    ? (modeRaw as AgentQueryMode)
    : 'overview';
  const limitRaw = Number(params.get('limit') ?? 80);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(500, Math.floor(limitRaw))) : 80;
  const offsetRaw = Number(params.get('offset') ?? 0);
  const offset = Number.isFinite(offsetRaw) ? Math.max(0, Math.floor(offsetRaw)) : 0;

  // Mode 1: overview (类似 ls -la / 根目录结构与热点概览)
  if (mode === 'overview') {
    const dirMap = new Map<
      string,
      {
        path: string;
        source: string;
        domain: string;
        entries: number;
        warns: number;
        errors: number;
        firstTime: string;
        lastTime: string;
        actions: Set<string>;
      }
    >();

    const anomalies: { traceId: string; level: string; time: string; path: string; action: string; line: string }[] = [];

    for (const e of filtered) {
      const path = `/${e.source}/${e.domain}`;
      let stat = dirMap.get(path);
      const iso = new Date(e.timestamp).toISOString();
      if (!stat) {
        stat = {
          path,
          source: e.source,
          domain: e.domain,
          entries: 0,
          warns: 0,
          errors: 0,
          firstTime: iso,
          lastTime: iso,
          actions: new Set(),
        };
        dirMap.set(path, stat);
      }
      stat.entries += 1;
      stat.lastTime = iso;
      stat.actions.add(e.action);
      if (e.level === 'WARN') stat.warns += 1;
      if (e.level === 'ERROR') stat.errors += 1;
      if ((e.level === 'WARN' || e.level === 'ERROR') && anomalies.length < 25) {
        anomalies.push({
          traceId: e.traceId,
          level: e.level,
          time: iso,
          path,
          action: e.action,
          line: formatEntryGrepLine(e),
        });
      }
    }

    const directories = Array.from(dirMap.values())
      .sort((a, b) => b.errors - a.errors || b.warns - a.warns || b.entries - a.entries)
      .map((d) => ({
        path: d.path,
        source: d.source,
        domain: d.domain,
        entries: d.entries,
        warns: d.warns,
        errors: d.errors,
        firstTime: d.firstTime,
        lastTime: d.lastTime,
        actions: Array.from(d.actions).slice(0, 12),
      }));

    return {
      ok: true,
      mode: 'overview',
      snapshotUpdatedAt: loaded.latestCreatedAt
        ? new Date(loaded.latestCreatedAt).toISOString()
        : null,
      snapshotCount: loaded.snapshotCount,
      invalidSnapshotCount: loaded.invalidSnapshotCount,
      totalEntriesInSnapshot: allEntries.length,
      matchedEntriesInWindow: filtered.length,
      timeWindow: {
        minTimeMs: minTime,
        maxTimeMs: maxTime,
        minTimeIso: minTime ? new Date(minTime).toISOString() : null,
        maxTimeIso: maxTime ? new Date(maxTime).toISOString() : null,
        durationMs: Math.max(0, maxTime - minTime),
      },
      directories,
      recentAnomalies: anomalies,
      nextStepHints: [
        '浏览某业务域时间轴: ?mode=timeline&source=local&domain=chat.pts&limit=50',
        '使用 grep 检索关键词或标签: ?mode=grep&q=gap|BOT_RESPONSE_TIMEOUT|peer=',
        '展开某个 Trace 完整调用树: ?mode=trace&traceId=<traceId>',
      ],
    };
  }

  // Mode 2: timeline (按时间轴列出指定域/时间窗的紧凑索引)
  if (mode === 'timeline') {
    const childCountByTrace = new Map<string, number>();
    for (const e of allEntries) {
      childCountByTrace.set(e.traceId, (childCountByTrace.get(e.traceId) ?? 0) + 1);
    }

    const slice = filtered.slice(offset, offset + limit);
    return {
      ok: true,
      mode: 'timeline',
      snapshotCount: loaded.snapshotCount,
      invalidSnapshotCount: loaded.invalidSnapshotCount,
      totalMatched: filtered.length,
      offset,
      limit,
      hasMore: offset + limit < filtered.length,
      items: slice.map((e) => ({
        traceId: e.traceId,
        spanId: e.spanId,
        timestamp: e.timestamp,
        isoTime: new Date(e.timestamp).toISOString(),
        relMs: e.relMs,
        durMs: e.durMs,
        level: e.level,
        path: `/${e.source}/${e.domain}`,
        action: e.action,
        traceSpanCount: childCountByTrace.get(e.traceId) ?? 1,
        line: formatEntryGrepLine(e),
      })),
    };
  }

  // Mode 3: grep (结构化正则/子串检索)
  if (mode === 'grep') {
    const q = params.get('q')?.trim() ?? '';
    let regex: RegExp | null = null;
    if (q) {
      try {
        regex = new RegExp(q, 'i');
      } catch {
        regex = null;
      }
    }
    const qLower = q.toLowerCase();
    const hits = filtered.filter((e) => {
      if (!q) return true;
      const line = formatEntryGrepLine(e);
      if (regex) return regex.test(line);
      return line.toLowerCase().includes(qLower);
    });

    const slice = hits.slice(offset, offset + limit);
    return {
      ok: true,
      mode: 'grep',
      query: q,
      snapshotCount: loaded.snapshotCount,
      invalidSnapshotCount: loaded.invalidSnapshotCount,
      totalMatched: hits.length,
      offset,
      limit,
      hasMore: offset + limit < hits.length,
      matchedTraceIds: Array.from(new Set(slice.map((e) => e.traceId))),
      lines: slice.map((e) => formatEntryGrepLine(e)),
    };
  }

  // Mode 4: trace (展开指定 traceId 的完整父子分级树与时间轴)
  const traceIdsRaw = params.get('traceId')?.trim() ?? '';
  const targetTraceIds = traceIdsRaw
    ? new Set(traceIdsRaw.split(',').map((s) => s.trim()).filter(Boolean))
    : new Set(filtered.slice(-5).map((e) => e.traceId));

  const grouped = new Map<string, LatticeLogEntry[]>();
  for (const e of allEntries) {
    if (!targetTraceIds.has(e.traceId)) continue;
    const list = grouped.get(e.traceId) ?? [];
    list.push(e);
    grouped.set(e.traceId, list);
  }

  const trees: { traceId: string; spanCount: number; treeText: string; spans: LatticeLogEntry[] }[] = [];
  for (const [traceId, spans] of grouped.entries()) {
    spans.sort((a, b) => a.spanId.localeCompare(b.spanId) || a.timestamp - b.timestamp);
    const lines: string[] = [];
    spans.forEach((span, idx) => {
      const depth = Math.max(0, span.spanId.split('.').length - 1);
      const isLast = idx === spans.length - 1;
      const prefix =
        depth === 0
          ? '▼ '
          : `${'  '.repeat(depth - 1)}${isLast ? '└─ ' : '├─ '}`;
      lines.push(`${prefix}${formatEntryGrepLine(span)}`);
    });
    trees.push({
      traceId,
      spanCount: spans.length,
      treeText: lines.join('\n'),
      spans,
    });
  }

  return {
    ok: true,
    mode: 'trace',
    snapshotCount: loaded.snapshotCount,
    invalidSnapshotCount: loaded.invalidSnapshotCount,
    requestedTraceIds: Array.from(targetTraceIds),
    trees,
  };
}
