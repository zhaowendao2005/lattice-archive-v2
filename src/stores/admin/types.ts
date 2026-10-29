export interface ManagedUser {
  id: string; name: string; email: string; initials: string; role: 'user'; created_at: number; updated_at: number;
}
export interface UsersResult {
  users: ManagedUser[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
}
export type UserSort = 'created_at' | 'name' | 'email';
