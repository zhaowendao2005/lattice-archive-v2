<script setup lang="ts">
import { Eye } from '@lucide/vue';
</script>

<template>
  <!-- 当前阶段为只读浏览：不发送、不标记已读，避免误改 Telegram 服务端状态 -->
  <div class="shrink-0 border-t border-border px-5 py-2.5">
    <p class="mx-auto flex max-w-3xl items-center justify-center gap-2 text-xs text-muted-foreground">
      <Eye class="size-3.5 shrink-0" :stroke-width="1.75" />
      <span>只读浏览：消息与已读状态不会被修改</span>
    </p>
  </div>
</template>
