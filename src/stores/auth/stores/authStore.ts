/**
 * ============================================================================
 * 鉴权 Store（整个应用唯一的「我是谁」事实来源）
 * ============================================================================
 * 三层结构中的「响应式状态层」：
 *   View（表单）  →  本 Store（表单字段 / 提交态 / 错误）  →  authRemoteDataSource（HTTP）
 *                                                    ↘ authSessionStorage（本地持久化）
 *                                                    ↘ turnstileBridge（DOM 句柄与令牌）
 *
 * 关键设计：
 *   1. 表单输入也放在 Store 里（emailInput / passwordInput ...），因为视图禁止本地 ref；
 *   2. 登录态判定只看「本地是否有未过期会话」，因此冷启动可 0ms 放行、弱网可离线浏览；
 *   3. 真正的会话有效性由 initializeSessionConnection 在后台校准，401 才清理。
 */
import { defineStore } from 'pinia';
import { authSessionStorage } from '../data-sources/authSessionStorage';
import { authRemoteDataSource, RemoteAuthError } from '../data-sources/authRemoteDataSource';
import { turnstileBridge } from '../data-sources/turnstileBridge';

/** 角色只有两种：普通用户 user、系统管理员 admin（账户表物理隔离） */
export type UserRole = 'user' | 'admin';
/** 前端持有的公开用户资料（绝不含密码哈希 / 盐） */
export interface UserProfile { id: string; name: string; email: string; initials: string; role: UserRole }
/** 角色 → 中文展示名 */
const ROLE_LABELS: Record<UserRole, string> = { user: '标准用户', admin: '系统管理员' };

/**
 * 会话校准的并发闸门。
 * 路由守卫可能在一瞬间被多次触发，用同一个 Promise 保证「同一时间只有一次校准请求」。
 * 放在模块级（而非 state）因为它是过程量，不需要响应式。
 */
let connectionPromise: Promise<boolean> | null = null;

export const useAuthStore = defineStore('auth', {
  // ── 状态：初始化时直接从本地存储恢复会话，避免刷新后被踢回登录页 ──────────
  state: () => {
    const session = authSessionStorage.read();
    return {
      // 【会话】三件套：用户资料 / Token / 过期时间戳
      user: session?.user ?? null,
      sessionToken: session?.token ?? null,
      sessionExpiresAt: session?.expiresAt ?? null,
      // 【连接】是否已与远端建立有效连接（离线浏览时为 false，但不算未登录）
      isConnectedToServer: false,
      isSubmitting: false,
      // 【错误】展示在表单下方的中文文案
      authError: null as string | null,
      // 【人机验证】令牌由 turnstileBridge 写入，提交时随请求体上送
      turnstileToken: '',
      isTurnstileReady: false,
      // 【校准标记】是否已跑过一次后台会话校准，防止重复请求
      hasInitializedConnection: false,
      // 【表单】用户登录
      emailInput: '', passwordInput: '', keepSignedIn: true,
      // 【表单】用户注册
      registerName: '', registerEmail: '', registerPassword: '',
      // 【表单】管理员登录
      adminEmailInput: '', adminPasswordInput: '',
      // 【交互】密码可见性、右上角账户菜单开关
      isUserPasswordVisible: false, isAdminPasswordVisible: false,
      isAccountMenuOpen: false,
    };
  },

  getters: {
    /** 本地持有未过期的有效会话即视为已登录（支持首屏零等待放行与弱网离线浏览）；远端 401 时会清理会话。 */
    isLoggedIn: (state): boolean => state.user !== null && state.sessionToken !== null,
    /** 管理员 = 角色为 admin 且持有 Token；后端每次 /api/admin/* 还会再校验一次 */
    isAdmin: (state): boolean => state.user?.role === 'admin' && state.sessionToken !== null,
    displayName: (state): string => state.user?.name ?? '登录',
    displayRole: (state): string => state.user ? ROLE_LABELS[state.user.role] : '尚未登录',
    // 下面三个只用于「提示用户还缺什么」，主按钮始终可点（项目规范禁止 disabled 置灰）
    canSubmitLogin: (state): boolean => !!state.emailInput.trim() && !!state.passwordInput,
    canSubmitRegister: (state): boolean => !!state.registerName.trim() && !!state.registerEmail.trim() && state.registerPassword.length >= 8,
    canSubmitAdminLogin: (state): boolean => !!state.adminEmailInput.trim() && !!state.adminPasswordInput,
  },

  actions: {
    // ── 表单写入器：任何输入变化都会顺手清掉上一次的错误提示 ──────────────
    setEmailInput(value: string) { this.emailInput = value; this.authError = null; },
    setPasswordInput(value: string) { this.passwordInput = value; this.authError = null; },
    setKeepSignedIn(value: boolean) { this.keepSignedIn = value; },
    setRegisterName(value: string) { this.registerName = value; this.authError = null; },
    setRegisterEmail(value: string) { this.registerEmail = value; this.authError = null; },
    setRegisterPassword(value: string) { this.registerPassword = value; this.authError = null; },
    setAdminEmailInput(value: string) { this.adminEmailInput = value; this.authError = null; },
    setAdminPasswordInput(value: string) { this.adminPasswordInput = value; this.authError = null; },
    // ── Turnstile 桥接写入口（由 turnstileBridge 调用）────────────────────
    setTurnstileToken(value: string) { this.turnstileToken = value; },
    setTurnstileReady(value: boolean) { this.isTurnstileReady = value; },
    setAuthError(value: string | null) { this.authError = value; },
    toggleUserPasswordVisible() { this.isUserPasswordVisible = !this.isUserPasswordVisible; },
    toggleAdminPasswordVisible() { this.isAdminPasswordVisible = !this.isAdminPasswordVisible; },

    // ── 三个提交入口：都把「读表单 → 发请求 → 落会话」交给 submitWith 统一处理 ──
    /** 用户登录 */
    async submitLogin() {
      return this.submitWith(async () => authRemoteDataSource.login({ email: this.emailInput.trim(), password: this.passwordInput, turnstileToken: this.turnstileToken, keepSignedIn: this.keepSignedIn }));
    },
    /** 用户注册（成功后服务端直接签发会话，无需再登录一次） */
    async submitRegister() {
      return this.submitWith(async () => authRemoteDataSource.register({ name: this.registerName.trim(), email: this.registerEmail.trim(), password: this.registerPassword, turnstileToken: this.turnstileToken, keepSignedIn: this.keepSignedIn }));
    },
    /** 管理员登录（独立接口，与普通用户表物理隔离） */
    async submitAdminLogin() {
      return this.submitWith(async () => authRemoteDataSource.adminLogin({ email: this.adminEmailInput.trim(), password: this.adminPasswordInput, turnstileToken: this.turnstileToken, keepSignedIn: this.keepSignedIn }));
    },

    /**
     * 认证提交的统一流程（登录 / 注册 / 管理员登录共用）。
     * 步骤：清错误 → 防重复提交 → 校验人机验证 → 发请求 → 落会话 → 清理口令。
     * 失败时重置 Turnstile（令牌一次性，重试必须换新的）。
     * @returns 是否成功（视图据此决定跳转）
     */
    async submitWith(request: () => Promise<{ user: UserProfile; session: { token: string; expiresAt: number } }>) {
      this.authError = null;
      if (this.isSubmitting) return false; // 双击/回车连按保护
      if (!this.turnstileToken) { this.authError = '请先完成人机安全验证'; return false; }
      this.isSubmitting = true;
      let succeeded = false;
      try {
        const result = await request();
        // 成功后立刻落库（内存 + 本地存储），并标记已连接
        this.applySession(result.user, result.session.token, result.session.expiresAt);
        this.isConnectedToServer = true;
        this.hasInitializedConnection = true;
        // 安全：口令不留在内存里
        this.passwordInput = ''; this.registerPassword = ''; this.adminPasswordInput = '';
        this.closeAccountMenu();
        succeeded = true;
        return true;
      } catch (error) {
        // 只把后端给的中文 message 透给用户，其余一律兜底文案
        this.authError = error instanceof RemoteAuthError ? error.message : '认证失败，请稍后重试';
        return false;
      } finally {
        this.isSubmitting = false;
        if (!succeeded) turnstileBridge.reset();
        else this.turnstileToken = ''; // 成功即消耗掉令牌
      }
    },

    /** 把会话写入内存并按「保持登录」决定持久化位置 */
    applySession(user: UserProfile, token: string, expiresAt: number) {
      this.user = user; this.sessionToken = token; this.sessionExpiresAt = expiresAt;
      authSessionStorage.write({ user, token, expiresAt }, this.keepSignedIn);
    },

    /**
     * 冷启动会话校准（路由守卫里调用）。
     *
     * 策略说明：
     *   · 本地无 Token → 直接结束，不打扰用户；
     *   · 有 Token → 请求 /api/auth/session/connect 换取最新用户资料与过期时间；
     *   · 返回 401 → 会话已被服务端撤销，清理本地并回调让守卫踢回登录页；
     *   · 网络错误/超时 → 保留本地会话（弱网下仍可查看本地缓存、直连 Telegram），
     *     只在真正拿到 401 时才登出，避免「地铁里打开 App 就被登出」。
     */
    async initializeSessionConnection(onUnauthorized?: (previousRole?: UserRole) => void) {
      if (this.hasInitializedConnection) return this.isLoggedIn;
      if (!this.sessionToken || !this.user) {
        // 没有本地会话：标记已初始化，后续不再重复进入
        this.hasInitializedConnection = true;
        return false;
      }
      // 并发去重：守卫短时间内被多次触发时共用同一请求
      if (connectionPromise) return connectionPromise;
      const token = this.sessionToken;
      const previousRole = this.user.role; // 记下原角色，供回调决定该跳哪个登录页
      connectionPromise = (async () => {
        try {
          const result = await authRemoteDataSource.connectSession(token);
          // 请求飞行期间用户可能已登出/换号，此时丢弃这次结果
          if (this.sessionToken !== token) return this.isLoggedIn;
          this.user = result.user;
          this.sessionExpiresAt = result.sessionExpiresAt;
          this.isConnectedToServer = true;
          this.hasInitializedConnection = true;
          return true;
        } catch (error) {
          if (error instanceof RemoteAuthError && error.status === 401) {
            // 服务端明确说「这个会话无效」→ 必须清掉
            this.clearLocalSession();
            this.hasInitializedConnection = true;
            onUnauthorized?.(previousRole);
            return false;
          }
          // 网络抖动或远端暂时不可达时保留本地有效会话，允许继续使用本地缓存与直连 Telegram。
          this.hasInitializedConnection = true;
          return this.isLoggedIn;
        } finally {
          connectionPromise = null; // 释放闸门
        }
      })();
      return connectionPromise;
    },

    /**
     * 退出登录：先清本地（保证离线也能退出），再尽力通知服务端删除会话。
     * 远端失败不影响本地结果，因此这里吞掉异常。
     */
    async logout() {
      const token = this.sessionToken;
      this.clearLocalSession();
      if (token) try { await authRemoteDataSource.logout(token); } catch { /* local logout must remain available offline */ }
      this.isAccountMenuOpen = false;
    },

    /** 清除本地全部会话痕迹（收到 401 或主动退出时调用） */
    clearLocalSession() {
      this.user = null; this.sessionToken = null; this.sessionExpiresAt = null; this.isConnectedToServer = false;
      this.authSessionStorageClear();
      this.passwordInput = ''; this.adminPasswordInput = ''; this.isUserPasswordVisible = false; this.isAdminPasswordVisible = false;
    },
    authSessionStorageClear() { authSessionStorage.clear(); },

    // ── 右上角账户菜单开合（属于临时交互态，因此留在 Store 而非路由）─────
    openAccountMenu() { this.isAccountMenuOpen = true; },
    closeAccountMenu() { this.isAccountMenuOpen = false; },
    toggleAccountMenu() { this.isAccountMenuOpen = !this.isAccountMenuOpen; },
  },
});
