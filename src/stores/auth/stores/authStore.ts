import { defineStore } from 'pinia';
import { authSessionStorage } from '../data-sources/authSessionStorage';

/** 账户角色：普通用户与管理员是两套独立会话，不可相互升级 */
export type UserRole = 'user' | 'admin';

export interface UserProfile {
  id: string;
  name: string;
  email: string;
  initials: string;
  role: UserRole;
}

const ROLE_LABELS: Record<UserRole, string> = {
  user: '标准用户',
  admin: '系统管理员',
};

/** 演示用默认身份模板；接通真实鉴权后由 Data Source 层注入 */
const DEFAULT_USER: UserProfile = {
  id: 'usr_1',
  name: 'Elena Rostova',
  email: 'elena@lattice.dev',
  initials: 'EL',
  role: 'user',
};

/**
 * 认证与账户域。
 *
 * 登录 / 注册 / 管理员登录均为独立路由页面（见 src/router/index.ts），
 * 此处只保存会话身份与表单草稿——草稿入 store 而非组件内 ref，
 * 这样在 登录 ↔ 注册 之间来回跳转时已填内容不会丢失。
 *
 * 会话的持久化交由 Data Source 层（authSessionStorage）处理。
 */
export const useAuthStore = defineStore('auth', {
  state: () => ({
    /** 当前会话身份；null 表示未登录（冷启动时从存储恢复） */
    user: authSessionStorage.read() as UserProfile | null,

    /** 用户登录表单 */
    emailInput: 'architect@lattice.dev',
    passwordInput: '',
    keepSignedIn: true,

    /** 注册表单 */
    registerName: '',
    registerEmail: '',
    registerPassword: '',

    /** 管理员登录表单（独立凭证） */
    adminEmailInput: '',
    adminPasswordInput: '',

    /** 密码明文显示开关，用户端与管理员端各一份 */
    isUserPasswordVisible: false,
    isAdminPasswordVisible: false,

    /** 侧栏账户菜单是否展开（全局 UI 态，需在路由切换后依然可控） */
    isAccountMenuOpen: false,
  }),

  getters: {
    isLoggedIn: (state): boolean => state.user !== null,
    isAdmin: (state): boolean => state.user?.role === 'admin',
    displayName: (state): string => state.user?.name ?? '登录',
    displayRole: (state): string =>
      state.user ? ROLE_LABELS[state.user.role] : '尚未登录',

    /** 提交按钮可用性：视图层只读，不自行校验 */
    canSubmitLogin: (state): boolean =>
      state.emailInput.trim().length > 0 && state.passwordInput.length > 0,
    canSubmitRegister: (state): boolean =>
      state.registerName.trim().length > 0 &&
      state.registerEmail.trim().length > 0 &&
      state.registerPassword.length >= 8,
    canSubmitAdminLogin: (state): boolean =>
      state.adminEmailInput.trim().length > 0 && state.adminPasswordInput.length >= 8,
  },

  actions: {
    setEmailInput(value: string) {
      this.emailInput = value;
    },

    setPasswordInput(value: string) {
      this.passwordInput = value;
    },

    setKeepSignedIn(value: boolean) {
      this.keepSignedIn = value;
    },

    setRegisterName(value: string) {
      this.registerName = value;
    },

    setRegisterEmail(value: string) {
      this.registerEmail = value;
    },

    setRegisterPassword(value: string) {
      this.registerPassword = value;
    },

    setAdminEmailInput(value: string) {
      this.adminEmailInput = value;
    },

    setAdminPasswordInput(value: string) {
      this.adminPasswordInput = value;
    },

    toggleUserPasswordVisible() {
      this.isUserPasswordVisible = !this.isUserPasswordVisible;
    },

    toggleAdminPasswordVisible() {
      this.isAdminPasswordVisible = !this.isAdminPasswordVisible;
    },

    /** 普通用户登录 */
    loginAsUser() {
      const user: UserProfile = {
        id: 'usr_1',
        name: 'Elena Rostova',
        email: this.emailInput || DEFAULT_USER.email,
        initials: 'EL',
        role: 'user',
      };
      this.user = user;
      authSessionStorage.write(user, this.keepSignedIn);
      this.passwordInput = '';
      this.closeAccountMenu();
    },

    /** 注册并直接进入工作区 */
    registerAndLogin() {
      const name = this.registerName.trim() || DEFAULT_USER.name;
      const user: UserProfile = {
        id: 'usr_1',
        name,
        email: this.registerEmail.trim() || DEFAULT_USER.email,
        initials: name.slice(0, 2).toUpperCase(),
        role: 'user',
      };
      this.user = user;
      authSessionStorage.write(user, this.keepSignedIn);
      this.registerPassword = '';
      this.closeAccountMenu();
    },

    /** 管理员登录：独立凭证，不与普通用户会话合并 */
    loginAsAdmin() {
      const user: UserProfile = {
        id: 'adm_1',
        name: 'System Operator',
        email: this.adminEmailInput || 'operator@lattice.dev',
        initials: 'SO',
        role: 'admin',
      };
      this.user = user;
      authSessionStorage.write(user, this.keepSignedIn);
      this.adminPasswordInput = '';
      this.closeAccountMenu();
    },

    /** 退出登录：清空会话与密码，重置身份相关的临时 UI 态 */
    logout() {
      this.user = null;
      authSessionStorage.clear();
      this.isAccountMenuOpen = false;
      this.passwordInput = '';
      this.adminPasswordInput = '';
      this.isUserPasswordVisible = false;
      this.isAdminPasswordVisible = false;
    },

    openAccountMenu() {
      this.isAccountMenuOpen = true;
    },

    closeAccountMenu() {
      this.isAccountMenuOpen = false;
    },

    toggleAccountMenu() {
      this.isAccountMenuOpen = !this.isAccountMenuOpen;
    },
  },
});