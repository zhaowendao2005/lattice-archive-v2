import type { Directive } from 'vue';
import { messageViewport } from '@/stores/chat/data-sources/messageViewport';
import { videoPlayback } from '@/stores/chat/data-sources/videoPlayback';

/**
 * v-video-element="slot"：把 <video> 登记到 videoPlayback 数据源；视图不持有元素句柄，
 * 播放状态经数据源回报给 chatVideoStore，播放 / 暂停 / seek 也由 Store 经数据源下发。
 */
export const vVideoElement: Directive<HTMLVideoElement, string> = {
  mounted(el, binding) { videoPlayback.attach(binding.value, el); },
  updated(el, binding) {
    if (binding.value === binding.oldValue) return;
    if (binding.oldValue) videoPlayback.detach(binding.oldValue, el);
    videoPlayback.attach(binding.value, el);
  },
  beforeUnmount(el, binding) { videoPlayback.detach(binding.value, el); },
};

/** v-video-stage：查看器舞台容器，作为全屏对象。 */
export const vVideoStage: Directive<HTMLElement, undefined> = {
  mounted(el) { videoPlayback.attachStage(el); },
  beforeUnmount() { videoPlayback.attachStage(null); },
};

/** v-media-playing="target"：GIF / 圆形视频的播放可见性（≥ 50% 位于视口内才播放）。 */
export const vMediaPlaying: Directive<HTMLElement, string> = {
  mounted(el, binding) { messageViewport.observePlayback(el, binding.value); },
  updated(el, binding) { if (binding.value !== binding.oldValue) messageViewport.observePlayback(el, binding.value); },
  beforeUnmount(el) { messageViewport.unobservePlayback(el); },
};
