<!--
  气泡内网页预览卡片（MessageMediaWebPage，纯表现层，零本地 ref）：
  · 展示站点名、标题、摘要与内联缩略图；
  · 点击后统一经 chatStore.handleLinkClick 走 Telegram 链接路由器。
-->
<script setup lang="ts">
import { useChatStore } from '@/stores/chat/stores/chatStore';
import type { FeedWebPage } from '@/stores/chat/types';

const props = defineProps<{
  webPage: FeedWebPage;
  out: boolean;
}>();

const chatStore = useChatStore();
</script>

<template>
  <a
    :href="props.webPage.url"
    :class="[
      'mt-1.5 flex items-start gap-2.5 rounded-md border-l-2 py-1.5 pl-2.5 pr-2 text-xs transition-opacity hover:opacity-90',
      props.out
        ? 'border-primary-foreground/80 bg-primary-foreground/15 text-primary-foreground'
        : 'border-brand bg-brand-soft/55 text-foreground'
    ]"
    @click.prevent="chatStore.handleLinkClick(props.webPage.url)"
  >
    <div class="min-w-0 flex-1 space-y-0.5">
      <p
        v-if="props.webPage.siteName || props.webPage.displayUrl"
        :class="['truncate font-semibold', props.out ? 'text-primary-foreground' : 'text-brand']"
      >
        {{ props.webPage.siteName || props.webPage.displayUrl }}
      </p>
      <p v-if="props.webPage.title" class="line-clamp-2 font-medium leading-snug">
        {{ props.webPage.title }}
      </p>
      <p
        v-if="props.webPage.description"
        :class="['line-clamp-3 leading-snug', props.out ? 'text-primary-foreground/80' : 'text-muted-foreground']"
      >
        {{ props.webPage.description }}
      </p>
    </div>
    <img
      v-if="props.webPage.thumb"
      :src="props.webPage.thumb"
      alt=""
      class="size-12 shrink-0 rounded object-cover"
      loading="lazy"
    />
  </a>
</template>
