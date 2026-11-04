<script setup lang="ts">
import {
  Check,
  ChevronDown,
  FileText,
  Film,
  Filter,
  Image,
  MessageSquare,
  Package,
  RotateCcw,
  Tag,
} from '@lucide/vue';
import type { Component } from 'vue';
import { useAggregateSearchStore } from '@/stores/archive/stores/aggregateSearchStore';
import type { SearchPreFilterCategory } from '@/stores/archive/types';

const searchStore = useAggregateSearchStore();

const CATEGORY_ICON_MAP: Record<SearchPreFilterCategory, Component> = {
  video: Film,
  image: Image,
  session: MessageSquare,
  text: FileText,
  other: Package,
};
</script>

<template>
  <!-- 向下伸出的筛选菜单：遵循无突变折叠规范，通过 grid-rows 硬件加速伸展 -->
  <div
    class="grid shrink-0 bg-[#0b1222]/90 transition-[grid-template-rows,opacity] duration-180 ease-out"
    :class="
      searchStore.isFilterMenuOpen
        ? 'grid-rows-[1fr] border-b border-white/10 opacity-100'
        : 'pointer-events-none grid-rows-[0fr] border-b-0 opacity-0'
    "
  >
    <div class="overflow-hidden">
      <!-- 筛选菜单专属 Header：分为「搜索前」和「搜索后」 -->
      <div class="flex flex-wrap items-center justify-between gap-2 border-b border-white/[0.08] bg-black/25 px-4 py-2">
        <div class="flex items-center gap-2">
          <!-- 分段切换：搜索前 / 搜索后 -->
          <div class="flex items-center rounded-[2px] border border-white/12 bg-black/40 p-0.5">
            <button
              type="button"
              class="rounded-[2px] px-3 py-1 text-[11px] font-medium transition-colors"
              :class="
                searchStore.activeFilterStage === 'pre'
                  ? 'border border-sky-400/45 bg-sky-500/25 text-sky-200'
                  : 'border border-transparent text-white/50 hover:text-white/85'
              "
              @click="searchStore.setFilterStage('pre')"
            >
              搜索前
              <span
                v-if="searchStore.selectedPreCategories.length > 0"
                class="ml-1 rounded-[2px] bg-sky-400 px-1 font-mono text-[10px] font-semibold text-slate-950"
              >
                {{ searchStore.selectedPreCategories.length }}
              </span>
            </button>

            <button
              type="button"
              class="rounded-[2px] px-3 py-1 text-[11px] font-medium transition-colors"
              :class="
                searchStore.activeFilterStage === 'post'
                  ? 'border border-sky-400/45 bg-sky-500/25 text-sky-200'
                  : 'border border-transparent text-white/50 hover:text-white/85'
              "
              @click="searchStore.setFilterStage('post')"
            >
              搜索后
              <span
                v-if="searchStore.selectedPostCategories.length > 0 || searchStore.postKeyword.trim()"
                class="ml-1 rounded-[2px] bg-sky-400 px-1 font-mono text-[10px] font-semibold text-slate-950"
              >
                {{ searchStore.selectedPostCategories.length + (searchStore.postKeyword.trim() ? 1 : 0) }}
              </span>
            </button>
          </div>

          <span class="text-[11px] text-white/45">
            {{
              searchStore.activeFilterStage === 'pre'
                ? '语义：在发起搜索前即参与数据源检索条件'
                : '语义：在搜索结果流式返回后进行二次实时过滤'
            }}
          </span>
        </div>

        <button
          type="button"
          class="flex items-center gap-1 rounded-[2px] border border-white/10 px-2 py-1 text-[11px] text-white/50 transition-colors hover:border-white/25 hover:text-white"
          @click="searchStore.resetAllFilters"
        >
          <RotateCcw class="size-3" />
          <span>重置筛选</span>
        </button>
      </div>

      <!-- 面板 A：「搜索前筛选」内容区（常驻 DOM，通过类名控制显隐） -->
      <div
        class="px-4 py-3"
        :class="searchStore.activeFilterStage === 'pre' ? 'block' : 'hidden'"
      >
        <!-- 步骤 1：通过点击标签，把所有可选项都罗列出来 -->
        <div class="flex flex-wrap items-center gap-2">
          <button
            type="button"
            class="flex items-center gap-2 rounded-[2px] border px-3 py-1.5 text-xs font-medium transition-all"
            :class="
              searchStore.isPreTypeOptionsListed || searchStore.selectedPreCategories.length > 0
                ? 'border-sky-400/60 bg-sky-500/20 text-sky-200 shadow-[0_0_12px_rgba(56,189,248,0.18)]'
                : 'border-white/15 bg-white/[0.05] text-white/80 hover:border-white/30 hover:bg-white/[0.09]'
            "
            @click="searchStore.togglePreTypeOptionsList"
          >
            <Tag class="size-3.5 text-sky-400" :stroke-width="1.9" />
            <span>按文件类型筛选</span>
            <span class="font-mono text-[10px] text-sky-300/85">
              {{
                searchStore.selectedPreCategories.length > 0
                  ? `(已选 ${searchStore.selectedPreCategories.length} 项)`
                  : '(点击罗列可选项)'
              }}
            </span>
            <ChevronDown
              class="size-3.5 text-white/50 transition-transform duration-150"
              :class="searchStore.isPreTypeOptionsListed ? 'rotate-180 text-sky-300' : ''"
            />
          </button>

          <!-- 当未展开完整列表但已有选中项时，简要展示已选类型胶囊 -->
          <div
            v-if="!searchStore.isPreTypeOptionsListed && searchStore.selectedPreCategories.length > 0"
            class="flex flex-wrap items-center gap-1.5"
          >
            <span
              v-for="cat in searchStore.categoryOptions.filter(o =>
                searchStore.selectedPreCategories.includes(o.value),
              )"
              :key="cat.value"
              class="rounded-[2px] border border-sky-400/40 bg-sky-500/15 px-2 py-0.5 text-[11px] text-sky-200"
            >
              {{ cat.label }}
            </span>
          </div>
        </div>

        <!-- 步骤 2 & 3：点击标签后向下罗列所有可选项（视频、图片、会话、文本文件、其他），点击表示选中并支持多选 -->
        <div
          class="grid transition-[grid-template-rows,opacity] duration-150 ease-out"
          :class="
            searchStore.isPreTypeOptionsListed
              ? 'mt-3 grid-rows-[1fr] opacity-100'
              : 'mt-0 grid-rows-[0fr] opacity-0 pointer-events-none'
          "
        >
          <div class="overflow-hidden">
            <div class="rounded-[2px] border border-white/10 bg-black/30 p-3">
              <div class="mb-2 flex items-center justify-between text-[11px]">
                <span class="text-white/55">
                  点击下方类型标签即可选中或取消（支持多选，点击「搜索」时生效）：
                </span>
                <div class="flex items-center gap-2.5">
                  <button
                    type="button"
                    class="text-sky-300/85 hover:text-sky-300"
                    @click="searchStore.selectAllPreCategories"
                  >
                    全选类型
                  </button>
                  <button
                    type="button"
                    class="text-white/45 hover:text-white/80"
                    @click="searchStore.clearPreCategories"
                  >
                    清空已选
                  </button>
                </div>
              </div>

              <!-- 5 类可选项：视频、图片、会话、文本文件、其他 -->
              <div class="grid grid-cols-2 gap-2 sm:grid-cols-5">
                <button
                  v-for="opt in searchStore.categoryOptions"
                  :key="opt.value"
                  type="button"
                  class="group relative flex items-center gap-2 rounded-[2px] border px-3 py-2 text-left transition-all duration-150"
                  :class="
                    searchStore.selectedPreCategories.includes(opt.value)
                      ? 'border-sky-400 bg-sky-500/25 text-white ring-1 ring-sky-400/40 shadow-[inset_0_1px_0_0_rgba(56,189,248,0.25)]'
                      : 'border-white/12 bg-white/[0.03] text-white/75 hover:border-white/25 hover:bg-white/[0.07] hover:text-white'
                  "
                  @click="searchStore.togglePreCategory(opt.value)"
                >
                  <component
                    :is="CATEGORY_ICON_MAP[opt.value]"
                    class="size-4 shrink-0"
                    :class="
                      searchStore.selectedPreCategories.includes(opt.value)
                        ? 'text-sky-300'
                        : 'text-white/45 group-hover:text-white/75'
                    "
                    :stroke-width="1.8"
                  />
                  <div class="min-w-0 flex-1">
                    <div class="truncate text-xs font-medium">{{ opt.label }}</div>
                    <div class="truncate font-mono text-[9px] text-white/35">{{ opt.shortCode }}</div>
                  </div>
                  <span
                    class="flex size-4 shrink-0 items-center justify-center rounded-[2px] border transition-colors"
                    :class="
                      searchStore.selectedPreCategories.includes(opt.value)
                        ? 'border-sky-400 bg-sky-400 text-slate-950'
                        : 'border-white/20 bg-black/30 text-transparent'
                    "
                  >
                    <Check class="size-2.5" :stroke-width="2.5" />
                  </span>
                </button>
              </div>

              <div class="mt-3 grid gap-2 sm:grid-cols-2">
                <label class="flex min-w-0 flex-col gap-1 text-[11px] text-white/55">
                  <span>文件扩展名</span>
                  <input
                    v-model="searchStore.preExtensions"
                    type="text"
                    placeholder="pdf, zip, mkv"
                    class="h-7 rounded-[2px] border border-white/15 bg-black/40 px-2 text-xs text-white outline-none placeholder-white/30 focus:border-sky-400/70"
                  />
                </label>
                <p class="self-end text-[10px] leading-4 text-white/40">
                  类型会被拆成独立的服务端过滤请求；体积条件无法传给 Telegram，请改用「搜索后」的精确资源大小。
                </p>
              </div>
              <label class="mt-3 flex cursor-pointer items-center gap-2 text-[11px] text-white/55">
                <input v-model="searchStore.forceFullScan" type="checkbox" class="rounded border-white/20" />
                <span>忽略缓存，全量复核旧消息的编辑与删除</span>
              </label>
              <p class="mt-2 text-[10px] text-white/40">修改后点击搜索生效。</p>
            </div>
          </div>
        </div>
      </div>

      <!-- 面板 B：「搜索后筛选」内容区（对已返回的流式结果集做客户端即时二次收敛） -->
      <div
        class="px-4 py-3"
        :class="searchStore.activeFilterStage === 'post' ? 'block' : 'hidden'"
      >
        <div class="flex flex-wrap items-center gap-3">
          <div class="flex items-center gap-1.5 text-xs text-white/70">
            <Filter class="size-3.5 text-sky-400" :stroke-width="1.8" />
            <span>在已返回结果中二次筛选：</span>
          </div>

          <div class="flex flex-wrap items-center gap-1.5">
            <button
              v-for="opt in searchStore.categoryOptions"
              :key="`post-${opt.value}`"
              type="button"
              class="flex items-center gap-1.5 rounded-[2px] border px-2.5 py-1 text-xs transition-colors"
              :class="
                searchStore.selectedPostCategories.includes(opt.value)
                  ? 'border-sky-400 bg-sky-500/25 text-sky-200'
                  : 'border-white/12 bg-white/[0.04] text-white/65 hover:border-white/25 hover:text-white'
              "
              @click="searchStore.togglePostCategory(opt.value)"
            >
              <span>{{ opt.label }}</span>
              <Check
                v-if="searchStore.selectedPostCategories.includes(opt.value)"
                class="size-3 text-sky-300"
              />
            </button>
          </div>

          <input
            v-model="searchStore.postKeyword"
            type="text"
            placeholder="在当前结果集中二次过滤标题或会话名..."
            class="h-7 min-w-[220px] flex-1 rounded-[2px] border border-white/15 bg-black/35 px-2.5 text-white placeholder-white/35 outline-none focus:border-sky-400/70"
          />
        </div>

        <!-- 维度 2~5：画质分辨率、时长、体积、防转发与 document.id 跨群去重 -->
        <div class="mt-2.5 flex flex-wrap items-center gap-3 border-t border-white/10 pt-2.5 text-[11px] text-white/75">
          <label class="flex items-center gap-1">
            <span class="text-white/45">画质：</span>
            <select
              v-model="searchStore.postResolutionFilter"
              class="h-6 rounded border border-white/15 bg-black/50 px-1.5 text-[11px] text-white"
            >
              <option value="all">全部画质</option>
              <option value="720p">≥ 720p HD</option>
              <option value="1080p">≥ 1080p FHD</option>
              <option value="4k">4K UHD</option>
            </select>
          </label>

          <label class="flex items-center gap-1">
            <span class="text-white/45">时长：</span>
            <select
              v-model="searchStore.postDurationFilter"
              class="h-6 rounded border border-white/15 bg-black/50 px-1.5 text-[11px] text-white"
            >
              <option value="all">全部时长</option>
              <option value="short">短视频 (&lt;1m)</option>
              <option value="medium">中等 (1~15m)</option>
              <option value="long">长视频 (&gt;15m)</option>
            </select>
          </label>

          <label class="flex items-center gap-1">
            <span class="text-white/45">资源大小：</span>
            <input
              v-model="searchStore.postMinSizeMb"
              data-search-min-size
              type="number"
              min="0"
              step="any"
              placeholder="最小 MB"
              class="h-6 w-20 rounded border border-white/15 bg-black/50 px-1.5 text-[11px] text-white placeholder-white/30 outline-none focus:border-sky-400/70"
            />
            <span class="text-white/30">~</span>
            <input
              v-model="searchStore.postMaxSizeMb"
              data-search-max-size
              type="number"
              min="0"
              step="any"
              placeholder="最大 MB"
              class="h-6 w-20 rounded border border-white/15 bg-black/50 px-1.5 text-[11px] text-white placeholder-white/30 outline-none focus:border-sky-400/70"
            />
          </label>

          <label class="flex cursor-pointer items-center gap-1">
            <input v-model="searchStore.postExcludeNoForwards" type="checkbox" class="rounded border-white/20" />
            <span>排除防转发受限 (noforwards)</span>
          </label>

          <label class="flex cursor-pointer items-center gap-1">
            <input v-model="searchStore.postDeduplicateByDocId" type="checkbox" class="rounded border-white/20" />
            <span>按 document.id 跨群去重</span>
          </label>
        </div>
        <p
          v-if="searchStore.postSizeBounds.error"
          role="alert"
          class="mt-2 text-[11px] text-rose-300"
        >
          {{ searchStore.postSizeBounds.error }}
        </p>
        <p class="mt-1.5 text-[10px] text-white/40">
          资源大小只作用于视频与图片；留空为不限，设置后排除大小未知的媒体。
        </p>
      </div>
    </div>
  </div>
</template>
