import { createSession, createUser, findEmail, findSession, findUser, removeExpiredSessions, deleteSession, touchSession } from './repository';
import { generateSessionToken, hashPassword, hashSessionToken, verifyDummyPassword, verifyPassword } from './crypto';
import { AuthError, type AuthBody, type Role, type SessionResult, type TurnstileAction, type UserProfile } from './types';
import { verifyTurnstileToken } from './turnstile';

function profile(user: UserProfile): UserProfile { return { id: user.id, name: user.name, email: user.email, initials: user.initials, role: user.role }; }
function validateCredentials(email: unknown, password: unknown): { email: string; password: string } {
  if (typeof email !== 'string' || email.trim().length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AuthError('INVALID_EMAIL', '请输入有效的邮箱地址');
  if (typeof password !== 'string' || password.length < 8 || password.length > 256) throw new AuthError('INVALID_PASSWORD', '密码长度需为 8 至 256 位');
  return { email: email.trim(), password };
}
async function issue(db: D1Database, user: UserProfile, keep: boolean, request: Request): Promise<SessionResult> {
  const token = await generateSessionToken();
  const expiresAt = await createSession(db, await hashSessionToken(token), user, keep, request, Date.now());
  return { user: profile(user), session: { token, expiresAt, serverConnected: true } };
}

export async function authenticate(request: Request, env: Env, action: TurnstileAction, role: Role, body: AuthBody, ctx: ExecutionContext) {
  if (!await verifyTurnstileToken(body.turnstileToken, action, request, env)) throw new AuthError('TURNSTILE_FAILED', '人机安全验证未通过，请重试', 403);
  const credentials = validateCredentials(body.email, body.password);
  const user = await findUser(env.AUTH_DB, credentials.email, role);
  const valid = user ? await verifyPassword(credentials.password, user.password_salt, user.password_hash, user.iterations) : (await verifyDummyPassword(credentials.password), false);
  if (!user || !valid) throw new AuthError('INVALID_CREDENTIALS', '邮箱或密码错误', 401);
  ctx.waitUntil(removeExpiredSessions(env.AUTH_DB, user.id, Date.now()));
  return issue(env.AUTH_DB, user, body.keepSignedIn === true, request);
}

export async function register(request: Request, env: Env, body: AuthBody): Promise<SessionResult> {
  if (!await verifyTurnstileToken(body.turnstileToken, 'register', request, env)) throw new AuthError('TURNSTILE_FAILED', '人机安全验证未通过，请重试', 403);
  const credentials = validateCredentials(body.email, body.password);
  if (typeof body.name !== 'string' || body.name.trim().length < 1 || body.name.trim().length > 80) throw new AuthError('INVALID_NAME', '用户名长度需为 1 至 80 个字符');
  const email = credentials.email.toLowerCase();
  if (await findEmail(env.AUTH_DB, email)) throw new AuthError('EMAIL_TAKEN', '该邮箱已注册', 409);
  const name = body.name.trim();
  const user: UserProfile = { id: crypto.randomUUID(), name, email, initials: Array.from(name).slice(0, 2).join('').toUpperCase(), role: 'user' };
  await createUser(env.AUTH_DB, user, await hashPassword(credentials.password), Date.now());
  return issue(env.AUTH_DB, user, body.keepSignedIn === true, request);
}

function bearer(request: Request): string {
  const header = request.headers.get('Authorization');
  if (!header?.startsWith('Bearer ') || header.length <= 7) throw new AuthError('UNAUTHORIZED', '会话无效，请重新登录', 401);
  return header.slice(7);
}

export async function connectSession(request: Request, env: Env) {
  const hash = await hashSessionToken(bearer(request));
  const session = await findSession(env.AUTH_DB, hash);
  const now = Date.now();
  if (!session || session.expires_at <= now || session.session_role !== session.role) {
    await deleteSession(env.AUTH_DB, hash);
    throw new AuthError('UNAUTHORIZED', '会话已失效，请重新登录', 401);
  }
  await touchSession(env.AUTH_DB, hash, now);
  return { connected: true, serverTime: now, sessionExpiresAt: session.expires_at, user: profile(session) };
}

export async function logout(request: Request, env: Env) {
  await deleteSession(env.AUTH_DB, await hashSessionToken(bearer(request)));
  return { loggedOut: true };
}
