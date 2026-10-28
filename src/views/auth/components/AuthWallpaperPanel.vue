<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue';
import { ChevronLeft, ChevronRight, Pause, Play } from '@lucide/vue';
import { WALLPAPER_INTERVAL } from '@/assets/login';
import { useWallpaperStore } from '@/stores/auth/stores/wallpaperStore';

const store = useWallpaperStore();
const wp = computed(() => store.current);

/**
 * 每张壁纸的氛围蒙版：底部渐浓保证文案可读，上端留出通透感。
 * 强度随壁纸明暗差异分别调校（亮部天光需要更深的基础压暗）。
 */
const veilStyle = computed(() => {
  const { veil, fade } = wp.value;
  return {
    background: [
      `linear-gradient(to top, rgb(4 10 22 / ${fade}) 0%`,
      `rgb(4 10 22 / ${fade * 0.6}) 26%`,
      `rgb(4 10 22 / ${veil}) 58%`,
      `rgb(4 10 22 / ${veil * 0.55}) 100%)`,
    ].join(', '),
  };
});

onMounted(() => store.start());
onBeforeUnmount(() => store.stop());
</script>

<template>
  <section
    class="relative isolate overflow-hidden bg-[oklch(0.12_0.02_245)]"
    aria-label="登录页视觉与壁纸轮替"
    @pointerenter="store.setAutoPlay(false)"
    @pointerleave="store.setAutoPlay(true)"
  >
    <!-- 壁纸层：四层常驻，仅切换透明度，不产生重排与二次加载 -->
    <div class="absolute inset-0">
      <div
        v-for="(w, i) in store.all"
        :key="w.id"
        class="absolute inset-0 transition-opacity duration-[1400ms] ease-[cubic-bezier(0.4,0,0.2,1)]"
        :class="i === store.index ? 'opacity-100' : 'opacity-0'"
        :aria-hidden="i !== store.index"
      >
        <picture>
          <!-- 竖屏 / 窄屏改用横向图带，避免 4:5 图被上下裁空 -->
          <source media="(max-width: 1023px)" :srcset="w.band" />
          <img
            :src="w.panel"
            :alt="`${w.label} — ${w.place}`"
            class="auth-wallpaper size-full object-cover"
            :class="{ 'is-active': i === store.index }"
            :style="{ objectPosition: w.position }"
            draggable="false"
          />
        </picture>
      </div>
    </div>

    <!-- 蒙版：随壁纸切换做 1s 过渡，避免硬切 -->
    <div class="pointer-events-none absolute inset-0 transition-[background] duration-1000" :style="veilStyle" />
    <!-- 品牌色冷光，呼应 Swiss Tech Blue -->
    <div class="pointer-events-none absolute -top-32 -right-24 size-[30rem] rounded-full bg-brand/20 blur-[130px]" />

    <!-- 顶部角标 -->
    <div class="absolute inset-x-0 top-0 flex items-start justify-between p-5 lg:p-7">
      <span
        class="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/10 px-3 py-1.5 text-[11px] font-medium text-white/85 backdrop-blur-md"
      >
        <span class="size-1.5 rounded-full bg-emerald-400 shadow-[0_0_0_3px_rgb(52_211_153/0.25)]" />
        本地优先 · 离线可用
      </span>

      <!-- 窄屏只留指示点滑动切换，不占版面 -->
      <span class="rounded-full border border-white/15 bg-white/10 px-3 py-1.5 text-[11px] text-white/70 backdrop-blur-md lg:hidden">
        {{ wp.label }}
      </span>
    </div>

    <!-- 底部信息与控制：桌面显示完整卡片 -->
    <div class="absolute inset-x-0 bottom-0 hidden items-end justify-between gap-6 p-7 lg:flex">
      <!-- 文案卡片：随壁纸切换做交叉淡入 -->
      <Transition name="wp-caption" mode="out-in">
        <div
          :key="wp.id"
          class="max-w-md rounded-2xl border border-white/15 bg-white/10 p-5 backdrop-blur-xl"
        >
          <p class="text-[11px] font-medium tracking-wide text-white/55">{{ wp.place }}</p>
          <p class="mt-2 text-lg font-semibold leading-snug text-white">{{ wp.headline }}</p>
          <p class="mt-2 text-[13px] leading-relaxed text-white/70">{{ wp.caption }}</p>
        </div>
      </Transition>

      <!-- 轮替控制条 -->
      <div class="flex shrink-0 items-center gap-1 rounded-full border border-white/15 bg-black/30 px-2 py-1.5 backdrop-blur-md">
        <button
          type="button"
          class="flex size-7 cursor-pointer items-center justify-center rounded-full text-white/70 transition-colors duration-200 hover:bg-white/10 hover:text-white outline-none focus-visible:ring-2 focus-visible:ring-white/50"
          aria-label="上一张壁纸"
          @click="store.setAutoPlay(false); store.prev()"
        >
          <ChevronLeft class="size-4" :stroke-width="2" />
        </button>

        <button
          v-for="(w, i) in store.all"
          :key="w.id"
          type="button"
          class="relative size-7 cursor-pointer overflow-hidden rounded-full border transition-all duration-200 outline-none focus-visible:ring-2 focus-visible:ring-white/50"
          :class="i === store.index ? 'border-white' : 'border-white/30 opacity-55 hover:opacity-100'"
          :aria-label="w.label"
          :aria-current="i === store.index"
          @click="store.setAutoPlay(false); store.goTo(i)"
        >
          <img :src="w.thumb" :alt="w.label" class="size-full object-cover" />
          <!-- 进度环：纯 CSS 驱动，随激活项重新挂载而自动重播 -->
          <span
            v-if="i === store.index"
            class="auth-progress absolute inset-x-0 bottom-0 h-0.5 origin-left bg-white"
            :class="{ 'is-paused': !store.autoPlay }"
            :style="{ animationDuration: `${WALLPAPER_INTERVAL}ms` }"
          />
        </button>

        <button
          type="button"
          class="flex size-7 cursor-pointer items-center justify-center rounded-full text-white/70 transition-colors duration-200 hover:bg-white/10 hover:text-white outline-none focus-visible:ring-2 focus-visible:ring-white/50"
          :aria-label="store.autoPlay ? '暂停轮替' : '继续轮替'"
          @click="store.toggleAutoPlay()"
        >
          <Pause v-if="store.autoPlay" class="size-3.5" :stroke-width="2" />
          <Play v-else class="size-3.5" :stroke-width="2" />
        </button>

        <button
          type="button"
          class="flex size-7 cursor-pointer items-center justify-center rounded-full text-white/70 transition-colors duration-200 hover:bg-white/10 hover:text-white outline-none focus-visible:ring-2 focus-visible:ring-white/50"
          aria-label="下一张壁纸"
          @click="store.setAutoPlay(false); store.next()"
        >
          <ChevronRight class="size-4" :stroke-width="2" />
        </button>
      </div>
    </div>

    <!-- 窄屏：仅保留一枚悬浮的轮替按钮组 -->
    <div class="absolute bottom-3 right-3 flex items-center gap-1 rounded-full border border-white/15 bg-black/35 px-1.5 py-1 backdrop-blur-md lg:hidden">
      <button
        type="button"
        class="flex size-7 cursor-pointer items-center justify-center rounded-full text-white/75 active:bg-white/15"
        aria-label="上一张壁纸"
        @click="store.setAutoPlay(false); store.prev()"
      >
        <ChevronLeft class="size-4" :stroke-width="2" />
      </button>
      <span class="px-0.5 text-[11px] tabular-nums text-white/70">{{ store.index + 1 }} / {{ store.count }}</span>
      <button
        type="button"
        class="flex size-7 cursor-pointer items-center justify-center rounded-full text-white/75 active:bg-white/15"
        aria-label="下一张壁纸"
        @click="store.setAutoPlay(false); store.next()"
      >
        <ChevronRight class="size-4" :stroke-width="2" />
      </button>
    </div>
  </section>
</template>

<style scoped>
/* 缓慢推近，让静态壁纸在 9s 内保持"活着"的呼吸感 */
@keyframes authKenburns {
  from { transform: scale(1.02); }
  to   { transform: scale(1.12); }
}

.auth-wallpaper {
  transform: scale(1.02);
  transition: transform 1400ms cubic-bezier(0.4, 0, 0.2, 1);
}

.auth-wallpaper.is-active {
  animation: authKenburns 11s linear forwards;
}

/* 进度条：9s 匀速走满，暂停时冻结在当前比例 */
@keyframes authProgress {
  from { transform: scaleX(0); }
  to   { transform: scaleX(1); }
}

.auth-progress {
  animation-name: authProgress;
  animation-timing-function: linear;
  animation-fill-mode: forwards;
}

.auth-progress.is-paused {
  animation-play-state: paused;
}

/* 文案卡片交叉淡入 */
.wp-caption-enter-active,
.wp-caption-leave-active {
  transition: opacity 320ms ease, transform 320ms cubic-bezier(0.16, 1, 0.3, 1);
}
.wp-caption-enter-from { opacity: 0; transform: translateY(8px); }
.wp-caption-leave-to { opacity: 0; transform: translateY(-6px); }

@media (prefers-reduced-motion: reduce) {
  .auth-wallpaper.is-active { animation: none; }
  .wp-caption-enter-active,
  .wp-caption-leave-active { transition-duration: 1ms; }
}
</style>