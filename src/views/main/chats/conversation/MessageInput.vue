<script setup lang="ts">
import { ArrowUp, Paperclip, Type } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import { useChatStore } from '@/stores/chat/stores/chatStore';

const chatStore = useChatStore();

function handleInput(e: Event) {
  const target = e.target as HTMLTextAreaElement;
  chatStore.setDraftInput(target.value);
}

function handleKeyDown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    chatStore.sendCurrentMessage();
  }
}
</script>

<template>
  <div class="shrink-0 px-5 pb-4">
    <div class="mx-auto max-w-3xl rounded-xl border border-input bg-card transition-[border-color,box-shadow] focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/15">
      <textarea
        rows="2"
        :value="chatStore.draftInput"
        placeholder="输入消息"
        class="block w-full resize-none bg-transparent px-3.5 pt-3 leading-relaxed outline-none selectable-text placeholder:text-muted-foreground"
        @input="handleInput"
        @keydown="handleKeyDown"
      ></textarea>

      <div class="flex items-center justify-between px-1.5 pb-1.5">
        <div class="flex items-center">
          <Button variant="ghost" size="icon" class="token-hit-target text-muted-foreground" aria-label="添加附件" title="添加附件">
            <Paperclip :stroke-width="1.75" />
          </Button>
          <Button variant="ghost" size="icon" class="token-hit-target text-muted-foreground" aria-label="排版标记" title="排版标记">
            <Type :stroke-width="1.75" />
          </Button>
        </div>

        <div class="flex items-center gap-3">
          <span class="hidden md:inline text-xs text-muted-foreground">Enter 发送 · Shift+Enter 换行</span>
          <Button
            size="icon"
            class="token-hit-target hover:bg-primary/90"
            aria-label="发送"
            title="发送"
            :disabled="!chatStore.draftInput.trim()"
            @click="chatStore.sendCurrentMessage()"
          >
            <ArrowUp :stroke-width="2" />
          </Button>
        </div>
      </div>
    </div>
  </div>
</template>
