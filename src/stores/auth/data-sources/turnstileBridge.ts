import { useAuthStore } from '../stores/authStore';

type Action = 'login' | 'register' | 'admin_login';
interface TurnstileApi { render: (container: string | HTMLElement, options: Record<string, unknown>) => string; reset: (id?: string) => void; remove: (id: string) => void }
declare global { interface Window { turnstile?: TurnstileApi } }
let loading: Promise<TurnstileApi> | null = null;
let active: { action: Action; widgetId: string } | null = null;
let mountSequence = 0;

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
    loading = null;
    throw error;
  });
  return loading;
}

export const turnstileBridge = {
  async mount(action: Action, containerId: string) {
    const store = useAuthStore();
    const seq = ++mountSequence;
    store.setTurnstileToken('');
    const siteKey = import.meta.env.VITE_TURNSTILE_SITEKEY as string | undefined;
    if (!siteKey) { store.setTurnstileReady(false); store.setAuthError('尚未配置人机验证，请联系管理员'); return; }
    try {
      const api = await loadScript();
      if (seq !== mountSequence) return;
      const container = document.getElementById(containerId);
      if (!container || active?.action === action) return;
      if (active) { api.remove(active.widgetId); active = null; }
      const widgetId = api.render(container, {
        sitekey: siteKey, action, theme: 'auto',
        callback: (token: string) => store.setTurnstileToken(token),
        'expired-callback': () => store.setTurnstileToken(''),
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
  reset() {
    useAuthStore().setTurnstileToken('');
    if (active && window.turnstile) window.turnstile.reset(active.widgetId);
  },
  unmount(action: Action) {
    mountSequence += 1;
    if (active?.action !== action || !window.turnstile) return;
    window.turnstile.remove(active.widgetId); active = null;
    useAuthStore().setTurnstileToken('');
  },
};
