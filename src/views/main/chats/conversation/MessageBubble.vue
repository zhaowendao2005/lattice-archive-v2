<script setup lang="ts">
import { Check, CheckCheck } from '@lucide/vue';
import type { ChatMessageMock } from '@/stores/chat/mocks/chatMock';

const props = defineProps<{
  message: ChatMessageMock;
}>();
</script>

<template>
  <!-- 我方：居右墨色气泡，不重复头像与昵称；对方：居左浅灰气泡 -->
  <div :class="['flex gap-2.5', props.message.isSelf ? 'flex-row-reverse' : '']">
    <span
      v-if="!props.message.isSelf"
      class="size-8 shrink-0 rounded-full bg-brand-soft text-brand text-[11px] font-semibold flex items-center justify-center"
    >
      {{ props.message.senderInitials }}
    </span>

    <div :class="['min-w-0 max-w-[75%] flex flex-col gap-1', props.message.isSelf ? 'items-end' : 'items-start']">
      <div class="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span v-if="!props.message.isSelf" class="font-medium text-foreground">{{ props.message.senderName }}</span>
        <span class="tabular-nums">{{ props.message.timestamp }}</span>
        <component
          :is="props.message.status === 'sent' ? Check : CheckCheck"
          v-if="props.message.status"
          :class="['size-3.5', props.message.status === 'read' ? 'text-brand' : '']"
          :aria-label="props.message.status"
        />
      </div>
      <div
        :class="[
          'px-3.5 py-2.5 text-sm leading-relaxed selectable-text whitespace-pre-wrap break-words',
          props.message.isSelf
            ? 'radius-bubble-self bg-primary text-primary-foreground'
            : 'radius-bubble-peer bg-muted'
        ]"
      >{{ props.message.content }}</div>
    </div>
  </div>
</template>
