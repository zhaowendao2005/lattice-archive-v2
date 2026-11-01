<script setup lang="ts">
import { Check, Clock, KeyRound, Users } from '@lucide/vue';
import type { SearchScopeSessionDto } from '@/stores/archive/types';

defineProps<{
  session: SearchScopeSessionDto;
  selected: boolean;
}>();

const emit = defineEmits<{
  (e: 'toggle', sessionId: string): void;
}>();
</script>

<template>
  <div
    class="group relative flex cursor-pointer select-none items-start gap-2.5 rounded-[2px] border p-2.5 transition-all duration-150"
    :class="
      selected
        ? 'border-sky-400/75 bg-sky-500/[0.16] ring-1 ring-sky-400/40 shadow-[inset_0_1px_0_0_rgba(56,189,248,0.2)]'
        : 'border-white/10 bg-white/[0.03] hover:border-white/25 hover:bg-white/[0.06]'
    "
    @click="emit('toggle', session.id)"
  >
    <!-- 左端：正方形会话缩略图方块 -->
    <div
      class="relative flex size-9 shrink-0 items-center justify-center rounded-[2px] font-mono text-xs font-semibold shadow-sm"
      :class="session.accentClass"
    >
      <span>{{ session.initials }}</span>
      <span
        class="absolute -bottom-1 -right-1 flex size-4 items-center justify-center rounded-[2px] border border-black/60 bg-slate-950 text-white/80"
      >
        <KeyRound
          v-if="session.kind === 'credential_only'"
          class="size-2.5 text-amber-300"
          :stroke-width="2"
        />
        <Users v-else class="size-2.5 text-sky-300" :stroke-width="2" />
      </span>
    </div>

    <!-- 中部：会话标题、凭据标签与元数据 -->
    <div class="min-w-0 flex-1">
      <div class="flex items-center gap-1.5">
        <p class="truncate text-[12px] font-medium text-white/92">
          {{ session.title }}
        </p>
      </div>

      <!-- 分类与凭据标识行 -->
      <div class="mt-1 flex flex-wrap items-center gap-1">
        <span
          class="rounded-[2px] border border-white/10 bg-white/[0.05] px-1 py-0.2 text-[10px] text-white/55"
        >
          {{ session.peerTypeLabel }}
        </span>
        <span
          v-if="session.kind === 'credential_only' && session.credentialBadge"
          class="rounded-[2px] border border-amber-400/35 bg-amber-500/15 px-1 py-0.2 font-mono text-[10px] text-amber-200"
        >
          {{ session.credentialBadge }}
        </span>
      </div>

      <!-- 凭据过期时间提示（严格仅针对「只有凭据的会话」展示） -->
      <div
        v-if="session.kind === 'credential_only' && session.expiresLabel"
        class="mt-1 flex items-center gap-1 font-mono text-[10px] text-amber-300/85"
      >
        <Clock class="size-2.5 shrink-0 text-amber-400" />
        <span class="truncate">过期时间：{{ session.expiresLabel }}</span>
      </div>

      <!-- 底部句柄/哈希与消息规模 -->
      <div class="mt-1.5 flex items-center justify-between gap-2 font-mono text-[10px] text-white/38">
        <span class="truncate">{{ session.handleOrHash }}</span>
        <span class="shrink-0">{{ session.itemCountLabel }}</span>
      </div>
    </div>

    <!-- 右上角：多选勾选框 -->
    <div
      class="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-[2px] border transition-colors"
      :class="
        selected
          ? 'border-sky-400 bg-sky-400 text-slate-950'
          : 'border-white/20 bg-black/30 text-transparent group-hover:border-white/40'
      "
    >
      <Check class="size-3" :stroke-width="2.5" />
    </div>
  </div>
</template>
