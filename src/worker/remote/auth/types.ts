export type Role = 'user' | 'admin';
export type TurnstileAction = 'login' | 'register' | 'admin_login';
export interface UserProfile { id: string; name: string; email: string; initials: string; role: Role }
export interface UserRow extends UserProfile { password_hash: string; password_salt: string; iterations: number }
export interface AuthBody { email?: unknown; password?: unknown; name?: unknown; turnstileToken?: unknown; keepSignedIn?: unknown }
export interface SessionResult { user: UserProfile; session: { token: string; expiresAt: number; serverConnected: true } }
export class AuthError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 400) { super(message); this.code = code; this.status = status; }
}
