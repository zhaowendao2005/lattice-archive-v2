<script setup lang="ts">
import { Paperclip, Reply } from '@lucide/vue';
import { useChatMediaStore } from '@/stores/chat/stores/chatMediaStore';
import { useChatStore } from '@/stores/chat/stores/chatStore';
import type { FeedMessageItem } from '@/stores/chat/types';
import { vAvatarVisible } from './media/mediaVisible';
import MessageInlineKeyboard from './MessageInlineKeyboard.vue';
import MessageMeta from './MessageMeta.vue';
import MessagePhotoGrid from './media/MessagePhotoGrid.vue';
import MessageRichText from './MessageRichText.vue';
import MessageRoundVideo from './media/MessageRoundVideo.vue';
import MessageVideoFile from './media/MessageVideoFile.vue';
import MessageWebPageCard from './MessageWebPageCard.vue';

const props = defineProps<{ item: FeedMessageItem }>();
const chatStore = useChatStore();
const mediaStore = useChatMediaStore();
/** 相册统一按最大宽度展示；单图使用模型计算好的宽度，窄屏时随列宽收缩。 */
const ALBUM_WIDTH = 400;
</script>

<template>
  <!-- 我方：居右主色气泡；对方：居左浅灰气泡。群组中连续消息只在首条显示头像与气泡内顶栏昵称 -->
  <div
    :data-message-id="props.item.id"
    :data-album-ids="props.item.albumIds?.join(' ')"
    :class="[
      'group flex gap-2.5 rounded-2xl transition-colors duration-300',
      props.item.out ? 'flex-row-reverse' : '',
      props.item.showSender ? 'pt-2' : '',
      chatStore.highlightedMessageId === props.item.id ? 'bg-brand-soft/50 ring-1 ring-brand/40 p-1 -mx-1' : ''
    ]"
  >
    <span
      v-if="props.item.inGroup && !props.item.out"
      v-avatar-visible="props.item.showSender && props.item.senderAvatarKey ? `msg:${props.item.id}` : undefined"
      :class="[
        'relative size-8 shrink-0 self-end overflow-hidden rounded-full text-[11px] font-semibold flex items-center justify-center',
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

    <div :class="['min-w-0 max-w-[78%] flex flex-col gap-1', props.item.out ? 'items-end' : 'items-start']">
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

      <!-- 消息下方的内联按键矩阵（ReplyInlineMarkup，如搜索筛选与翻页按钮） -->
      <MessageInlineKeyboard
        v-if="props.item.replyMarkup && props.item.replyMarkup.length > 0"
        :message-id="props.item.id"
        :rows="props.item.replyMarkup"
      />
    </div>

    <!-- 悬停快捷回复按钮（仅在可发言会话中显示） -->
    <button
      v-if="chatStore.canSendInActiveChat"
      type="button"
      class="self-center rounded-full p-1.5 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:bg-accent hover:text-foreground"
      title="回复此消息"
      aria-label="回复此消息"
      @click="chatStore.setReplyTarget(props.item.id, props.item.senderName, props.item.text || props.item.mediaLabel)"
    >
      <Reply class="size-3.5" :stroke-width="1.75" />
    </button>
  </div>
</template>
