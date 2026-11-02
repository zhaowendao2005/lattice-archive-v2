<script setup lang="ts">
/**
 * [VIEW] 黑色项目运行日志终端 + 框选式时间轴观察视口与时间刻度尺 (DebugTerminalPanel.vue)
 * 严格遵循：
 * 1. 零本地 ref / reactive（DOM 句柄由自定义指令委托 debugLoggerDataSource 托管）；
 * 2. 仅使用语义化视觉令牌（使用始终深色的 bg-media-backdrop / bg-media-surface / text-media-foreground / text-media-muted / border-media-track 呈现经典黑色项目终端）；
 * 3. LOCAL / REMOTE / FRONTEND 三个无圆角标签 (rounded-none)，点击高亮即开启采集；
 * 4. 时间条支持直接点击并拖拽刷选新区域 ('brush')、平移选区 ('move')、左右缩放 ('left'/'right')，并在下方配备时间轴刻度尺；
 * 5. 终端左侧展示 4 位行号 (0001..)，右侧日志内容完整自动折行 (whitespace-pre-wrap break-all)，绝不截断。
 */
import type { Directive } from 'vue';
import { debugLoggerDataSource } from '@/stores/app/data-sources/debugLoggerDataSource';
import { useDebugLoggerStore } from '@/stores/app/stores/debugLoggerStore';

const logger = useDebugLoggerStore();

const vTerminalScroll: Directive<HTMLElement> = {
  mounted(el) {
    debugLoggerDataSource.attachTerminalContainer(el);
  },
  unmounted() {
    debugLoggerDataSource.attachTerminalContainer(null);
  },
};

const vTimelineTrack: Directive<HTMLElement> = {
  mounted(el) {
    debugLoggerDataSource.attachTimelineTrack(el);
  },
  unmounted() {
    debugLoggerDataSource.attachTimelineTrack(null);
  },
};
</script>

<template>
  <section class="space-y-2">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <span class="text-sm font-medium text-foreground">项目运行日志终端与时间轴视口</span>
      <span class="font-mono text-xs text-muted-foreground">
        {{ logger.visibleRows.length }} / {{ logger.channelFilteredEntries.length }} LINES
      </span>
    </div>

    <!-- 经典黑色项目终端容器（使用始终深色的 media-* 语义令牌） -->
    <div class="rounded-none border border-media-track bg-media-backdrop text-media-foreground font-mono text-xs shadow-xl">
      <!-- 终端顶部窗口标题栏（Project Terminal Header） -->
      <div class="flex flex-wrap items-center justify-between gap-2 border-b border-media-track bg-media-surface px-3 py-1.5">
        <div class="flex items-center gap-2">
          <span class="inline-block size-2 rounded-pill bg-destructive" />
          <span class="inline-block size-2 rounded-pill bg-brand" />
          <span class="inline-block size-2 rounded-pill bg-media-muted" />
          <span class="ml-1 text-[11px] font-semibold tracking-wide text-media-foreground">
            lattice-archive-v2 — project-terminal (zsh · trace-stream)
          </span>
        </div>
        <span class="text-[11px] text-media-muted">
          UTF-8 · WRAP: ON · LINE-NUMBERS: ON
        </span>
      </div>

      <!-- 第一栏：三个无圆角采集源开关标签 + LIVE / AGENT SKILL / 复制 / 下载 -->
      <div class="flex flex-wrap items-center justify-between gap-2 border-b border-media-track bg-media-scrim px-3 py-2">
        <div class="flex flex-wrap items-center gap-1.5">
          <span class="mr-1 text-[11px] text-media-muted">SOURCES:</span>
          <button
            type="button"
            class="rounded-none border px-2.5 py-1 text-[11px] font-semibold tracking-wider transition-colors"
            :class="
              logger.captureLocal
                ? 'border-brand bg-brand text-brand-foreground'
                : 'border-media-track bg-media-backdrop text-media-muted hover:text-media-foreground'
            "
            @click="logger.toggleSource('local')"
          >
            LOCAL
          </button>
          <button
            type="button"
            class="rounded-none border px-2.5 py-1 text-[11px] font-semibold tracking-wider transition-colors"
            :class="
              logger.captureRemote
                ? 'border-brand bg-brand text-brand-foreground'
                : 'border-media-track bg-media-backdrop text-media-muted hover:text-media-foreground'
            "
            @click="logger.toggleSource('remote')"
          >
            REMOTE
          </button>
          <button
            type="button"
            class="rounded-none border px-2.5 py-1 text-[11px] font-semibold tracking-wider transition-colors"
            :class="
              logger.captureFrontend
                ? 'border-brand bg-brand text-brand-foreground'
                : 'border-media-track bg-media-backdrop text-media-muted hover:text-media-foreground'
            "
            @click="logger.toggleSource('frontend')"
          >
            FRONTEND
          </button>
        </div>

        <div class="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            class="rounded-none border px-2.5 py-1 text-[11px] font-semibold tracking-wider transition-colors"
            :class="
              logger.isFollowLive
                ? 'border-brand bg-brand text-brand-foreground'
                : 'border-media-track bg-media-backdrop text-media-muted hover:text-media-foreground'
            "
            @click="logger.toggleFollowLive()"
          >
            LIVE
          </button>

          <!-- Hover 提示按钮：点击将接口 + 渐进式查询 Skills + 访问密钥一键复制到剪贴板 -->
          <div
            class="relative inline-block"
            @mouseenter="logger.setAgentBtnHovered(true)"
            @mouseleave="logger.setAgentBtnHovered(false)"
          >
            <button
              type="button"
              class="rounded-none border border-brand bg-brand/20 px-2.5 py-1 text-[11px] font-semibold text-media-foreground transition-colors hover:bg-brand hover:text-brand-foreground"
              @click="logger.copyAgentSkillAndKeyBundle()"
            >
              AGENT SKILL
            </button>
            <div
              v-if="logger.isAgentBtnHovered"
              class="pointer-events-none absolute right-0 bottom-full z-30 mb-1.5 w-72 rounded-none border border-border bg-popover px-3 py-2 text-[11px] leading-relaxed text-popover-foreground shadow-xl"
            >
              使用 Agent 来查阅运行日志：点击后自动同步云端快照，并将「渐进式查询接口 + Skills 说明文档 + 访问密钥」复制到剪贴板
            </div>
          </div>

          <button
            type="button"
            class="rounded-none border border-media-track bg-media-surface px-2.5 py-1 text-[11px] text-media-foreground hover:bg-media-control"
            @click="logger.copyLogsToClipboard()"
          >
            复制
          </button>
          <button
            type="button"
            class="rounded-none border border-media-track bg-media-surface px-2.5 py-1 text-[11px] text-media-foreground hover:bg-media-control"
            @click="logger.downloadLogsAsFile()"
          >
            下载 .LOG
          </button>
          <button
            type="button"
            class="rounded-none border border-media-track bg-media-surface px-2 py-1 text-[11px] text-media-muted hover:text-destructive"
            @click="logger.clearLogs()"
          >
            清空
          </button>
        </div>
      </div>

      <!-- 第二栏：Grep 检索过滤与级别筛选 -->
      <div class="flex flex-wrap items-center gap-2 border-b border-media-track bg-media-surface px-3 py-1.5">
        <span class="text-[11px] text-brand select-none">grep $</span>
        <input
          type="text"
          :value="logger.grepKeyword"
          placeholder="输入关键词或正则片段检索 (如 pts_gap / deleteMessages / archive.sync / T:8f3a1c)..."
          class="h-7 flex-1 rounded-none border border-media-track bg-media-backdrop px-2 text-xs text-media-foreground placeholder:text-media-muted outline-none focus:border-brand"
          @input="logger.grepKeyword = ($event.target as HTMLInputElement).value"
        />
        <div class="flex items-center gap-1">
          <button
            v-for="lvl in (['ALL', 'INFO', 'WARN', 'ERROR'] as const)"
            :key="lvl"
            type="button"
            class="rounded-none border px-2 py-0.5 text-[11px] font-semibold"
            :class="
              logger.levelFilter === lvl
                ? 'border-brand bg-brand text-brand-foreground'
                : 'border-media-track bg-media-backdrop text-media-muted hover:text-media-foreground'
            "
            @click="logger.levelFilter = lvl"
          >
            {{ lvl }}
          </button>
        </div>
      </div>

      <!-- 第三栏：支持直接点击拖拽刷选的时间轴观察视口 + 底部时间轴刻度尺 -->
      <div class="border-b border-media-track bg-media-scrim px-3 py-2 select-none">
        <div class="mb-1.5 flex flex-wrap items-center justify-between gap-2 text-[11px] text-media-muted">
          <div class="flex flex-wrap items-center gap-2">
            <span class="font-semibold text-media-foreground">
              选区时间窗：{{ logger.viewportTimeRange.startLabel }} ~ {{ logger.viewportTimeRange.endLabel }}
            </span>
            <span class="text-media-muted">
              （在时间条内直接点击并左右拖拽即可框选新区域，拖动顶部横条可平移选区）
            </span>
          </div>
          <button
            type="button"
            class="border border-media-track bg-media-surface px-2 py-0.5 text-[11px] text-media-foreground hover:border-brand"
            @click="logger.resetTimelineViewport()"
          >
            重置全量时间轴 [0% - 100%]
          </button>
        </div>

        <!-- 时间条轨道：支持直接在任意位置 pointerdown 拖拽刷选新区域 ('brush') -->
        <div
          v-timeline-track
          class="relative flex h-10 w-full cursor-crosshair items-end gap-px border border-media-track bg-media-backdrop p-1 overflow-hidden"
          title="按住鼠标左键并左右拖拽即可直接刷选新的时间区间"
          @pointerdown="logger.startTimelineDrag('brush', $event)"
        >
          <div
            v-for="bucket in logger.timelineBuckets"
            :key="bucket.index"
            class="pointer-events-none flex-1 transition-all"
            :class="
              bucket.hasError
                ? 'bg-destructive'
                : bucket.hasWarn
                  ? 'bg-brand'
                  : 'bg-media-buffered'
            "
            :style="{ height: `${bucket.heightPercent}%` }"
          />

          <!-- 当前选区高亮窗（主体 pointer-events-none 以允许随时在轨道内刷选新区域；顶部横条可平移，左右边缘可缩放） -->
          <div
            class="pointer-events-none absolute inset-y-0 border-x-2 border-brand bg-brand/20"
            :style="{
              left: `${logger.viewStartRatio * 100}%`,
              width: `${Math.max(2, (logger.viewEndRatio - logger.viewStartRatio) * 100)}%`,
            }"
          >
            <!-- 顶部平移抓手条 ('move') -->
            <div
              class="pointer-events-auto absolute inset-x-2 top-0 flex h-3 cursor-grab items-center justify-center bg-brand/70 text-[11px] leading-none text-brand-foreground active:cursor-grabbing"
              title="按住平移当前时间选区"
              @pointerdown.stop="logger.startTimelineDrag('move', $event)"
            >
              ═══
            </div>
            <!-- 左边界缩放手柄 ('left') -->
            <div
              class="pointer-events-auto absolute inset-y-0 left-0 w-2.5 cursor-ew-resize bg-brand/80 hover:bg-brand"
              title="拖拽调整起始时间"
              @pointerdown.stop="logger.startTimelineDrag('left', $event)"
            />
            <!-- 右边界缩放手柄 ('right') -->
            <div
              class="pointer-events-auto absolute inset-y-0 right-0 w-2.5 cursor-ew-resize bg-brand/80 hover:bg-brand"
              title="拖拽调整结束时间"
              @pointerdown.stop="logger.startTimelineDrag('right', $event)"
            />
          </div>
        </div>

        <!-- 底部时间轴刻度尺 (Bottom Time Axis Ruler) -->
        <div class="mt-1 flex items-center justify-between px-0.5 text-[11px] text-media-muted tabular-nums">
          <div
            v-for="tick in logger.timelineAxisTicks"
            :key="tick.index"
            class="flex flex-col"
            :class="
              tick.index === 0
                ? 'items-start'
                : tick.index === logger.timelineAxisTicks.length - 1
                  ? 'items-end'
                  : 'items-center'
            "
          >
            <span class="h-1.5 w-px bg-media-buffered" />
            <span class="mt-0.5">{{ tick.label }}</span>
          </div>
        </div>
      </div>

      <!-- 第四栏：黑色项目终端输出视口（左侧行号 + 右侧完整自动换行日志） -->
      <div
        v-terminal-scroll
        class="h-96 overflow-y-auto bg-media-backdrop px-2 py-2 font-mono text-[11px] text-media-foreground"
        @scroll="logger.handleTerminalScroll($event)"
      >
        <!-- 项目终端命令提示符头 -->
        <div class="mb-2 border-b border-media-track pb-1.5 px-1 text-media-muted selectable-text">
          <span class="text-brand font-semibold">lattice@archive-v2</span>
          <span> % lattice-trace --stream=local,remote,frontend --wrap --line-numbers</span>
        </div>

        <div
          v-if="logger.virtualSlice.totalRows === 0"
          class="flex h-64 items-center justify-center text-media-muted"
        >
          暂无匹配的运行日志（点亮上方 LOCAL / REMOTE / FRONTEND 标签后触发操作即可实时捕获）
        </div>
        <div v-else class="space-y-0.5">
          <div
            v-for="row in logger.virtualSlice.rows"
            :key="row.entry.id"
            class="flex items-start gap-2 px-1 py-0.5 hover:bg-media-surface"
            :class="
              row.entry.level === 'ERROR'
                ? 'text-destructive font-semibold'
                : row.entry.level === 'WARN'
                  ? 'text-brand font-medium'
                  : 'text-media-foreground'
            "
          >
            <!-- 左端：4位定宽行号栏 (Line Number Gutter) -->
            <span
              class="w-12 shrink-0 select-none border-r border-media-track pr-2 text-right text-media-muted tabular-nums leading-relaxed"
            >
              {{ String(row.lineNumber).padStart(4, '0') }}
            </span>

            <!-- 树状层级缩进与折叠开关 -->
            <div
              class="flex shrink-0 items-center leading-relaxed select-none"
              :style="{ paddingLeft: `${row.depth * 14}px` }"
            >
              <button
                v-if="row.isRoot && row.hasChildren"
                type="button"
                class="w-4 shrink-0 text-center text-media-muted hover:text-media-foreground"
                @click="logger.toggleTraceCollapse(row.entry.traceId)"
              >
                {{ row.isCollapsed ? '▶' : '▼' }}
              </button>
              <span v-else class="w-4 shrink-0 text-center text-media-muted">
                {{ row.isRoot ? '•' : '├─' }}
              </span>
            </div>

            <!-- 右侧：完整自动换行日志正文 (whitespace-pre-wrap break-all，绝不截断) -->
            <span class="min-w-0 flex-1 whitespace-pre-wrap break-all leading-relaxed selectable-text">{{
              row.formattedLine
            }}</span>
          </div>
        </div>
      </div>

      <!-- 状态反馈栏 -->
      <div
        v-if="logger.statusNotice"
        class="border-t border-media-track bg-media-surface px-3 py-1.5 text-[11px] text-brand"
      >
        {{ logger.statusNotice }}
      </div>
    </div>
  </section>
</template>
