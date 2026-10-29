import { defineStore } from 'pinia';
import { authSessionStorage } from '../data-sources/authSessionStorage';
import { authRemoteDataSource, RemoteAuthError } from '../data-sources/authRemoteDataSource';
import { turnstileBridge } from '../data-sources/turnstileBridge';

export type UserRole = 'user' | 'admin';
export interface UserProfile { id: string; name: string; email: string; initials: string; role: UserRole }
const ROLE_LABELS: Record<UserRole, string> = { user: '标准用户', admin: '系统管理员' };

export const useAuthStore = defineStore('auth', {
  state: () => {
    const session = authSessionStorage.read();
    return {
      user: session?.user ?? null,
      sessionToken: session?.token ?? null,
      sessionExpiresAt: session?.expiresAt ?? null,
      isConnectedToServer: false,
      isSubmitting: false,
      authError: null as string | null,
      turnstileToken: '',
      isTurnstileReady: false,
      hasInitializedConnection: false,
      emailInput: '', passwordInput: '', keepSignedIn: true,
      registerName: '', registerEmail: '', registerPassword: '',
      adminEmailInput: '', adminPasswordInput: '',
      isUserPasswordVisible: false, isAdminPasswordVisible: false,
      isAccountMenuOpen: false,
    };
  },
  getters: {
    isLoggedIn: (state): boolean => state.user !== null && state.isConnectedToServer,
    isAdmin: (state): boolean => state.user?.role === 'admin' && state.isConnectedToServer,
    displayName: (state): string => state.user?.name ?? '登录',
    displayRole: (state): string => state.user ? ROLE_LABELS[state.user.role] : '尚未登录',
    canSubmitLogin: (state): boolean => !!state.emailInput.trim() && !!state.passwordInput,
    canSubmitRegister: (state): boolean => !!state.registerName.trim() && !!state.registerEmail.trim() && state.registerPassword.length >= 8,
    canSubmitAdminLogin: (state): boolean => !!state.adminEmailInput.trim() && !!state.adminPasswordInput,
  },
  actions: {
    setEmailInput(value: string) { this.emailInput = value; this.authError = null; },
    setPasswordInput(value: string) { this.passwordInput = value; this.authError = null; },
    setKeepSignedIn(value: boolean) { this.keepSignedIn = value; },
    setRegisterName(value: string) { this.registerName = value; this.authError = null; },
    setRegisterEmail(value: string) { this.registerEmail = value; this.authError = null; },
    setRegisterPassword(value: string) { this.registerPassword = value; this.authError = null; },
    setAdminEmailInput(value: string) { this.adminEmailInput = value; this.authError = null; },
    setAdminPasswordInput(value: string) { this.adminPasswordInput = value; this.authError = null; },
    setTurnstileToken(value: string) { this.turnstileToken = value; },
    setTurnstileReady(value: boolean) { this.isTurnstileReady = value; },
    setAuthError(value: string | null) { this.authError = value; },
    toggleUserPasswordVisible() { this.isUserPasswordVisible = !this.isUserPasswordVisible; },
    toggleAdminPasswordVisible() { this.isAdminPasswordVisible = !this.isAdminPasswordVisible; },

    async submitLogin() {
      return this.submitWith(async () => authRemoteDataSource.login({ email: this.emailInput.trim(), password: this.passwordInput, turnstileToken: this.turnstileToken, keepSignedIn: this.keepSignedIn }));
    },
    async submitRegister() {
      return this.submitWith(async () => authRemoteDataSource.register({ name: this.registerName.trim(), email: this.registerEmail.trim(), password: this.registerPassword, turnstileToken: this.turnstileToken, keepSignedIn: this.keepSignedIn }));
    },
    async submitAdminLogin() {
      return this.submitWith(async () => authRemoteDataSource.adminLogin({ email: this.adminEmailInput.trim(), password: this.adminPasswordInput, turnstileToken: this.turnstileToken, keepSignedIn: this.keepSignedIn }));
    },
    async submitWith(request: () => Promise<{ user: UserProfile; session: { token: string; expiresAt: number } }>) {
      this.authError = null;
      if (this.isSubmitting) return false;
      if (!this.turnstileToken) { this.authError = '请先完成人机安全验证'; return false; }
      this.isSubmitting = true;
      try {
        const result = await request();
        this.applySession(result.user, result.session.token, result.session.expiresAt);
        this.isConnectedToServer = true;
        this.passwordInput = ''; this.registerPassword = ''; this.adminPasswordInput = '';
        this.closeAccountMenu();
        return true;
      } catch (error) {
        this.authError = error instanceof RemoteAuthError ? error.message : '认证失败，请稍后重试';
        return false;
      } finally {
        this.isSubmitting = false;
        turnstileBridge.reset();
      }
    },
    applySession(user: UserProfile, token: string, expiresAt: number) {
      this.user = user; this.sessionToken = token; this.sessionExpiresAt = expiresAt;
      authSessionStorage.write({ user, token, expiresAt }, this.keepSignedIn);
    },
    async initializeSessionConnection() {
      if (this.hasInitializedConnection) return this.isConnectedToServer;
      this.hasInitializedConnection = true;
      if (!this.sessionToken || !this.user) return false;
      try {
        const result = await authRemoteDataSource.connectSession(this.sessionToken);
        this.user = result.user; this.sessionExpiresAt = result.sessionExpiresAt; this.isConnectedToServer = true;
      return true;
      } catch (error) {
        if (error instanceof RemoteAuthError && error.status === 401) this.clearLocalSession();
        else {
          this.hasInitializedConnection = false;
          this.authError = '暂时无法连接认证服务器，请检查网络后重试';
        }
        return false;
      }
    },
    async logout() {
      const token = this.sessionToken;
      this.clearLocalSession();
      if (token) try { await authRemoteDataSource.logout(token); } catch { /* local logout must remain available offline */ }
      this.isAccountMenuOpen = false;
    },
    clearLocalSession() {
      this.user = null; this.sessionToken = null; this.sessionExpiresAt = null; this.isConnectedToServer = false;
      this.authSessionStorageClear();
      this.passwordInput = ''; this.adminPasswordInput = ''; this.isUserPasswordVisible = false; this.isAdminPasswordVisible = false;
    },
    authSessionStorageClear() { authSessionStorage.clear(); },
    openAccountMenu() { this.isAccountMenuOpen = true; },
    closeAccountMenu() { this.isAccountMenuOpen = false; },
    toggleAccountMenu() { this.isAccountMenuOpen = !this.isAccountMenuOpen; },
  },
});
