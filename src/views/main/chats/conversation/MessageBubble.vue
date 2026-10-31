<script setup lang="ts">
import { Paperclip } from '@lucide/vue';
import type { FeedMessageItem } from '@/stores/chat/types';
import MessageMeta from './MessageMeta.vue';
import MessagePhotoGrid from './media/MessagePhotoGrid.vue';
import MessageRoundVideo from './media/MessageRoundVideo.vue';
import MessageVideoFile from './media/MessageVideoFile.vue';

const props = defineProps<{ item: FeedMessageItem }>();
/** 相册统一按最大宽度展示；单图使用模型计算好的宽度，窄屏时随列宽收缩。 */
const ALBUM_WIDTH = 400;
</script>

<template>
  <!-- 我方：居右主色气泡；对方：居左浅灰气泡。群组中连续消息只在首条显示头像与昵称 -->
  <div
    :data-message-id="props.item.id"
    :data-album-ids="props.item.albumIds?.join(' ')"
    :class="['flex gap-2.5', props.item.out ? 'flex-row-reverse' : '', props.item.showSender ? 'pt-2' : '']"
  >
    <span
      v-if="props.item.inGroup && !props.item.out"
      :class="[
        'size-8 shrink-0 rounded-full text-[11px] font-semibold flex items-center justify-center',
        props.item.showSender ? 'bg-brand-soft text-brand' : 'invisible'
      ]"
      :aria-hidden="!props.item.showSender"
    >
      {{ props.item.senderInitials }}
    </span>

    <div :class="['min-w-0 max-w-[75%] flex flex-col gap-1', props.item.out ? 'items-end' : 'items-start']">
      <span v-if="props.item.showSender" class="px-1 text-xs font-medium text-foreground">{{ props.item.senderName }}</span>
      <!-- 圆形视频不使用气泡底色，时间叠加在右下角 -->
      <div v-if="props.item.round" class="relative">
        <MessageRoundVideo :round="props.item.round" />
        <MessageMeta :item="props.item" overlay />
      </div>
      <div
        v-else
        :class="[
          'relative text-sm leading-relaxed selectable-text break-words',
          props.item.photos ? 'max-w-full overflow-hidden p-0.5' : 'px-3.5 py-2',
          props.item.out ? 'radius-bubble-self bg-primary text-primary-foreground' : 'radius-bubble-peer bg-muted'
        ]"
        :style="props.item.photos ? { width: `${props.item.photos.length > 1 ? ALBUM_WIDTH : props.item.photos[0].width}px` } : undefined"
      >
        <p v-if="props.item.forwardedFrom" :class="['mb-1 text-xs', props.item.photos ? 'px-2.5 pt-1.5' : '', props.item.out ? 'text-primary-foreground/80' : 'text-muted-foreground']">
          转发自 {{ props.item.forwardedFrom }}
        </p>
        <div v-if="props.item.photos" :class="['relative overflow-hidden', props.item.out ? 'radius-bubble-self' : 'radius-bubble-peer']">
          <MessagePhotoGrid :item="props.item" />
          <MessageMeta v-if="!props.item.text" :item="props.item" overlay />
        </div>
        <MessageVideoFile v-if="props.item.videoFile" :file="props.item.videoFile" :out="props.item.out" />
        <p
          v-if="props.item.mediaLabel"
          :class="['mb-1 inline-flex max-w-full items-center gap-1.5 rounded-md px-2 py-1 text-xs', props.item.out ? 'bg-primary-foreground/15' : 'bg-card']"
        >
          <Paperclip class="size-3.5 shrink-0" :stroke-width="1.75" />
          <span class="truncate">{{ props.item.mediaLabel }}</span>
        </p>
        <div v-if="props.item.text || !props.item.photos" :class="props.item.photos ? 'px-3 pt-1.5 pb-1' : ''">
          <span v-if="props.item.text" class="block whitespace-pre-wrap">{{ props.item.text }}</span>
          <MessageMeta :item="props.item" />
        </div>
      </div>
    </div>
  </div>
</template>
