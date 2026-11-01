/**
 * ============================================================================
 * 全局运行环境识别模块 (Application Environment Detection)
 * ============================================================================
 * 区分三种运行时环境：
 * 1. prod: 线上正式生产环境（连接远端 Cloudflare Workers、真实 Turnstile 与 D1 生产库）
 * 2. dev-real: 本地开发真实环境（连接本地 Worker 8787、本地 SQLite D1 库、本地 MTProto）
 * 3. dev-mock: 本地开发 Mock 环境（免密秒进工作区、Turnstile 模拟放行、本地原型数据）
 */

export type AppEnv = 'prod' | 'dev-real' | 'dev-mock';

/** 获取当前应用环境 */
export function getAppEnv(): AppEnv {
  if (import.meta.env.PROD || import.meta.env.MODE === 'production') {
    return 'prod';
  }
  const mode = import.meta.env.MODE;
  const flag = (import.meta.env.VITE_APP_ENV as string | undefined)?.toLowerCase();

  if (mode === 'real' || mode === 'dev-real' || flag === 'real' || flag === 'dev-real') {
    return 'dev-real';
  }

  // dev 默认一律指向 mock dev
  return 'dev-mock';
}

export const isDev = import.meta.env.DEV;
export const isMockDev = getAppEnv() === 'dev-mock';
export const isRealDev = getAppEnv() === 'dev-real';
export const isProd = getAppEnv() === 'prod';

/** 环境可读中文标识 */
export const ENV_LABELS: Record<AppEnv, string> = {
  prod: '线上正式环境',
  'dev-real': 'Dev 本地真实环境',
  'dev-mock': 'Dev Mock 环境',
};
