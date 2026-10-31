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

/**
 * v-avatar-visible="target"：把会话或发送者头像元素登记到视口观察器。
 * 仅当头像进入视口预取范围时才由 chatMediaStore 按低优先级拉取小图。
 */
export const vAvatarVisible: Directive<HTMLElement, string | undefined> = {
  mounted(el, binding) { messageViewport.observeAvatar(el, binding.value); },
  updated(el, binding) { if (binding.value !== binding.oldValue) messageViewport.observeAvatar(el, binding.value); },
  beforeUnmount(el) { messageViewport.unobserveAvatar(el); },
};
