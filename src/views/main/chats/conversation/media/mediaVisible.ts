import type { Directive } from 'vue';
import { messageViewport } from '@/stores/chat/data-sources/messageViewport';

/**
 * v-media-visible="target"：把媒体元素登记到消息流的可见性观察器。
 * 视图不持有 DOM 句柄，进入 / 离开预取范围后的加载决策全部由 chatMediaStore 完成。
 */
export const vMediaVisible: Directive<HTMLElement, string> = {
  mounted(el, binding) { messageViewport.observeMedia(el, binding.value); },
  updated(el, binding) { if (binding.value !== binding.oldValue) messageViewport.observeMedia(el, binding.value); },
  beforeUnmount(el) { messageViewport.unobserveMedia(el); },
};
