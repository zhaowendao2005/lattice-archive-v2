import type { UserProfile } from '../stores/authStore';

const STORAGE_KEY = 'lattice.auth.session';
/** "保持登录"勾选后的有效期 */
const PERSIST_DAYS = 30;

interface PersistedSession {
  user: UserProfile;
  expiresAt: number;
}

function readFrom(storage: Storage): UserProfile | null {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedSession;
    if (!parsed?.user) return null;
    if (parsed.expiresAt && parsed.expiresAt < Date.now()) {
      storage.removeItem(STORAGE_KEY);
      return null;
    }
    return parsed.user;
  } catch {
    // 存储被禁用或内容损坏时静默降级为未登录，不阻塞应用启动
    return null;
  }
}

function writeTo(storage: Storage, user: UserProfile) {
  try {
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({ user, expiresAt: Date.now() + PERSIST_DAYS * 86_400_000 } satisfies PersistedSession)
    );
  } catch {
    /* 忽略存储配额与隐私模式异常 */
  }
}

function clearBoth() {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * 认证域的 Data Source 层：把会话身份落到浏览器存储。
 *
 * 勾选"保持登录"时写入 localStorage（30 天有效），未勾选时写入 sessionStorage
 * （关闭客户端即失效），使该复选框具备真实语义。接通真实鉴权后，
 * 这里替换为 Token 读写即可，上层 Store 无需改动。
 */
export const authSessionStorage = {
  read(): UserProfile | null {
    if (typeof window === 'undefined') return null;
    return readFrom(window.localStorage) ?? readFrom(window.sessionStorage);
  },

  write(user: UserProfile, persistent: boolean) {
    if (typeof window === 'undefined') return;
    clearBoth();
    writeTo(persistent ? window.localStorage : window.sessionStorage, user);
  },

  clear() {
    if (typeof window === 'undefined') return;
    clearBoth();
  },
};