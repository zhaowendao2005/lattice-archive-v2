<script setup lang="ts">
import type { FeedMessageItem, FeedVisual } from '@/stores/chat/types';
import MessageGif from './MessageGif.vue';
import MessagePhoto from './MessagePhoto.vue';
import MessageVideoTile from './MessageVideoTile.vue';

const props = defineProps<{ item: FeedMessageItem }>();
const TILE_COMPONENTS = { photo: MessagePhoto, video: MessageVideoTile, gif: MessageGif } as const;
/** MessagePhoto 的属性名为 photo，视频 / GIF 组件为 visual。 */
const tileProps = (visual: FeedVisual, aspectRatio: number) => (visual.kind === 'photo' ? { photo: visual, aspectRatio } : { visual, aspectRatio });
</script>

<template>
  <!-- 单图按原始比例；相册（照片 / 视频混排）按固定比例的网格（横跨格 2:1，普通格 1:1） -->
  <component
    :is="TILE_COMPONENTS[props.item.photos[0].kind]"
    v-if="props.item.photos?.length === 1"
    v-bind="tileProps(props.item.photos[0], props.item.photos[0].aspectRatio)"
  />
  <div
    v-else-if="props.item.photos"
    :class="['grid gap-0.5', props.item.albumColumns === 3 ? 'grid-cols-3' : 'grid-cols-2']"
  >
    <component
      :is="TILE_COMPONENTS[visual.kind]"
      v-for="visual in props.item.photos"
      :key="visual.target"
      v-bind="tileProps(visual, visual.span === 2 ? 2 : 1)"
      :class="visual.span === 2 ? 'col-span-2' : ''"
    />
  </div>
</template>
