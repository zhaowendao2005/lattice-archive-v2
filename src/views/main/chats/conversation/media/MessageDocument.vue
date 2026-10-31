<script setup lang="ts">
import { AlertCircle, Check, Download, FileText, Mic, Music } from '@lucide/vue';
import { useChatFileStore } from '@/stores/chat/stores/chatFileStore';
import type { FeedDocument } from '@/stores/chat/types';
import ProgressRing from './ProgressRing.vue';

/** out：我方气泡（主色底）需要反色的图标底与次要文字。 */
const props = defineProps<{ file: FeedDocument; out: boolean }>();
const files = useChatFileStore();
</script>

<template>
  <!--
    非视频类附件（文件 / 音频 / 语音）：整张卡片即下载按钮（对齐官方 Web 客户端 File 组件）。
    空闲：图标显示扩展名，悬停换成下载箭头；下载中：进度环 + ✕，再次点击取消；已下载：再次点击直接重新保存。
  -->
  <button
    type="button"
    :aria-label="files.downloads[props.file.key]?.status === 'loading' ? `取消下载 ${props.file.fileName}` : `下载 ${props.file.fileName}`"
    :title="files.downloads[props.file.key]?.status === 'loading' ? '取消下载' : '下载文件'"
    :class="[
      'group/file mb-1 flex w-full min-w-56 max-w-full items-center gap-3 rounded-lg p-1.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring',
      props.out ? 'bg-primary-foreground/15 hover:bg-primary-foreground/20' : 'bg-card hover:bg-accent'
    ]"
    @click="files.toggleDownload(props.file)"
  >
    <span
      :class="[
        'relative flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-md',
        props.out ? 'bg-primary-foreground/20 text-primary-foreground' : 'bg-brand text-brand-foreground'
      ]"
    >
      <ProgressRing
        v-if="files.downloads[props.file.key]?.status === 'loading'"
        :percent="files.percent(props.file.key)"
        :size="40"
        cancelable
      />
      <template v-else>
        <span class="flex items-center justify-center transition-opacity duration-150 group-hover/file:opacity-0">
          <span v-if="props.file.extension" class="text-[11px] font-semibold tracking-wide">{{ props.file.extension }}</span>
          <Mic v-else-if="props.file.kind === 'voice'" class="size-5" :stroke-width="1.75" />
          <Music v-else-if="props.file.kind === 'audio'" class="size-5" :stroke-width="1.75" />
          <FileText v-else class="size-5" :stroke-width="1.75" />
        </span>
        <Download class="absolute size-5 opacity-0 transition-opacity duration-150 group-hover/file:opacity-100" :stroke-width="2" />
      </template>
    </span>

    <span class="min-w-0 flex-1">
      <span class="block truncate text-sm font-medium">{{ props.file.fileName }}</span>
      <span
        :class="[
          'flex min-w-0 items-center gap-1 text-xs tabular-nums',
          files.downloads[props.file.key]?.status === 'error'
            ? (props.out ? 'text-primary-foreground' : 'text-destructive')
            : (props.out ? 'text-primary-foreground/75' : 'text-muted-foreground')
        ]"
      >
        <AlertCircle v-if="files.downloads[props.file.key]?.status === 'error'" class="size-3 shrink-0" :stroke-width="2" />
        <Check v-else-if="files.downloads[props.file.key]?.status === 'done'" class="size-3 shrink-0" :stroke-width="2" />
        <span class="truncate">{{ files.metaLabel(props.file) }}</span>
      </span>
    </span>
  </button>
</template>
