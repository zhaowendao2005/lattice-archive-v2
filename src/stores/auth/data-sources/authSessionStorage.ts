/**
 * ============================================================================
 * 会话本地持久化（localStorage / sessionStorage 双轨）
 * ============================================================================
 * 「保持登录」勾选时写 localStorage（关浏览器仍在），否则写 sessionStorage（关标签页即失效）。
 * 两份存储同一 key，但读取时以 localStorage 优先；写入前先两边清空，保证不会残留旧会话。
 *
 * 注意：这里只存「服务端签发的 Token + 公开用户资料」，口令与哈希永不落前端。
 */
import type { UserProfile, UserRole } from '../stores/authStore';

/** 落地到存储中的会话快照 */
export interface SessionState { token: string; user: UserProfile; expiresAt: number }
const STORAGE_KEY = 'lattice.auth.session';

/**
 * 从指定 Storage 读一份会话并做完整性/有效性校验。
 * 任何一步不合法就顺手删掉脏数据，返回 null（永不抛异常，避免启动崩溃）。
 */
function readFrom(storage: Storage): SessionState | null {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as SessionState;
    // 三个必填字段缺失、或已过期 → 视为无会话
    if (!value?.token || !value.user?.id || !value.expiresAt || value.expiresAt <= Date.now()) {
      storage.removeItem(STORAGE_KEY);
      return null;
    }
    // 角色白名单：防止被篡改出第三个非法角色
    if (!['user', 'admin'].includes(value.user.role as UserRole)) return null;
    return value;
  } catch { return null; } // JSON 损坏 / 存储被禁用
}

/** 同时清空两种存储（某些浏览器隐私模式下访问 storage 会抛异常） */
function clearBoth() {
  try { window.localStorage.removeItem(STORAGE_KEY); window.sessionStorage.removeItem(STORAGE_KEY); } catch { /* unavailable storage */ }
}

export const authSessionStorage = {
  /** 读会话：先找「保持登录」的长期存储，再退到会话级存储 */
  read(): SessionState | null {
    if (typeof window === 'undefined') return null;
    return readFrom(window.localStorage) ?? readFrom(window.sessionStorage);
  },
  /** 写会话：persistent=true 写 localStorage，否则写 sessionStorage */
  write(session: SessionState, persistent: boolean) {
    if (typeof window === 'undefined') return;
    clearBoth(); // 先清后写，避免两种存储同时持有不同 Token
    try { (persistent ? window.localStorage : window.sessionStorage).setItem(STORAGE_KEY, JSON.stringify(session)); } catch { /* unavailable storage */ }
  },
  /** 退出登录 / 收到 401 时清除 */
  clear() { if (typeof window !== 'undefined') clearBoth(); },
};
