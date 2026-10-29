import type { TurnstileAction } from './types';

interface SiteverifyResult { success?: boolean; action?: string; hostname?: string }

export async function verifyTurnstileToken(token: unknown, action: TurnstileAction, request: Request, env: Env): Promise<boolean> {
  if (typeof token !== 'string' || token.length === 0 || token.length > 2048 || !env.TURNSTILE_SECRET) return false;
  const hostnames = new Set(env.TURNSTILE_HOSTNAMES.split(',').map((host) => host.trim()).filter(Boolean));
  if (!hostnames.size) return false;
  try {
    const body = new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token });
    const ip = request.headers.get('CF-Connecting-IP');
    if (ip) body.set('remoteip', ip);
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return false;
    const result = await response.json() as SiteverifyResult;
    return result.success === true && result.action === action && typeof result.hostname === 'string' && hostnames.has(result.hostname);
  } catch { return false; }
}
