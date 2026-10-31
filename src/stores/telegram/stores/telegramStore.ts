import { defineStore } from 'pinia';
import { tgRemoteDataSource, type TelegramAccount, type TelegramCredentials, type TelegramAuthorization } from '../data-sources/tgRemoteDataSource';
import { MtprotoBridge, type LoginEvent, type ValidationReport } from '../data-sources/mtprotoBridge';
import { tgSessionVault } from '../data-sources/tgSessionVault';

export type LoginStage = 'idle' | 'qr' | 'phone' | 'code' | 'password' | 'ready';

const APP_VERSION = '2.0.0';
const PLATFORM = 'web' as const;

/** 单例接线器不能进 Pinia state（store 只存可序列化页面态），因此放在模块作用域。 */
let bridge: MtprotoBridge | null = null;

export const useTelegramStore = defineStore('telegram', {
  state: () => ({
    apiIdInput: '',
    apiHashInput: '',
    credentials: null as TelegramCredentials | null,
    validationReport: null as ValidationReport | null,
    accounts: [] as TelegramAccount[],
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
    activeAuthorizations: (state): TelegramAuthorization[] => state.accounts
      .flatMap((account) => account.authorizations)
      .filter((item) => item.session_state === 'active'),
  },
  actions: {
    setApiIdInput(value: string) { this.apiIdInput = value; this.error = null; },
    setApiHashInput(value: string) { this.apiHashInput = value; this.error = null; },
    setPhoneInput(value: string) { this.phoneInput = value; },
    setCodeInput(value: string) { this.codeInput = value; },
    setPasswordInput(value: string) { this.passwordInput = value; },

    async load() {
      this.isLoading = true;
      this.error = null;
      try {
        const [credentials, accounts] = await Promise.all([
          tgRemoteDataSource.getCredentials(),
          tgRemoteDataSource.getAccounts(),
        ]);
        this.credentials = credentials;
        this.accounts = accounts;
        this.apiIdInput = credentials ? String(credentials.apiId) : '';
      } catch (error) {
        this.error = this.readError(error);
      } finally {
        this.isLoading = false;
      }
    },

    ensureBridge() {
      if (!bridge) bridge = new MtprotoBridge((event) => { void this.handleBridgeEvent(event); });
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
        if (cascade) this.accounts = [];
      } catch (error) {
        this.error = this.readError(error);
      }
    },

    async refreshAccounts() {
      try {
        this.accounts = await tgRemoteDataSource.getAccounts();
      } catch (error) {
        this.error = this.readError(error);
      }
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

    openLogin() {
      if (!this.credentials) { this.error = '请先验证并保存应用凭据'; return; }
      this.error = null;
      this.phoneInput = ''; this.codeInput = ''; this.passwordInput = '';
      this.startQrLogin();
    },

    startQrLogin() {
      if (!this.credentials) { this.error = '请先验证并保存应用凭据'; return; }
      this.resetQrState();
      this.loginStage = 'qr';
      this.ensureBridge().beginQrLogin(
        this.credentials.apiId,
        this.credentials.apiHash,
        this.accounts.map((account) => account.tg_user_id),
      );
    },

    switchToQrLogin() { this.startQrLogin(); },

    switchToPhoneLogin() {
      if (!this.credentials) { this.error = '请先验证并保存应用凭据'; return; }
      this.error = null;
      this.resetQrState();
      this.loginStage = 'phone';
      this.ensureBridge().beginPhoneLogin(this.credentials.apiId, this.credentials.apiHash);
    },

    submitLoginValue(value: string) {
      if (!value.trim()) return;
      if (this.loginStage === 'phone') { this.ensureBridge().provide('phone', value.trim()); return; }
      if (this.loginStage === 'code') { this.ensureBridge().provide('code', value.trim()); return; }
      if (this.loginStage === 'password') this.ensureBridge().provide('password', value);
    },

    closeLogin() {
      this.ensureBridge().cancel();
      this.loginStage = 'idle';
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
      if (event.type === 'authorized') { await this.persistAuthorization(event); return; }
      this.error = event.code ? `${event.message}（${event.code}）` : event.message;
    },

    /** 会话只在本机加密落盘；远端只记录「哪个设备授权了哪个账户」。 */
    async persistAuthorization(event: Extract<LoginEvent, { type: 'authorized' }>) {
      const { user, session } = event;
      this.loginStage = 'ready';
      try {
        await tgSessionVault.save(user.id, { dcId: user.dcId ?? 2, stringSession: session });
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
        this.closeLogin();
      } catch (error) {
        this.error = `登录成功，但绑定同步失败：${this.readError(error)}`;
        this.loginStage = 'idle';
      }
    },

    readError(error: unknown) { return error instanceof Error ? error.message : 'Telegram 请求失败，请稍后重试'; },
  },
});
