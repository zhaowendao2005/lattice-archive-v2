<!--
  消息右侧悬停工具条（纯表现层，零本地 ref）：
  · 针对任何 Telegram 消息，悬停（或键盘聚焦）时出现，竖向排列、无边框；
  · 回复 / 复制 / 解析（解析 = 打开「搜索机器人翻页收割」设置弹窗，没有可解析内容时流程自然产出空结果）。
-->
<script setup lang="ts">
import { computed } from 'vue';
import { Check, Copy, Reply, Sparkles } from '@lucide/vue';
import { useBotHarvesterStore } from '@/stores/chat/stores/botHarvesterStore';
import { useChatStore } from '@/stores/chat/stores/chatStore';
import { useMessageActionStore } from '@/stores/chat/stores/messageActionStore';
import type { FeedMessageItem } from '@/stores/chat/types';

const props = defineProps<{ item: FeedMessageItem }>();

const chatStore = useChatStore();
const harvesterStore = useBotHarvesterStore();
const actionStore = useMessageActionStore();

/** 可复制内容：正文优先，其次媒体标签 / 文件名。 */
const copyText = computed(() => props.item.text || props.item.mediaLabel || props.item.document?.fileName || '');

const BUTTON_CLASS =
  'rounded-full p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring outline-none';
</script>

<template>
  <div class="flex shrink-0 flex-col gap-0.5 self-start opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
    <button
      v-if="chatStore.canSendInActiveChat"
      type="button"
      :class="BUTTON_CLASS"
      title="回复此消息"
      aria-label="回复此消息"
      @click="chatStore.setReplyTarget(props.item.id, props.item.senderName, props.item.text || props.item.mediaLabel || props.item.document?.fileName)"
    >
      <Reply class="size-3.5" :stroke-width="1.75" />
    </button>
    <button
      v-if="copyText"
      type="button"
      :class="BUTTON_CLASS"
      title="复制消息"
      aria-label="复制消息"
      @click="actionStore.copyMessageText(props.item.id, copyText)"
    >
      <Check v-if="actionStore.copiedMessageId === props.item.id" class="size-3.5 text-primary" :stroke-width="2" />
      <Copy v-else class="size-3.5" :stroke-width="1.75" />
    </button>
    <button
      type="button"
      :class="BUTTON_CLASS"
      title="解析消息中的群 / 频道链接"
      aria-label="解析消息中的群或频道链接"
      @click="harvesterStore.openHarvestDialog(props.item.id)"
    >
      <Sparkles class="size-3.5" :stroke-width="1.75" />
    </button>
  </div>
</template>
