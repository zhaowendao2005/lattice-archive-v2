<script setup lang="ts">
import { computed } from 'vue';
import { Paperclip } from '@lucide/vue';
import { useChatMediaStore } from '@/stores/chat/stores/chatMediaStore';
import { useChatStore } from '@/stores/chat/stores/chatStore';
import type { FeedMessageItem } from '@/stores/chat/types';
import { vAvatarVisible } from './media/mediaVisible';
import MessageInlineKeyboard from './MessageInlineKeyboard.vue';
import MessageMeta from './MessageMeta.vue';
import MessageToolbar from './MessageToolbar.vue';
import MessagePhotoGrid from './media/MessagePhotoGrid.vue';
import MessageRichText from './MessageRichText.vue';
import MessageRoundVideo from './media/MessageRoundVideo.vue';
import MessageVideoFile from './media/MessageVideoFile.vue';
import MessageDocument from './media/MessageDocument.vue';
import MessageWebPageCard from './MessageWebPageCard.vue';

const props = defineProps<{ item: FeedMessageItem }>();
const chatStore = useChatStore();
const mediaStore = useChatMediaStore();
/** 相册统一按最大宽度展示；单图使用模型计算好的宽度，窄屏时随列宽收缩。 */
const ALBUM_WIDTH = 400;
/** 群组入站消息左侧保留头像列；头像只对齐气泡底部，不受下方内联键盘影响。 */
const hasAvatarColumn = computed(() => props.item.inGroup && !props.item.out);
const contentColumn = computed(() => (hasAvatarColumn.value ? 'col-start-2' : 'col-start-1'));
</script>

<template>
  <!-- 我方：居右主色气泡；对方：居左浅灰气泡。群组中连续消息只在首条显示头像与气泡内顶栏昵称 -->
  <div
    :data-message-id="props.item.id"
    :data-album-ids="props.item.albumIds?.join(' ')"
    :class="[
      'group flex gap-1.5 rounded-2xl transition-colors duration-300',
      props.item.out ? 'flex-row-reverse' : '',
      props.item.showSender ? 'pt-2' : '',
      chatStore.highlightedMessageId === props.item.id ? 'bg-brand-soft/50 ring-1 ring-brand/40 p-1 -mx-1' : ''
    ]"
  >
    <!-- 网格：第 1 行 = 头像 + 气泡（头像贴气泡底部），第 2 行 = 内联键盘（始终在气泡正下方） -->
    <div
      :class="[
        'grid min-w-0 w-fit gap-x-2.5 gap-y-1',
        hasAvatarColumn ? 'max-w-[calc(78%+2.625rem)] grid-cols-[2rem_auto]' : 'max-w-[78%] grid-cols-[auto]',
        props.item.out ? 'justify-items-end' : 'justify-items-start'
      ]"
    >
      <span
        v-if="hasAvatarColumn"
        v-avatar-visible="props.item.showSender && props.item.senderAvatarKey ? `msg:${props.item.id}` : undefined"
        :class="[
          'relative col-start-1 row-start-1 size-8 shrink-0 self-end overflow-hidden rounded-full text-[11px] font-semibold flex items-center justify-center',
          props.item.showSender ? 'bg-brand-soft text-brand' : 'invisible'
        ]"
        :aria-hidden="!props.item.showSender"
      >
        <img
          v-if="props.item.showSender && mediaStore.avatarUrl(props.item.senderAvatarKey, props.item.senderAvatarThumb)"
          :src="mediaStore.avatarUrl(props.item.senderAvatarKey, props.item.senderAvatarThumb)"
          :alt="props.item.senderName"
          :class="[
            'size-full object-cover',
            !mediaStore.isAvatarLoaded(props.item.senderAvatarKey) && props.item.senderAvatarThumb ? 'scale-110 blur-[2px]' : ''
          ]"
          loading="lazy"
        />
        <span v-else>{{ props.item.senderInitials }}</span>
      </span>

      <!-- 圆形视频不使用气泡底色，时间叠加在右下角 -->
      <div v-if="props.item.round" :class="['relative row-start-1', contentColumn]">
        <MessageRoundVideo :round="props.item.round" />
        <MessageMeta :item="props.item" overlay />
      </div>
      <div
        v-else
        :class="[
          'relative row-start-1 min-w-0 max-w-full text-sm leading-relaxed selectable-text break-words',
          contentColumn,
          props.item.photos ? 'max-w-full overflow-hidden p-0.5' : 'px-3.5 py-2',
          props.item.out ? 'radius-bubble-self bg-primary text-primary-foreground' : 'radius-bubble-peer bg-muted'
        ]"
        :style="props.item.photos ? { width: `${props.item.photos.length > 1 ? ALBUM_WIDTH : props.item.photos[0].width}px` } : undefined"
      >
        <!-- 气泡内顶栏：发送者昵称（左） + 自定义头衔/标签（右），对齐官方客户端 -->
        <div
          v-if="props.item.showSender || (!props.item.out && props.item.postAuthor)"
          :class="[
            'mb-1 flex items-center justify-between gap-2 text-xs',
            props.item.photos ? 'px-2.5 pt-1.5' : ''
          ]"
        >
          <span class="truncate font-semibold text-brand">{{ props.item.senderName }}</span>
          <span
            v-if="props.item.postAuthor"
            class="shrink-0 rounded bg-background/75 px-1.5 py-0.5 text-[11px] text-muted-foreground"
          >{{ props.item.postAuthor }}</span>
        </div>

        <p v-if="props.item.forwardedFrom" :class="['mb-1 text-xs', props.item.photos ? 'px-2.5 pt-1' : '', props.item.out ? 'text-primary-foreground/80' : 'text-muted-foreground']">
          转发自 {{ props.item.forwardedFrom }}
        </p>

        <!-- 回复引用条：点击滚动定位并高亮被回复的原消息 -->
        <button
          v-if="props.item.replyPreview"
          type="button"
          :class="[
            'mb-1.5 flex w-full flex-col rounded-md border-l-2 py-1 pl-2.5 pr-2 text-left text-xs transition-opacity hover:opacity-85',
            props.item.photos ? 'mx-2.5 mt-1 w-[calc(100%-1.25rem)]' : '',
            props.item.out
              ? 'border-primary-foreground/80 bg-primary-foreground/15 text-primary-foreground'
              : 'border-brand bg-brand-soft/65 text-foreground'
          ]"
          @click="chatStore.activeChatKey && chatStore.focusMessageInChat(chatStore.activeChatKey, props.item.replyPreview.messageId)"
        >
          <span :class="['truncate font-semibold', props.item.out ? 'text-primary-foreground' : 'text-brand']">
            {{ props.item.replyPreview.senderName }}
          </span>
          <span :class="['truncate', props.item.out ? 'text-primary-foreground/85' : 'text-muted-foreground']">
            {{ props.item.replyPreview.text }}
          </span>
        </button>

        <div v-if="props.item.photos" :class="['relative overflow-hidden', props.item.out ? 'radius-bubble-self' : 'radius-bubble-peer']">
          <MessagePhotoGrid :item="props.item" />
          <MessageMeta v-if="!props.item.text && !props.item.webPage" :item="props.item" overlay />
        </div>
        <MessageVideoFile v-if="props.item.videoFile" :file="props.item.videoFile" :out="props.item.out" />
        <MessageDocument v-if="props.item.document" :file="props.item.document" :out="props.item.out" />
        <p
          v-if="props.item.mediaLabel"
          :class="['mb-1 inline-flex max-w-full items-center gap-1.5 rounded-md px-2 py-1 text-xs', props.item.out ? 'bg-primary-foreground/15' : 'bg-card']"
        >
          <Paperclip class="size-3.5 shrink-0" :stroke-width="1.75" />
          <span class="truncate">{{ props.item.mediaLabel }}</span>
        </p>
        <div v-if="props.item.text || props.item.webPage || !props.item.photos" :class="props.item.photos ? 'px-3 pt-1.5 pb-1' : ''">
          <MessageRichText
            v-if="props.item.richBlocks && props.item.richBlocks.length > 0"
            :blocks="props.item.richBlocks"
            :message-id="props.item.id"
            :out="props.item.out"
          />
          <span v-else-if="props.item.text" class="block whitespace-pre-wrap">{{ props.item.text }}</span>
          <MessageWebPageCard v-if="props.item.webPage" :web-page="props.item.webPage" :out="props.item.out" />
          <MessageMeta :item="props.item" />
        </div>
      </div>

      <!-- 消息下方的内联按键矩阵（ReplyInlineMarkup，如搜索筛选与翻页按钮）：位于气泡正下方，与气泡同列 -->
      <MessageInlineKeyboard
        v-if="props.item.replyMarkup && props.item.replyMarkup.length > 0"
        :class="['row-start-2 w-full', contentColumn]"
        :message-id="props.item.id"
        :rows="props.item.replyMarkup"
      />
    </div>

    <!-- 悬停工具条：回复 / 复制 / 解析，对任何消息可用 -->
    <MessageToolbar :item="props.item" />
  </div>
</template>
