/**
 * ============================================================================
 * 认证业务层（校验 → 查库 → 签发会话）
 * ============================================================================
 * 安全要点（改动前必读）：
 *   · 先做 Turnstile 服务端校验，失败一律 fail-closed；
 *   · 账户不存在时也执行一次虚拟 PBKDF2，防止通过响应耗时枚举邮箱；
 *   · 返回给前端的数据一律经过 profile() 白名单投影，绝不带哈希/盐。
 */
import { createSession, createUser, findEmail, findSession, findUser, removeExpiredSessions, deleteSession, touchSession } from './repository';
import { generateSessionToken, hashPassword, hashSessionToken, verifyDummyPassword, verifyPassword } from './crypto';
import { AuthError, type AuthBody, type Role, type SessionResult, type TurnstileAction, type UserProfile } from './types';
import { verifyTurnstileToken } from './turnstile';

/** 白名单投影：只挑可以公开的字段，避免把 password_hash 之类顺手漏出去 */
function profile(user: UserProfile): UserProfile { return { id: user.id, name: user.name, email: user.email, initials: user.initials, role: user.role }; }

/** 邮箱 / 密码格式校验（注册与登录共用）；长度上限防止超长串拖垮哈希计算 */
function validateCredentials(email: unknown, password: unknown): { email: string; password: string } {
  if (typeof email !== 'string' || email.trim().length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AuthError('INVALID_EMAIL', '请输入有效的邮箱地址');
  if (typeof password !== 'string' || password.length < 8 || password.length > 256) throw new AuthError('INVALID_PASSWORD', '密码长度需为 8 至 256 位');
  return { email: email.trim(), password };
}
/**
 * 签发会话：生成随机 Token → 只把摘要存库 → 明文 Token 随响应返回给客户端。
 * 所以服务端此后永远无法「读出」用户的 Token，只能校验摘要。
 */
async function issue(db: D1Database, user: UserProfile, keep: boolean, request: Request): Promise<SessionResult> {
  const token = await generateSessionToken();
  const expiresAt = await createSession(db, await hashSessionToken(token), user, keep, request, Date.now());
  return { user: profile(user), session: { token, expiresAt, serverConnected: true } };
}

/**
 * 登录（普通用户与管理员共用，通过 role 参数区分）。
 * @param action Turnstile 的 action，必须与前端 render 时声明的值一致
 */
export async function authenticate(request: Request, env: Env, action: TurnstileAction, role: Role, body: AuthBody, ctx: ExecutionContext) {
  const credentials = validateCredentials(body.email, body.password);
  // 并行执行「人机验证」与「查用户」，节省一次往返 RTT
  const [turnstileOk, user] = await Promise.all([
    verifyTurnstileToken(body.turnstileToken, action, request, env),
    findUser(env.AUTH_DB, credentials.email, role),
  ]);
  if (!turnstileOk) throw new AuthError('TURNSTILE_FAILED', '人机安全验证未通过，请重试', 403);
  // 用户存在则真校验；不存在也跑一次等价耗时的虚拟派生，然后统一报「邮箱或密码错误」
  const valid = user ? await verifyPassword(credentials.password, user.password_salt, user.password_hash, user.iterations) : (await verifyDummyPassword(credentials.password), false);
  if (!user || !valid) throw new AuthError('INVALID_CREDENTIALS', '邮箱或密码错误', 401);
  // waitUntil：过期会话清理不阻塞响应，也不因失败影响登录
  ctx.waitUntil(removeExpiredSessions(env.AUTH_DB, user.id, Date.now()));
  return issue(env.AUTH_DB, user, body.keepSignedIn === true, request);
}

/**
 * 注册普通用户（只能注册 user，不存在公开的管理员注册接口）。
 * 三步并行：人机验证 / 邮箱查重 / 密码哈希，之后插入用户并直接签发会话。
 */
export async function register(request: Request, env: Env, body: AuthBody): Promise<SessionResult> {
  const credentials = validateCredentials(body.email, body.password);
  if (typeof body.name !== 'string' || body.name.trim().length < 1 || body.name.trim().length > 80) throw new AuthError('INVALID_NAME', '用户名长度需为 1 至 80 个字符');
  // 邮箱统一小写存储，避免 Alice@x.com 与 alice@x.com 注册出两个账号
  const email = credentials.email.toLowerCase();
  const [turnstileOk, existing, passwordData] = await Promise.all([
    verifyTurnstileToken(body.turnstileToken, 'register', request, env),
    findEmail(env.AUTH_DB, email),
    hashPassword(credentials.password),
  ]);
  if (!turnstileOk) throw new AuthError('TURNSTILE_FAILED', '人机安全验证未通过，请重试', 403);
  if (existing) throw new AuthError('EMAIL_TAKEN', '该邮箱已注册', 409);
  const name = body.name.trim();
  // initials（头像文字）取名字前两个字符并大写；Array.from 保证中文/emoji 不会被截断成乱码
  const user: UserProfile = { id: crypto.randomUUID(), name, email, initials: Array.from(name).slice(0, 2).join('').toUpperCase(), role: 'user' };
  await createUser(env.AUTH_DB, user, passwordData, Date.now());
  return issue(env.AUTH_DB, user, body.keepSignedIn === true, request);
}

/** 从 Authorization 头取出 Bearer Token；缺失或格式不对直接 401 */
function bearer(request: Request): string {
  const header = request.headers.get('Authorization');
  if (!header?.startsWith('Bearer ') || header.length <= 7) throw new AuthError('UNAUTHORIZED', '会话无效，请重新登录', 401);
  return header.slice(7);
}

/**
 * 冷启动会话校准：前端拿着本地 Token 来换取最新用户资料与过期时间。
 * 发现会话过期/角色不一致时顺便删除脏数据，并抛 401 让前端清理本地会话。
 */
export async function connectSession(request: Request, env: Env, ctx: ExecutionContext) {
  const hash = await hashSessionToken(bearer(request));
  const session = await findSession(env.AUTH_DB, hash);
  const now = Date.now();
  if (!session || session.expires_at <= now || session.session_role !== session.role) {
    await deleteSession(env.AUTH_DB, hash);
    throw new AuthError('UNAUTHORIZED', '会话已失效，请重新登录', 401);
  }
  ctx.waitUntil(touchSession(env.AUTH_DB, hash, now));
  // session 是 JOIN 出来的行，字段与 UserProfile 兼容，再走一次白名单投影
  return { connected: true, serverTime: now, sessionExpiresAt: session.expires_at, user: profile(session) };
}

/** 退出登录：直接删掉会话行（Token 随即失效，本地清理由前端负责） */
export async function logout(request: Request, env: Env) {
  await deleteSession(env.AUTH_DB, await hashSessionToken(bearer(request)));
  return { loggedOut: true };
}
