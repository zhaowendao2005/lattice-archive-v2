/**
 * ============================================================================
 * Turnstile 服务端校验（fail-closed）
 * ============================================================================
 * 除了 success === true，还必须同时满足：
 *   · result.action 与本次操作一致（防止拿「注册」的令牌去调「管理员登录」）；
 *   · result.hostname 命中 TURNSTILE_HOSTNAMES 白名单（防止在其他站点刷令牌）。
 * 任何异常（超时、网络错、非法响应）都返回 false，宁可拒绝也不能放过。
 */
import type { TurnstileAction } from './types';

interface SiteverifyResult { success?: boolean; action?: string; hostname?: string }

export async function verifyTurnstileToken(token: unknown, action: TurnstileAction, request: Request, env: Env): Promise<boolean> {
  // 基础校验：Token 必须是非空字符串且不太长；Secret 未配置则直接失败
  if (typeof token !== 'string' || token.length === 0 || token.length > 2048 || !env.TURNSTILE_SECRET) return false;
  // 主机名白名单为空说明配置缺失，同样拒绝
  const hostnames = new Set(env.TURNSTILE_HOSTNAMES.split(',').map((host) => host.trim()).filter(Boolean));
  if (!hostnames.size) return false;
  try {
    const body = new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token });
    // 附带客户端 IP，让 Cloudflare 侧也能做风控
    const ip = request.headers.get('CF-Connecting-IP');
    if (ip) body.set('remoteip', ip);
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return false;
    const result = await response.json() as SiteverifyResult;
    // 四个条件全部满足才算通过
    return result.success === true && result.action === action && typeof result.hostname === 'string' && hostnames.has(result.hostname);
  } catch { return false; }
}
