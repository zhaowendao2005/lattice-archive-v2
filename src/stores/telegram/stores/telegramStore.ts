import { defineStore } from 'pinia';
import { tgRemoteDataSource, type TelegramAccount, type TelegramCredentials, type TelegramAuthorization } from '../data-sources/tgRemoteDataSource';
import { MtprotoBridge, mtprotoHub, type LoginEvent, type RestoreFailure, type ValidationReport } from '../data-sources/mtprotoBridge';
import { tgSessionVault } from '../data-sources/tgSessionVault';

export type LoginStage = 'idle' | 'qr' | 'phone' | 'code' | 'password' | 'ready';

const APP_VERSION = '2.0.0';
const PLATFORM = 'web' as const;
const DEVICE_HEARTBEAT_INTERVAL_MS = 30_000;
const ONLINE_WINDOW_MS = 90_000;
const PRESENCE_CLOCK_INTERVAL_MS = 15_000;
const ACTIVE_ACCOUNT_KEY = 'lattice.telegram.active-account';

/**
 * 「最近账户」偏好按 Lattice 用户隔离：同一浏览器换人登录时，绝不能沿用上一位用户的 Telegram 账户。
 * ownerId 在工作区引导时由视图层传入（来自 authStore），模块作用域保存以避免 store 之间循环依赖。
 */
let ownerId: string | null = null;
function activeAccountKey() { return ownerId ? `${ACTIVE_ACCOUNT_KEY}.${ownerId}` : null; }
function readActiveAccountId() { const key = activeAccountKey(); if (!key) return undefined; try { return window.localStorage.getItem(key) ?? undefined; } catch { return undefined; } }
function writeActiveAccountId(accountId: string) { const key = activeAccountKey(); if (!key) return; try { window.localStorage.setItem(key, accountId); } catch { /* 存储不可用时仅失去「最近账户」偏好 */ } }

export type TelegramConnectionState = 'connecting' | 'online' | 'reconnecting' | 'offline' | 'auth-expired' | 'error';

let deviceHeartbeatTimer: number | undefined;
let heartbeatAccountId: string | undefined;
let heartbeatGeneration = 0;
let presenceQueue: Promise<void> = Promise.resolve();
let presenceClockTimer: number | undefined;
let restoreSessionsPromise: Promise<void> | undefined;
/** 会话恢复失败后的退避重试：10s / 30s / 60s，之后停止并提示手动重连。 */
const RESTORE_RETRY_DELAYS_MS = [10_000, 30_000, 60_000];
let restoreAttempts = 0;
let restoreRetryTimer: number | undefined;
function clearRestoreRetry() {
  if (restoreRetryTimer) window.clearTimeout(restoreRetryTimer);
  restoreRetryTimer = undefined;
}

/** 单例接线器不能进 Pinia state（store 只存可序列化页面态），因此放在模块作用域。 */
let bridge: MtprotoBridge | null = null;
let bootstrapPromise: Promise<void> | undefined;

export const useTelegramStore = defineStore('telegram', {
  state: () => ({
    apiIdInput: '',
    apiHashInput: '',
    credentials: null as TelegramCredentials | null,
    validationReport: null as ValidationReport | null,
    accounts: [] as TelegramAccount[],
    connectionStates: {} as Record<string, TelegramConnectionState>,
    connectionNotices: {} as Record<string, string>,
    /**
     * 本设备当前持有（或正在恢复）连接的账户。工作区引导时先取本机「最近账户」偏好，
     * 让聊天域在远端账户列表返回前就能展示该账户的本地缓存。
     */
    currentAccountId: null as string | null,
    isBootstrapped: false,
    loginTargetUserId: null as string | null,
    presenceNow: Date.now(),
    isLoading: false,
    isValidating: false,
    error: null as string | null,
    loginStage: 'idle' as LoginStage,
    qrToken: '',
    qrImage: '',
    qrExpiresAt: 0,
    phoneInput: '',
    codeInput: '',
    passwordInput: '',
  }),
  getters: {
    hasCredentials: (state): boolean => state.credentials !== null,
    /** 把验证报告整理为可读的「标签 / 值」对，供凭据卡片展示，避免视图直接输出 JSON。 */
    credentialFacts: (state): { label: string; value: string }[] => {
      const raw = (state.validationReport ?? state.credentials?.report ?? null) as Partial<ValidationReport> | null;
      const facts: { label: string; value: string }[] = [];
      if (raw && typeof raw === 'object') {
        if (typeof raw.dcId === 'number') facts.push({ label: '数据中心', value: `DC ${raw.dcId}` });
        if (typeof raw.country === 'string' && raw.country) facts.push({ label: '出口地区', value: raw.country });
        if (typeof raw.latencyMs === 'number') facts.push({ label: '延迟', value: `${Math.round(raw.latencyMs)} ms` });
        if (typeof raw.layer === 'number') facts.push({ label: '协议层', value: `Layer ${raw.layer}` });
      }
      const validatedAt = state.credentials?.validatedAt;
      if (validatedAt) facts.push({ label: '验证时间', value: new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(validatedAt) });
      return facts;
    },
    deviceId: (): string => tgSessionVault.deviceId(),
    currentAccount: (state): TelegramAccount | undefined => state.accounts.find((account) => account.tg_user_id === state.currentAccountId),
    currentConnectionState: (state): TelegramConnectionState | undefined => (state.currentAccountId ? state.connectionStates[state.currentAccountId] : undefined),
    onlineAuthorizations: (state): TelegramAuthorization[] => state.accounts.flatMap((account) => account.authorizations.filter((authorization) => {
      if (authorization.session_state !== 'active') return false;
      if (authorization.device_id === tgSessionVault.deviceId()) return state.connectionStates[account.tg_user_id] === 'online';
      return authorization.reachability === 'ok' && state.presenceNow - authorization.last_seen_at <= ONLINE_WINDOW_MS;
    })),
  },
  actions: {
    setApiIdInput(value: string) { this.apiIdInput = value; this.error = null; },
    setApiHashInput(value: string) { this.apiHashInput = value; this.error = null; },
    setPhoneInput(value: string) { this.phoneInput = value; },
    setCodeInput(value: string) { this.codeInput = value; },
    setPasswordInput(value: string) { this.passwordInput = value; },

    async load() {
      if (!presenceClockTimer) {
        presenceClockTimer = window.setInterval(() => { this.presenceNow = Date.now(); }, PRESENCE_CLOCK_INTERVAL_MS);
      }
      this.isLoading = true;
      this.error = null;
      const owner = ownerId;
      try {
        const [credentials, accounts] = await Promise.all([
          tgRemoteDataSource.getCredentials(),
          tgRemoteDataSource.getAccounts(),
        ]);
        // 请求期间换人登录：丢弃属于上一位用户的响应。
        if (owner !== ownerId) return;
        this.credentials = credentials;
        this.accounts = accounts;
        this.apiIdInput = credentials ? String(credentials.apiId) : '';
        this.isBootstrapped = true;
        if (owner) {
          if (credentials) void tgSessionVault.saveCredentials(owner, { apiId: credentials.apiId, apiHash: credentials.apiHash });
          else void tgSessionVault.removeCredentials(owner);
        }
        if (!credentials) {
          if (this.currentAccountId) this.ensureBridge().disconnectSession();
          this.currentAccountId = null;
          return;
        }
        // 若本地极速通道已恢复某账户，校验该账户及本设备授权是否仍在远端绑定列表中。
        if (this.currentAccountId) {
          const bound = accounts.find((item) => item.tg_user_id === this.currentAccountId);
          if (!bound) {
            const staleId = this.currentAccountId;
            this.ensureBridge().disconnectSession();
            this.currentAccountId = null;
            delete this.connectionStates[staleId];
            void tgSessionVault.remove(staleId);
          } else if (this.connectionStates[this.currentAccountId] === 'online') {
            // 远端设备列表就绪后补发一次在线心跳，确保远端 last_seen_at 与 reachability 立即刷新。
            this.startDeviceHeartbeat(this.currentAccountId);
            return;
          } else if (this.connectionStates[this.currentAccountId] === 'connecting') {
            return;
          }
        }
        await this.restoreLocalSessions();
      } catch (error) {
        this.error = this.readError(error);
      } finally {
        this.isLoading = false;
      }
    },

    /** 设置页挂载时调用：若已在引导中则复用，已引导完成则静默刷新远端账户与设备在线状态。 */
    async refreshBindingView() {
      if (!this.isBootstrapped) {
        if (bootstrapPromise) await bootstrapPromise;
        else await this.load();
        return;
      }
      const owner = ownerId;
      try {
        const [credentials, accounts] = await Promise.all([
          tgRemoteDataSource.getCredentials(),
          tgRemoteDataSource.getAccounts(),
        ]);
        if (owner !== ownerId) return;
        this.credentials = credentials;
        this.accounts = accounts;
        this.presenceNow = Date.now();
        if (!this.apiIdInput && credentials) this.apiIdInput = String(credentials.apiId);
      } catch (error) {
        this.error = this.readError(error);
      }
    },

    /**
     * 工作区级连接引导：
     * 1. 立即预热本地 Worker（ensureBridge）并启动「本机凭据直连通道」（0 远端等待直连 Telegram）；
     * 2. 同时在后台异步拉取远端凭据与设备在线列表（load），数据面与控制面完全解耦。
     */
    ensureBootstrapped(owner: string): Promise<void> {
      if (ownerId !== owner) {
        const switching = ownerId !== null;
        ownerId = owner;
        this.resetForOwner(switching);
      }
      this.ensureBridge();
      if (this.isBootstrapped) return Promise.resolve();
      if (!bootstrapPromise) {
        void this.restoreFromLocalImmediate(owner);
        bootstrapPromise = this.load().finally(() => { bootstrapPromise = undefined; });
      }
      return bootstrapPromise;
    },

    /** 本机极速恢复通道：不等待远端 API，直接从本地加密 Vault 读取 apiId/apiHash/stringSession 建连。 */
    async restoreFromLocalImmediate(owner: string) {
      try {
        let targetId = readActiveAccountId();
        if (!targetId) {
          const storedIds = await tgSessionVault.listAccountIds();
          if (owner !== ownerId) return;
          targetId = storedIds[0];
        }
        if (!targetId) return;
        const [session, cachedCreds] = await Promise.all([
          tgSessionVault.read(targetId),
          tgSessionVault.readCredentials(owner),
        ]);
        if (owner !== ownerId || !session) return;
        if (session.ownerId && session.ownerId !== owner) return;
        const apiId = session.apiId ?? cachedCreds?.apiId ?? this.credentials?.apiId;
        const apiHash = session.apiHash ?? cachedCreds?.apiHash ?? this.credentials?.apiHash;
        if (!apiId || !apiHash) return;
        if (!this.credentials) {
          this.credentials = { apiId, apiHash, apiHashMask: '••••••••', validatedAt: null, report: null };
          this.apiIdInput = String(apiId);
        }
        if (this.connectionStates[targetId] === 'online' || this.connectionStates[targetId] === 'connecting') return;
        await this.restoreAccountWithCredentials(targetId, apiId, apiHash, session.stringSession);
      } catch {
        // 本地快速通道异常时静默交由远端 load() 通道兜底。
      }
    },

    resetForOwner(stopConnection: boolean) {
      clearRestoreRetry();
      restoreAttempts = 0;
      if (deviceHeartbeatTimer) window.clearInterval(deviceHeartbeatTimer);
      deviceHeartbeatTimer = undefined;
      heartbeatAccountId = undefined;
      heartbeatGeneration += 1;
      bootstrapPromise = undefined;
      if (stopConnection && bridge) bridge.disconnectSession();
      this.credentials = null;
      this.validationReport = null;
      this.accounts = [];
      this.connectionStates = {};
      this.connectionNotices = {};
      this.error = null;
      this.apiIdInput = '';
      this.apiHashInput = '';
      this.isBootstrapped = false;
      this.currentAccountId = readActiveAccountId() ?? null;
    },

    ensureBridge() {
      if (!bridge) {
        mtprotoHub.subscribe((event) => { void this.handleBridgeEvent(event); });
        bridge = mtprotoHub.bridge();
      }
      return bridge;
    },

    async validateAndSaveCredentials() {
      if (this.isValidating) return false;
      const apiId = Number(this.apiIdInput.trim());
      const apiHash = this.apiHashInput.trim() || this.credentials?.apiHash || '';
      if (!Number.isInteger(apiId) || apiId <= 0) { this.error = '请输入有效的 api_id'; return false; }
      if (!apiHash) { this.error = '请输入 api_hash'; return false; }
      this.isValidating = true;
      this.error = null;
      try {
        const report = await this.ensureBridge().validateApp(apiId, apiHash);
        this.credentials = await tgRemoteDataSource.saveCredentials({ apiId, apiHash, report });
        if (ownerId) void tgSessionVault.saveCredentials(ownerId, { apiId, apiHash });
        this.validationReport = report;
        this.apiHashInput = '';
        return true;
      } catch (error) {
        this.error = this.readError(error);
        return false;
      } finally {
        this.isValidating = false;
      }
    },

    async removeCredentials(cascade = false) {
      try {
        await tgRemoteDataSource.removeCredentials(cascade);
        this.credentials = null;
        if (ownerId) void tgSessionVault.removeCredentials(ownerId);
        if (cascade) this.accounts = [];
      } catch (error) {
        this.error = this.readError(error);
      }
    },

    /** 从本机加密 vault 恢复会话；无本地会话的账户保持离线，不触碰远端设备记录。 */
    async restoreLocalSessions() {
      if (!this.credentials) return;
      // load() 与「当选主标签页」都会触发恢复，合并为一次，避免并发建连。
      if (restoreSessionsPromise) return restoreSessionsPromise;
      restoreSessionsPromise = this.restoreLocalSessionsOnce().finally(() => { restoreSessionsPromise = undefined; });
      return restoreSessionsPromise;
    },

    async restoreLocalSessionsOnce() {
      if (!this.credentials) return;
      // 本地 Worker 同时只持有一条 MTProto 连接，因此只恢复最近使用的账户，避免反复建连。
      // 偏好账户已被解绑时退回逐个尝试，否则会出现「有会话却永远不恢复」。
      const preferredId = readActiveAccountId();
      if (this.accounts.length === 0 && preferredId) {
        if (this.connectionStates[preferredId] !== 'online') await this.restoreAccount(preferredId);
        return;
      }
      const preferred = this.accounts.find((account) => account.tg_user_id === preferredId);
      const candidates = preferred ? [preferred] : this.accounts;
      if (!preferred && this.currentAccountId && this.accounts.length > 0 && !this.accounts.some((account) => account.tg_user_id === this.currentAccountId)) {
        this.currentAccountId = null;
      }
      for (const account of candidates) {
        if (this.connectionStates[account.tg_user_id] === 'online') return;
        if (await this.restoreAccount(account.tg_user_id)) return;
      }
    },

    /** 恢复单个账户；返回是否真正发起了恢复（本地无会话时返回 false）。 */
    async restoreAccount(tgUserId: string): Promise<boolean> {
      if (!this.credentials) return false;
      const session = await tgSessionVault.read(tgUserId);
      if (!session) {
        this.connectionStates[tgUserId] = 'offline';
        this.connectionNotices[tgUserId] = '本设备没有该账户的本地会话，请移除本设备后重新添加';
        return false;
      }
      // 顺手将最新凭据与 ownerId 补写进会话记录，确保下次冷启动单条记录即可直连。
      if (session.apiId !== this.credentials.apiId || session.apiHash !== this.credentials.apiHash || session.ownerId !== (ownerId ?? undefined)) {
        void tgSessionVault.save(tgUserId, {
          ...session,
          apiId: this.credentials.apiId,
          apiHash: this.credentials.apiHash,
          ownerId: ownerId ?? undefined,
        });
      }
      return this.restoreAccountWithCredentials(tgUserId, this.credentials.apiId, this.credentials.apiHash, session.stringSession);
    },

    async restoreAccountWithCredentials(tgUserId: string, apiId: number, apiHash: string, stringSession: string): Promise<boolean> {
      this.connectionStates[tgUserId] = 'connecting';
      this.connectionNotices[tgUserId] = '正在恢复 Telegram 会话…';
      this.currentAccountId = tgUserId;
      try {
        await this.ensureBridge().restoreSession(apiId, apiHash, tgUserId, stringSession);
      } catch {
        this.handleRestoreFailure(tgUserId, 'error', 'Telegram 会话恢复失败');
      }
      return true;
    },

    /** 用户手动重连：清空自动重试计数后立即恢复。 */
    async reconnectAccount(tgUserId: string) {
      clearRestoreRetry();
      restoreAttempts = 0;
      writeActiveAccountId(tgUserId);
      await this.restoreAccount(tgUserId);
    },

    handleRestoreFailure(tgUserId: string, reason: RestoreFailure, message: string) {
      clearRestoreRetry();
      if (reason === 'auth-invalid') {
        // 空会话探测已证明 DC 可达，旧 auth_key 不会再自行恢复，重试没有意义。
        this.connectionStates[tgUserId] = 'auth-expired';
        this.connectionNotices[tgUserId] = message;
        restoreAttempts = 0;
        void tgSessionVault.remove(tgUserId);
        return;
      }
      this.connectionStates[tgUserId] = 'offline';
      if (restoreAttempts >= RESTORE_RETRY_DELAYS_MS.length) {
        this.connectionNotices[tgUserId] = `${message}，已停止自动重试，可点击「重新连接」`;
        return;
      }
      const delay = RESTORE_RETRY_DELAYS_MS[restoreAttempts];
      restoreAttempts += 1;
      this.connectionNotices[tgUserId] = `${message}，${delay / 1000} 秒后自动重试（${restoreAttempts}/${RESTORE_RETRY_DELAYS_MS.length}）`;
      restoreRetryTimer = window.setTimeout(() => {
        restoreRetryTimer = undefined;
        void this.restoreAccount(tgUserId);
      }, delay);
    },

    async refreshAccounts() {
      try {
        this.accounts = await tgRemoteDataSource.getAccounts();
        this.presenceNow = Date.now();
      } catch (error) {
        this.error = this.readError(error);
      }
    },

    startDeviceHeartbeat(tgUserId: string) {
      if (deviceHeartbeatTimer) window.clearInterval(deviceHeartbeatTimer);
      heartbeatAccountId = tgUserId;
      const generation = ++heartbeatGeneration;
      void this.sendDeviceHeartbeat(tgUserId, generation);
      deviceHeartbeatTimer = window.setInterval(() => { void this.sendDeviceHeartbeat(tgUserId, generation); }, DEVICE_HEARTBEAT_INTERVAL_MS);
    },

    async sendDeviceHeartbeat(tgUserId: string, generation = heartbeatGeneration) {
      if (generation !== heartbeatGeneration) return;
      let isTelegramOnline = false;
      try { isTelegramOnline = await this.ensureBridge().checkConnection(tgUserId); } catch { /* Treat a failed probe as offline. */ }
      if (generation !== heartbeatGeneration) return;
      const current = this.connectionStates[tgUserId];
      if (isTelegramOnline) {
        this.connectionStates[tgUserId] = 'online';
        delete this.connectionNotices[tgUserId];
      } else if (current !== 'connecting' && current !== 'reconnecting' && current !== 'auth-expired') {
        // 恢复中 / 已判定失效时，不能让心跳探测覆盖更准确的状态与提示。
        this.connectionStates[tgUserId] = 'offline';
        if (!this.connectionNotices[tgUserId]) this.connectionNotices[tgUserId] = 'Telegram 连接暂时不可用';
      }
      const account = this.accounts.find((item) => item.tg_user_id === tgUserId);
      const authorization = account?.authorizations.find((item) => item.device_id === this.deviceId);
      if (!authorization) return;
      const update = async () => {
        if (generation !== heartbeatGeneration) return;
        try {
          const result = await tgRemoteDataSource.updateAuthorization(authorization.id, {
            reachability: isTelegramOnline ? 'ok' : 'blocked',
          });
          if (result.accounts) this.accounts = result.accounts;
          this.presenceNow = Date.now();
        } catch {
          // Telegram connection state remains local; temporary Lattice API failures must not stop the session.
        }
      };
      presenceQueue = presenceQueue.then(update, update);
      await presenceQueue;
    },

    async stopDeviceHeartbeat(tgUserId: string) {
      if (heartbeatAccountId !== tgUserId) return;
      if (deviceHeartbeatTimer) window.clearInterval(deviceHeartbeatTimer);
      deviceHeartbeatTimer = undefined;
      heartbeatAccountId = undefined;
      const generation = ++heartbeatGeneration;
      const account = this.accounts.find((item) => item.tg_user_id === tgUserId);
      const authorization = account?.authorizations.find((item) => item.device_id === this.deviceId);
      if (!authorization) return;
      const update = async () => {
        try {
          const result = await tgRemoteDataSource.updateAuthorization(authorization.id, { reachability: 'blocked' });
          if (result.accounts) this.accounts = result.accounts;
          this.presenceNow = Date.now();
        } catch {
          // Heartbeats expire on the server if this best-effort offline update cannot be delivered.
        }
      };
      presenceQueue = presenceQueue.then(update, update);
      await presenceQueue;
      if (generation !== heartbeatGeneration) return;
    },

    async removeAccount(id: string) {
      try {
        await tgRemoteDataSource.removeAccount(id);
        await this.refreshAccounts();
      } catch (error) {
        this.error = this.readError(error);
      }
    },

    async removeAuthorization(id: string) {
      try {
        await tgRemoteDataSource.removeAuthorization(id);
        await this.refreshAccounts();
      } catch (error) {
        this.error = this.readError(error);
      }
    },

    resetQrState() { this.qrToken = ''; this.qrImage = ''; this.qrExpiresAt = 0; },

    openLogin(targetUserId?: string) {
      if (!this.credentials) { this.error = '请先验证并保存应用凭据'; return; }
      if (targetUserId && this.accounts.find((account) => account.tg_user_id === targetUserId)?.authorizations.some((item) => item.device_id === this.deviceId)) {
        this.error = '本设备已添加到此 Telegram 账户';
        return;
      }
      this.error = null;
      this.loginTargetUserId = targetUserId ?? null;
      this.phoneInput = ''; this.codeInput = ''; this.passwordInput = '';
      this.startQrLogin();
    },

    openDeviceLogin(tgUserId: string) { this.openLogin(tgUserId); },

    startQrLogin() {
      if (!this.credentials) { this.error = '请先验证并保存应用凭据'; return; }
      this.resetQrState();
      this.loginStage = 'qr';
      if (this.loginTargetUserId) this.connectionStates[this.loginTargetUserId] = 'connecting';
      const exceptIds = this.accounts.map((account) => account.tg_user_id)
        .filter((id) => id !== this.loginTargetUserId);
      this.ensureBridge().beginQrLogin(
        this.credentials.apiId,
        this.credentials.apiHash,
        exceptIds,
        this.loginTargetUserId ?? undefined,
      );
    },

    switchToQrLogin() { this.startQrLogin(); },

    switchToPhoneLogin() {
      if (!this.credentials) { this.error = '请先验证并保存应用凭据'; return; }
      this.error = null;
      this.resetQrState();
      this.loginStage = 'phone';
      if (this.loginTargetUserId) this.connectionStates[this.loginTargetUserId] = 'connecting';
      this.ensureBridge().beginPhoneLogin(this.credentials.apiId, this.credentials.apiHash, this.loginTargetUserId ?? undefined);
    },

    submitLoginValue(value: string) {
      if (!value.trim()) return;
      if (this.loginStage === 'phone') { this.ensureBridge().provide('phone', value.trim()); return; }
      if (this.loginStage === 'code') { this.ensureBridge().provide('code', value.trim()); return; }
      if (this.loginStage === 'password') this.ensureBridge().provide('password', value);
    },

    closeLogin() {
      this.ensureBridge().cancel();
      if (this.loginTargetUserId) this.connectionStates[this.loginTargetUserId] = 'offline';
      this.finishLoginUi();
    },

    /** 认证完成后仅关闭登录 UI；保留本机 MTProto 连接及设备锁。 */
    finishLoginUi() {
      this.loginStage = 'idle';
      this.loginTargetUserId = null;
      this.resetQrState();
      this.phoneInput = ''; this.codeInput = ''; this.passwordInput = '';
    },

    async handleBridgeEvent(event: LoginEvent) {
      if (event.type === 'qr') {
        this.loginStage = 'qr';
        this.qrToken = event.token;
        this.qrImage = event.image;
        this.qrExpiresAt = event.expires * 1000;
        return;
      }
      if (event.type === 'stage') { this.loginStage = event.stage; return; }
      // 聊天更新由 chat 域订阅处理，telegram 域只关心连接与设备。
      if (event.type === 'chatUpdates') return;
      if (event.type === 'authorized') {
        this.connectionStates[event.user.id] = 'online';
        this.currentAccountId = event.user.id;
        await this.persistAuthorization(event);
        return;
      }
      if (event.type === 'connectionState') {
        this.connectionStates[event.accountId] = event.state;
        if (event.message) this.connectionNotices[event.accountId] = event.message;
        else delete this.connectionNotices[event.accountId];
        return;
      }
      if (event.type === 'restored') {
        clearRestoreRetry();
        restoreAttempts = 0;
        this.connectionStates[event.user.id] = 'online';
        delete this.connectionNotices[event.user.id];
        this.currentAccountId = event.user.id;
        this.startDeviceHeartbeat(event.user.id);
        return;
      }
      if (event.type === 'restoreFailed') {
        this.handleRestoreFailure(event.accountId, event.reason, event.message);
        return;
      }
      if (event.type === 'elected') {
        if (this.loginStage === 'qr' || this.loginStage === 'phone') this.startQrLogin();
        else if (this.loginStage === 'idle') void this.restoreLocalSessions();
        return;
      }
      if (event.type === 'accountDisconnected' || event.type === 'sessionStopped') {
        if (event.accountId) {
          this.connectionStates[event.accountId] = 'offline';
          await this.stopDeviceHeartbeat(event.accountId);
        }
        return;
      }
      if (event.type === 'error') {
        const transient = event.code === 'CONNECTION_NOT_INITED' || event.code === 'CONNECTION_TIMEOUT' || event.code === 'TIMEOUT' || event.message.toUpperCase().includes('DISCONNECTED');
        if (transient) {
          if (this.loginTargetUserId) this.connectionNotices[this.loginTargetUserId] = 'Telegram 连接短暂中断，正在重连…';
          return;
        }
      }
      this.error = event.code ? `${event.message}（${event.code}）` : event.message;
      if (event.code?.startsWith('DEVICE_') || event.code === 'TG_ACCOUNT_MISMATCH') {
        if (this.loginTargetUserId) this.connectionStates[this.loginTargetUserId] = 'offline';
        this.finishLoginUi();
      }
    },

    /** 会话只在本机加密落盘（含应用凭据以支持下次冷启动 0 等待直连）；远端只记录「哪个设备授权了哪个账户」。 */
    async persistAuthorization(event: Extract<LoginEvent, { type: 'authorized' }>) {
      const { user, session } = event;
      this.loginStage = 'ready';
      try {
        await tgSessionVault.save(user.id, {
          dcId: user.dcId ?? 2,
          stringSession: session,
          apiId: this.credentials?.apiId,
          apiHash: this.credentials?.apiHash,
          ownerId: ownerId ?? undefined,
        });
        writeActiveAccountId(user.id);
        await tgRemoteDataSource.bindAccount({
          tgUserId: user.id,
          username: user.username,
          firstName: user.firstName,
          lastName: user.lastName,
          phone: user.phone,
          isPremium: user.premium,
          homeDc: user.dcId,
          device: {
            deviceId: tgSessionVault.deviceId(),
            deviceLabel: navigator.platform || 'Lattice Archive',
            platform: PLATFORM,
            appVersion: APP_VERSION,
          },
        });
        await this.refreshAccounts();
        if (this.connectionStates[user.id] === 'online') this.startDeviceHeartbeat(user.id);
        this.finishLoginUi();
      } catch (error) {
        this.ensureBridge().disconnectSession();
        this.error = `登录成功，但绑定同步失败：${this.readError(error)}`;
        this.loginStage = 'idle';
      }
    },

    readError(error: unknown) { return error instanceof Error ? error.message : 'Telegram 请求失败，请稍后重试'; },
  },
});
