/**
 * ============================================================================
 * 远端调试快照与 Agent 渐进式日志检索类型定义 (src/worker/remote/debug/types.ts)
 * ============================================================================
 */

export type DebugLogSource = 'local' | 'remote' | 'frontend';
export type DebugLogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

export interface LatticeLogEntry {
  id: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  source: DebugLogSource;
  domain: string;
  action: string;
  level: DebugLogLevel;
  timestamp: number;
  relMs: number;
  durMs?: number;
  message?: string;
  tags?: Record<string, string | number | boolean>;
}

export interface AgentDebugKeyRow {
  id: string;
  user_id: string;
  name: string;
  key_prefix: string;
  key_hash: string;
  expires_at: number;
  created_at: number;
  last_used_at: number;
}

export interface AgentDebugKeyDto {
  id: string;
  name: string;
  keyPrefix: string;
  expiresAt: number;
  createdAt: number;
  lastUsedAt: number;
  expired: boolean;
}

/** D1 单行上限为 2,000,000 字节；此处为 Base64 分片预留约 100 KB 的列与行开销。 */
export const DEBUG_SNAPSHOT_MAX_ROW_BYTES = 1_900_000;
/** 实际切分步长：Base64 是 ASCII，字符数即字节数；按 4 字符对齐保证拼接后仍是合法 Base64。 */
export const DEBUG_SNAPSHOT_CHUNK_CHARS = Math.floor(DEBUG_SNAPSHOT_MAX_ROW_BYTES / 4) * 4;
/** 单次上传的总 Base64 载荷上限，防止 Worker 内存与请求体无限增长。 */
export const DEBUG_SNAPSHOT_MAX_TOTAL_B64_CHARS = 6_000_000;
/** 单条快照允许携带的日志条数上限（远高于当前 4,000 条环形缓冲区）。 */
export const DEBUG_SNAPSHOT_MAX_ENTRIES = 20_000;

/** 快照分片行：同一 snapshot_id 下按 chunk_index 连续排列，元数据在每个分片行重复保存。 */
export interface DebugSnapshotChunkRow {
  snapshot_id: string;
  chunk_index: number;
  user_id: string;
  chunk_gzip_b64: string;
  chunk_count: number;
  total_size_chars: number;
  total_bytes: number;
  entry_count: number;
  min_time: number;
  max_time: number;
  created_at: number;
}

/** 面向设置页与上传响应的快照元数据；绝不包含压缩正文。 */
export interface DebugSnapshotMeta {
  snapshotId: string;
  entryCount: number;
  minTime: number;
  maxTime: number;
  sizeChars: number;
  sizeBytes: number;
  chunkCount: number;
  createdAt: number;
  /** 兼容旧版单行快照客户端的 updatedAt 字段，与 createdAt 相同。 */
  updatedAt?: number;
  maxRowBytes: number;
}

export type AgentKeyTtlPreset = '1h' | '24h' | '7d' | '30d' | 'never';
export type AgentQueryMode = 'overview' | 'timeline' | 'grep' | 'trace';
