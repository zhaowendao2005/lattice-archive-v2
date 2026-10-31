<!--
  消息富文本渲染器（纯表现层，零本地 ref）：
  · 支持 UTF-16 实体切片后的隐藏链接 (TextUrl)、裸链接、@mention、/command、#hashtag；
  · 支持粗体、斜体、下划线、删除线、行内/多行代码、剧透遮罩 (Spoiler)；
  · 支持带左侧竖线与右引号图标的引用块 (Blockquote)，还原官方客户端视觉。
-->
<script setup lang="ts">
import { Quote } from '@lucide/vue';
import { useChatStore } from '@/stores/chat/stores/chatStore';
import type { RichTextBlock, RichTextSegment } from '@/stores/chat/types';

const props = defineProps<{
  blocks: RichTextBlock[];
  messageId: number;
  out: boolean;
}>();

const chatStore = useChatStore();

function segmentClasses(seg: RichTextSegment, out: boolean): string[] {
  const classes: string[] = [];
  if (seg.bold) classes.push('font-semibold');
  if (seg.italic) classes.push('italic');
  if (seg.underline && !seg.link) classes.push('underline underline-offset-2');
  if (seg.strike) classes.push('line-through');
  if (seg.link) {
    classes.push(
      'cursor-pointer underline underline-offset-2 transition-opacity hover:opacity-85',
      out ? 'text-primary-foreground decoration-primary-foreground/80' : 'text-brand decoration-brand/65 hover:decoration-brand',
    );
  }
  return classes;
}
</script>

<template>
  <div class="space-y-1">
    <template v-for="(block, blockIdx) in props.blocks" :key="blockIdx">
      <!-- 引用块 (Blockquote)：左侧竖线 + 浅色底 + 右上角引号装饰 -->
      <blockquote
        v-if="block.kind === 'blockquote'"
        :class="[
          'relative my-1 rounded-md border-l-2 py-1.5 pl-2.5 pr-6 text-[13px] leading-snug whitespace-pre-wrap',
          props.out
            ? 'border-primary-foreground/80 bg-primary-foreground/15 text-primary-foreground'
            : 'border-brand bg-brand-soft/65 text-foreground',
          block.collapsed && !chatStore.isSpoilerRevealed(`bq:${props.messageId}:${blockIdx}`)
            ? 'line-clamp-3 cursor-pointer'
            : ''
        ]"
        @click="block.collapsed ? chatStore.revealSpoiler(`bq:${props.messageId}:${blockIdx}`) : undefined"
      >
        <template v-for="(seg, segIdx) in block.segments" :key="segIdx">
          <span
            v-if="seg.spoiler && !chatStore.isSpoilerRevealed(seg.spoilerKey)"
            class="cursor-pointer rounded bg-foreground/20 px-1 text-transparent select-none"
            title="点击显示剧透内容"
            @click.stop="chatStore.revealSpoiler(seg.spoilerKey)"
          >{{ seg.text }}</span>
          <a
            v-else-if="seg.link"
            :href="seg.link.kind === 'url' ? seg.link.target : '#'"
            :class="segmentClasses(seg, props.out)"
            @click.prevent.stop="chatStore.handleRichLinkClick(seg.link)"
          >{{ seg.text }}</a>
          <code
            v-else-if="seg.code"
            :class="['rounded px-1 py-0.5 text-xs', props.out ? 'bg-primary-foreground/20' : 'bg-card/80']"
          >{{ seg.text }}</code>
          <span v-else :class="segmentClasses(seg, props.out)">{{ seg.text }}</span>
        </template>
        <Quote
          :class="[
            'pointer-events-none absolute top-1.5 right-1.5 size-3.5',
            props.out ? 'text-primary-foreground/60' : 'text-brand/70'
          ]"
          :stroke-width="2"
        />
      </blockquote>

      <!-- 普通文本段落 -->
      <div v-else class="whitespace-pre-wrap">
        <template v-for="(seg, segIdx) in block.segments" :key="segIdx">
          <span
            v-if="seg.spoiler && !chatStore.isSpoilerRevealed(seg.spoilerKey)"
            class="cursor-pointer rounded bg-foreground/20 px-1 text-transparent select-none"
            title="点击显示剧透内容"
            @click.stop="chatStore.revealSpoiler(seg.spoilerKey)"
          >{{ seg.text }}</span>
          <pre
            v-else-if="seg.pre"
            :class="[
              'my-1 overflow-x-auto rounded-md px-2.5 py-1.5 text-xs leading-normal',
              props.out ? 'bg-primary-foreground/15 text-primary-foreground' : 'bg-card text-foreground border border-border/60'
            ]"
          ><code>{{ seg.text }}</code></pre>
          <code
            v-else-if="seg.code"
            :class="[
              'rounded px-1 py-0.5 text-[13px]',
              props.out ? 'bg-primary-foreground/20 text-primary-foreground' : 'bg-card text-foreground border border-border/50'
            ]"
          >{{ seg.text }}</code>
          <a
            v-else-if="seg.link"
            :href="seg.link.kind === 'url' ? seg.link.target : '#'"
            :class="segmentClasses(seg, props.out)"
            @click.prevent="chatStore.handleRichLinkClick(seg.link)"
          >{{ seg.text }}</a>
          <span v-else :class="segmentClasses(seg, props.out)">{{ seg.text }}</span>
        </template>
      </div>
    </template>
  </div>
</template>
