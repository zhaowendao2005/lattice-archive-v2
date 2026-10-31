<script setup lang="ts">
import { DialogContent, DialogOverlay, DialogPortal, DialogRoot } from 'reka-ui';
import { useChatMediaStore } from '@/stores/chat/stores/chatMediaStore';
import { useChatVideoStore } from '@/stores/chat/stores/chatVideoStore';
import ViewerFilmstrip from './ViewerFilmstrip.vue';
import ViewerHeader from './ViewerHeader.vue';
import ViewerStage from './ViewerStage.vue';

const media = useChatMediaStore();
const video = useChatVideoStore();
</script>

<template>
  <!-- 照片 / 视频统一查看器：始终深色（媒体令牌）；开关与当前项全部在 Store；Esc / 焦点管理由 Reka Dialog 负责 -->
  <DialogRoot :open="media.viewerModel !== null" @update:open="(open) => { if (!open) media.closeViewer(); }">
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 z-40 bg-media-backdrop" />
      <DialogContent
        v-if="media.viewerModel"
        class="fixed inset-0 z-50 flex flex-col text-media-foreground outline-none"
        @keydown="media.handleViewerKey($event)"
        @escape-key-down="(event) => { if (video.menu) { event.preventDefault(); video.closeMenu(); } else if (media.zoom.scale > 1) { event.preventDefault(); media.resetZoom(); } }"
      >
        <!-- 视频播放中控制条隐藏时，页眉 / 说明 / 胶片条一并淡出 -->
        <ViewerHeader :class="['transition-opacity duration-300', video.controlsVisible || media.viewerModel.type === 'photo' ? 'opacity-100' : 'pointer-events-none opacity-0']" />
        <ViewerStage />
        <div :class="['transition-opacity duration-300', video.controlsVisible || media.viewerModel.type === 'photo' ? 'opacity-100' : 'pointer-events-none opacity-0']">
          <p
            v-if="media.viewerModel.caption"
            class="mx-auto mb-3 max-h-[4.5rem] max-w-3xl overflow-y-auto whitespace-pre-wrap px-6 text-center text-sm text-media-foreground selectable-text"
          >
            {{ media.viewerModel.caption }}
          </p>
          <ViewerFilmstrip />
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
