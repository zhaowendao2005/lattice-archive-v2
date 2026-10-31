<!--
  气泡底部元信息：回复计数 / 已编辑 / 时间 / 已发送或已读勾选。
  overlay = true 时（纯图片/纯视频消息）改为叠在媒体右下角的胶囊。
-->
<script setup lang="ts">
import { Check, CheckCheck, Reply } from '@lucide/vue';
import type { FeedMessageItem } from '@/stores/chat/types';

/** overlay：无文字说明的图片消息，时间叠加在图片右下角。 */
const props = defineProps<{ item: FeedMessageItem; overlay?: boolean }>();
</script>

<template>
  <span
    :class="[
      'flex items-center justify-end gap-1 text-[11px] tabular-nums',
      props.overlay
        ? 'absolute bottom-1.5 right-1.5 rounded-full bg-background/70 px-1.5 py-0.5 text-foreground backdrop-blur-sm'
        : ['mt-0.5', props.item.out ? 'text-primary-foreground/75' : 'text-muted-foreground']
    ]"
  >
    <span v-if="props.item.repliesCount" class="inline-flex items-center gap-0.5">
      <span>{{ props.item.repliesCount }}</span>
      <Reply class="size-3" :stroke-width="2" />
    </span>
    <span v-if="props.item.edited">已编辑</span>
    <span>{{ props.item.timeLabel }}</span>
    <CheckCheck v-if="props.item.readState === 'read'" class="size-3.5" aria-label="已读" />
    <Check v-else-if="props.item.readState === 'sent'" class="size-3.5" aria-label="已发送" />
  </span>
</template>
