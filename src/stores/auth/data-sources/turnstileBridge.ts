/**
 * ============================================================================
 * Turnstile（Cloudflare 人机验证）桥接层
 * ============================================================================
 * 为何需要这层：Turnstile 是命令式、带全局单例的第三方 SDK，而视图禁止持有 ref/DOM 句柄。
 * 所以：
 *   · widgetId / 装载序号 等 DOM 句柄全部保存在本模块（模块级变量，不进组件）；
 *   · 验证令牌统一写回 authStore.turnstileToken，表单只读 Store。
 *
 * 服务端会再校验一次（success + action + hostname），前端这层只是体验优化。
 */
import { useAuthStore } from '../stores/authStore';

/** Turnstile 的 action 值：必须与服务端校验的白名单一致，否则验证失败 */
type Action = 'login' | 'register' | 'admin_login';
interface TurnstileApi { render: (container: string | HTMLElement, options: Record<string, unknown>) => string; reset: (id?: string) => void; remove: (id: string) => void }
declare global { interface Window { turnstile?: TurnstileApi } }

// SDK 脚本只加载一次：用 Promise 缓存并发请求
let loading: Promise<TurnstileApi> | null = null;
// 当前已挂载的 widget（action + widgetId），用于重置/移除
let active: { action: Action; widgetId: string } | null = null;
// 装载序号：每次 mount/unmount 递增，用于丢弃「过时的异步回调」（竞态防护）
let mountSequence = 0;

/** 动态插入 Turnstile 脚本（render=explicit 表示不自动扫描，由我们手动 render） */
function loadScript(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (!loading) loading = new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.async = true; script.defer = true;
    script.onload = () => window.turnstile ? resolve(window.turnstile) : reject(new Error('Turnstile 未就绪'));
    script.onerror = () => { script.remove(); reject(new Error('无法加载人机验证组件')); };
    document.head.append(script);
  }).catch((error) => {
    // 加载失败要把缓存置空，否则后续重试会拿到同一个已拒绝的 Promise
    loading = null;
    throw error;
  });
  return loading;
}

export const turnstileBridge = {
  /**
   * 在指定容器中挂载验证控件。
   * 每个页面（登录/注册/管理员登录）复用同一个组件，但容器 DOM 不同，
   * 因此这里先按 action 去重，再渲染。
   */
  async mount(action: Action, containerId: string) {
    const store = useAuthStore();
    const seq = ++mountSequence; // 本次装载的序号，异步返回后比对这个值判是否过时
    store.setTurnstileToken(''); // 每次挂载都清空旧令牌，防止重放
    const siteKey = import.meta.env.VITE_TURNSTILE_SITEKEY as string | undefined;
    if (!siteKey) { store.setTurnstileReady(false); store.setAuthError('尚未配置人机验证，请联系管理员'); return; }
    try {
      const api = await loadScript();
      if (seq !== mountSequence) return; // 已发生新的挂载/卸载，本次舍弃
      const container = document.getElementById(containerId);
      if (!container || active?.action === action) return;
      if (active) { api.remove(active.widgetId); active = null; }
      const widgetId = api.render(container, {
        sitekey: siteKey, action, theme: 'auto',
        // 验证成功 → 令牌进 Store（提交表单时随请求体上送）
        callback: (token: string) => store.setTurnstileToken(token),
        // 令牌过期 → 清空，强制重新验证
        'expired-callback': () => store.setTurnstileToken(''),
        // 返回 true 表示 SDK 自己也不展示默认错误串，由我们用中文提示接管
        'error-callback': () => { store.setTurnstileToken(''); store.setAuthError('人机验证暂时不可用，请重试'); return true; },
      });
      active = { action, widgetId };
      store.setTurnstileReady(true);
    } catch {
      if (seq === mountSequence) {
        store.setTurnstileReady(false);
        store.setAuthError('无法加载人机验证，请检查网络');
      }
    }
  },
  /** 提交失败后重置：清掉令牌并让 SDK 重新出一题 */
  reset() {
    useAuthStore().setTurnstileToken('');
    if (active && window.turnstile) window.turnstile.reset(active.widgetId);
  },
  /** 离开页面时移除控件（序号 +1 使尚未完成的 mount 失效） */
  unmount(action: Action) {
    mountSequence += 1;
    if (active?.action !== action || !window.turnstile) return;
    window.turnstile.remove(active.widgetId); active = null;
    useAuthStore().setTurnstileToken('');
  },
};
