/**
 * ============================================================================
 * 管理端「用户管理」Store（列表 / 搜索 / 排序 / 分页 / 新增 / 删除）
 * ============================================================================
 * 设计要点：
 *   · 所有表格交互状态（页码、排序、关键字、弹窗开关、表单值）均在此处，
 *     视图只负责把事件转发过来；
 *   · requestVersion 是竞态守卫：快速翻页时只采用最后一次请求的结果；
 *   · 任何 401 都直接清本地会话，让路由守卫把用户踢回管理员登录页。
 */
import { defineStore } from 'pinia';
import { useAuthStore } from '@/stores/auth/stores/authStore';
import { RemoteAuthError } from '@/stores/auth/data-sources/authRemoteDataSource';
import { adminUsersRemoteDataSource as remote } from '../data-sources/adminUsersRemoteDataSource';
import type { ManagedUser, UserSort } from '../types';

export const useAdminUsersStore = defineStore('admin-users', {
  state: () => ({
    // ── 表格数据与分页 ──
    users: [] as ManagedUser[], page: 1, pageSize: 20, total: 0, totalPages: 1,
    // ── 查询条件：searchInput 是输入框实时值，search 是「已提交」的关键字 ──
    searchInput: '', search: '', sort: 'created_at' as UserSort, direction: 'desc' as 'asc' | 'desc',
    // ── 各维度的加载/错误状态（分开存，避免一个报错污染整页）──
    isLoading: false, isSaving: false, isDeleting: false, requestVersion: 0,
    error: '', formError: '', deleteError: '', notice: '',
    // ── 弹窗状态 ──
    isCreateOpen: false, deleteTarget: null as ManagedUser | null,
    // ── 新增表单（禁用视图本地 ref）──
    nameInput: '', emailInput: '', passwordInput: '',
  }),
  actions: {
    /** 取出管理员 Token；没有就直接抛 401，避免发出必然失败的请求 */
    token() {
      const auth = useAuthStore();
      if (!auth.isAdmin || !auth.sessionToken) throw new RemoteAuthError('管理员会话已失效，请重新登录', 'UNAUTHORIZED', 401);
      return auth.sessionToken;
    },
    /** 错误归一化：401 顺手登出并清空表格；其余只取文案 */
    errorMessage(error: unknown) {
      if (error instanceof RemoteAuthError && error.status === 401) {
        useAuthStore().clearLocalSession();
        this.users = []; this.total = 0;
      }
      return error instanceof Error ? error.message : '请求失败，请稍后重试';
    },
    /** 拉取当前页数据（页码/排序/关键字都从 state 读） */
    async load() {
      const version = ++this.requestVersion; // 本次请求的版本号
      this.isLoading = true; this.error = '';
      try {
        const result = await remote.list(this.token(), this.page, this.pageSize, this.search, this.sort, this.direction);
        if (version !== this.requestVersion) return; // 已有更新的请求发出，丢弃本次结果
        this.total = result.pagination.total; this.totalPages = result.pagination.totalPages;
        // 边界修正：例如删光最后一页后页码越界，回到最后一个有效页
        if (this.page > this.totalPages) { this.page = this.totalPages; await this.load(); return; }
        this.users = result.users;
      } catch (error) { if (version === this.requestVersion) this.error = this.errorMessage(error); }
      finally { if (version === this.requestVersion) this.isLoading = false; }
    },
    setSearchInput(value: string) { this.searchInput = value; },
    /** 回车/点搜索才真正查询，避免每敲一个字就打一次接口 */
    async applySearch() { this.search = this.searchInput.trim(); this.page = 1; this.notice = ''; await this.load(); },
    /** 翻页：越界或正在加载时忽略 */
    async setPage(page: number) { if (page < 1 || page > this.totalPages || this.isLoading) return; this.page = page; this.notice = ''; await this.load(); },
    /** 改每页条数：重置回第一页 */
    async setPageSize(value: number) { this.pageSize = value; this.page = 1; this.notice = ''; await this.load(); },
    /** 排序：字段不在白名单时回退到 created_at，防止服务端拒绝 */
    async setSort(field: string, order: string | null) {
      this.sort = field === 'name' || field === 'email' ? field : 'created_at';
      this.direction = order === 'asc' ? 'asc' : 'desc'; this.page = 1; this.notice = ''; await this.load();
    },
    /** 打开新增弹窗：每次清空表单与上一次的错误 */
    openCreate() { this.nameInput = ''; this.emailInput = ''; this.passwordInput = ''; this.formError = ''; this.isCreateOpen = true; },
    /** 关闭弹窗：保存中不允许关闭，防止请求飞行中状态错乱 */
    closeCreate() { if (this.isSaving) return; this.isCreateOpen = false; this.passwordInput = ''; },
    setNameInput(value: string) { this.nameInput = value; this.formError = ''; },
    setEmailInput(value: string) { this.emailInput = value; this.formError = ''; },
    setPasswordInput(value: string) { this.passwordInput = value; this.formError = ''; },
    /** 前端预校验（长度/邮箱格式），服务端仍会再校验一次 */
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
    /** 打开删除确认弹窗（记录待删除目标，清空上次错误） */
    askDelete(user: ManagedUser) { this.deleteTarget = user; this.deleteError = ''; },
    closeDelete() { if (!this.isDeleting) this.deleteTarget = null; },
    /** 确认删除：服务端会连带清理该用户的会话 Token */
    async remove() {
      if (!this.deleteTarget || this.isDeleting) return;
      this.isDeleting = true; this.deleteError = ''; this.notice = '';
      try {
        await remote.remove(this.token(), this.deleteTarget.id);
        this.deleteTarget = null; await this.load(); this.notice = '用户及其远端会话已删除';
      } catch (error) { this.deleteError = this.errorMessage(error); }
      finally { this.isDeleting = false; }
    },
    /** 离开页面时重置：requestVersion+1 使飞行中的请求结果作废 */
    dispose() {
      this.requestVersion++; this.isLoading = false; this.users = []; this.total = 0;
      this.passwordInput = ''; this.isCreateOpen = false; this.deleteTarget = null; this.notice = ''; this.error = '';
    },
  },
});
