/**
 * 管理域共享类型（与 Worker /api/admin/users 的响应结构一一对应）
 * 注意：role 固定为 'user'——管理接口只能增删普通用户，不存在「创建管理员」能力。
 */

/** 管理表格里的一行用户 */
export interface ManagedUser {
  id: string; name: string; email: string; initials: string; role: 'user'; created_at: number; updated_at: number;
}

/** 分页列表响应：数据 + 分页元信息 */
export interface UsersResult {
  users: ManagedUser[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
}

/** 表格允许的排序字段白名单（必须与服务端一致，否则会被忽略） */
export type UserSort = 'created_at' | 'name' | 'email';
