import { defineStore } from 'pinia';
import { useAuthStore } from '@/stores/auth/stores/authStore';
import { RemoteAuthError } from '@/stores/auth/data-sources/authRemoteDataSource';
import { adminUsersRemoteDataSource as remote } from '../data-sources/adminUsersRemoteDataSource';
import type { ManagedUser, UserSort } from '../types';

export const useAdminUsersStore = defineStore('admin-users', {
  state: () => ({
    users: [] as ManagedUser[], page: 1, pageSize: 20, total: 0, totalPages: 1,
    searchInput: '', search: '', sort: 'created_at' as UserSort, direction: 'desc' as 'asc' | 'desc',
    isLoading: false, isSaving: false, isDeleting: false, requestVersion: 0,
    error: '', formError: '', deleteError: '', notice: '',
    isCreateOpen: false, deleteTarget: null as ManagedUser | null,
    nameInput: '', emailInput: '', passwordInput: '',
  }),
  actions: {
    token() {
      const auth = useAuthStore();
      if (!auth.isAdmin || !auth.sessionToken) throw new RemoteAuthError('管理员会话已失效，请重新登录', 'UNAUTHORIZED', 401);
      return auth.sessionToken;
    },
    errorMessage(error: unknown) {
      if (error instanceof RemoteAuthError && error.status === 401) {
        useAuthStore().clearLocalSession();
        this.users = []; this.total = 0;
      }
      return error instanceof Error ? error.message : '请求失败，请稍后重试';
    },
    async load() {
      const version = ++this.requestVersion;
      this.isLoading = true; this.error = '';
      try {
        const result = await remote.list(this.token(), this.page, this.pageSize, this.search, this.sort, this.direction);
        if (version !== this.requestVersion) return;
        this.total = result.pagination.total; this.totalPages = result.pagination.totalPages;
        if (this.page > this.totalPages) { this.page = this.totalPages; await this.load(); return; }
        this.users = result.users;
      } catch (error) { if (version === this.requestVersion) this.error = this.errorMessage(error); }
      finally { if (version === this.requestVersion) this.isLoading = false; }
    },
    setSearchInput(value: string) { this.searchInput = value; },
    async applySearch() { this.search = this.searchInput.trim(); this.page = 1; this.notice = ''; await this.load(); },
    async setPage(page: number) { if (page < 1 || page > this.totalPages || this.isLoading) return; this.page = page; this.notice = ''; await this.load(); },
    async setPageSize(value: number) { this.pageSize = value; this.page = 1; this.notice = ''; await this.load(); },
    async setSort(field: string, order: string | null) {
      this.sort = field === 'name' || field === 'email' ? field : 'created_at';
      this.direction = order === 'asc' ? 'asc' : 'desc'; this.page = 1; this.notice = ''; await this.load();
    },
    openCreate() { this.nameInput = ''; this.emailInput = ''; this.passwordInput = ''; this.formError = ''; this.isCreateOpen = true; },
    closeCreate() { if (this.isSaving) return; this.isCreateOpen = false; this.passwordInput = ''; },
    setNameInput(value: string) { this.nameInput = value; this.formError = ''; },
    setEmailInput(value: string) { this.emailInput = value; this.formError = ''; },
    setPasswordInput(value: string) { this.passwordInput = value; this.formError = ''; },
    async create() {
      if (this.isSaving) return;
      if (!this.nameInput.trim() || this.nameInput.trim().length > 80) { this.formError = '用户名需为 1 至 80 个字符'; return; }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(this.emailInput.trim())) { this.formError = '请输入有效的邮箱地址'; return; }
      if (this.passwordInput.length < 8 || this.passwordInput.length > 256) { this.formError = '密码长度需为 8 至 256 位'; return; }
      this.isSaving = true; this.formError = ''; this.notice = '';
      try {
        await remote.create(this.token(), { name: this.nameInput.trim(), email: this.emailInput.trim(), password: this.passwordInput });
        this.passwordInput = ''; this.isCreateOpen = false; this.page = 1; await this.load(); this.notice = '用户已创建';
      } catch (error) { this.formError = this.errorMessage(error); }
      finally { this.isSaving = false; }
    },
    askDelete(user: ManagedUser) { this.deleteTarget = user; this.deleteError = ''; },
    closeDelete() { if (!this.isDeleting) this.deleteTarget = null; },
    async remove() {
      if (!this.deleteTarget || this.isDeleting) return;
      this.isDeleting = true; this.deleteError = ''; this.notice = '';
      try {
        await remote.remove(this.token(), this.deleteTarget.id);
        this.deleteTarget = null; await this.load(); this.notice = '用户及其远端会话已删除';
      } catch (error) { this.deleteError = this.errorMessage(error); }
      finally { this.isDeleting = false; }
    },
    dispose() {
      this.requestVersion++; this.isLoading = false; this.users = []; this.total = 0;
      this.passwordInput = ''; this.isCreateOpen = false; this.deleteTarget = null; this.notice = ''; this.error = '';
    },
  },
});
