/** 运行监控视图的纯格式化函数（无状态）。 */
import type { MonitorConnectionState, MonitorTaskState } from '@/worker/local/telegram/contracts/monitor';

export function formatBytesRate(bytesPerSecond: number): string {
  if (bytesPerSecond >= 1024 * 1024) return `${(bytesPerSecond / 1024 / 1024).toFixed(1)} MB/s`;
  if (bytesPerSecond >= 1024) return `${(bytesPerSecond / 1024).toFixed(0)} KB/s`;
  return `${Math.round(bytesPerSecond)} B/s`;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

export function formatMs(ms: number): string {
  if (ms <= 0) return '—';
  if (ms >= 1000) return `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)} s`;
  return `${Math.round(ms)} ms`;
}

export function formatRate(perSecond: number): string {
  return perSecond >= 10 ? perSecond.toFixed(0) : perSecond.toFixed(1);
}

export function formatClock(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

export const CONNECTION_LABELS: Record<MonitorConnectionState, string> = {
  connecting: '连接中',
  online: '在线',
  reconnecting: '重连中',
  offline: '离线',
  'auth-expired': '授权失效',
  unknown: '未知',
};

export const TASK_STATE_LABELS: Record<MonitorTaskState, string> = {
  queued: '排队',
  running: '执行',
  ok: '完成',
  error: '失败',
  cancelled: '取消',
};

export const PRIORITY_LABELS: Record<string, string> = {
  interactive: '交互',
  visible: '可见',
  prefetch: '预取',
  background: '后台',
};
