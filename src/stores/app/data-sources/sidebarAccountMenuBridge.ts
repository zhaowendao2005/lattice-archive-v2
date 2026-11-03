/**
 * [DATA SOURCE] 侧栏账户菜单 DOM 句柄与外部点击监听
 *
 * 视图零 ref：账户菜单的锚点元素由此单例托管；document 捕获阶段 pointerdown 在点击锚点外时通知 Store 关闭菜单。
 */
import { useAuthStore } from '@/stores/auth/stores/authStore';

let accountAnchor: HTMLElement | null = null;
let listening = false;

function onPointerDown(event: PointerEvent) {
  if (accountAnchor?.contains(event.target as Node)) return;
  useAuthStore().closeAccountMenu();
}

export const sidebarAccountMenuBridge = {
  attachAccountAnchor(el: HTMLElement | null) {
    accountAnchor = el;
    if (el && !listening) {
      document.addEventListener('pointerdown', onPointerDown, true);
      listening = true;
    } else if (!el && listening) {
      document.removeEventListener('pointerdown', onPointerDown, true);
      listening = false;
    }
  },
};
