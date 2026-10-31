<!--
  ============================================================================
  登录页左侧壁纸面板（自动轮替 + 双层蒙版 + Ken Burns 缓推）
  ============================================================================
  实现要点：
  · 四张图常驻 DOM，只切换 opacity：不会每 9s 重新下载图片，也不会重排；
  · 进度条用纯 CSS 动画，JS 只负责切换下标（避免 60fps 的响应式更新）；
  · 鼠标进入时暂停轮替，离开后恢复；
  · 每张图绑定了 object-position，cover 裁切时不会把塔尖/灭点切掉。
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue';
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

onMounted(() => store.start());      // 进入页面开始轮替
onBeforeUnmount(() => store.stop()); // 离开时停掉定时器，避免后台空转
</script>

<template>
  <section
    class="relative isolate overflow-hidden bg-[oklch(0.12_0.02_245)]"
    aria-label="登录页视觉与壁纸轮替"
    @pointerenter="store.setAutoPlay(false)"
    @pointerleave="store.setAutoPlay(true)"
  >
    <!-- 壁纸层：四层常驻，仅切换透明度，不产生重排与二次加载 -->
    <!-- <picture> + source：>=1024px 用竖图 panel-*，窄屏用横图 band-*，主体不会被裁空 -->
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

@media (prefers-reduced-motion: reduce) {
  .auth-wallpaper.is-active { animation: none; }
}
</style>