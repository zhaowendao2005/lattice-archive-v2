import type { UserProfile, UserRole } from '../stores/authStore';

export interface SessionState { token: string; user: UserProfile; expiresAt: number }
const STORAGE_KEY = 'lattice.auth.session';

function readFrom(storage: Storage): SessionState | null {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as SessionState;
    if (!value?.token || !value.user?.id || !value.expiresAt || value.expiresAt <= Date.now()) {
      storage.removeItem(STORAGE_KEY);
      return null;
    }
    if (!['user', 'admin'].includes(value.user.role as UserRole)) return null;
    return value;
  } catch { return null; }
}

function clearBoth() {
  try { window.localStorage.removeItem(STORAGE_KEY); window.sessionStorage.removeItem(STORAGE_KEY); } catch { /* unavailable storage */ }
}

export const authSessionStorage = {
  read(): SessionState | null {
    if (typeof window === 'undefined') return null;
    return readFrom(window.localStorage) ?? readFrom(window.sessionStorage);
  },
  write(session: SessionState, persistent: boolean) {
    if (typeof window === 'undefined') return;
    clearBoth();
    try { (persistent ? window.localStorage : window.sessionStorage).setItem(STORAGE_KEY, JSON.stringify(session)); } catch { /* unavailable storage */ }
  },
  clear() { if (typeof window !== 'undefined') clearBoth(); },
};
