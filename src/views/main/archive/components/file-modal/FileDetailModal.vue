<script setup lang="ts">
import { computed, ref } from 'vue';
import { FolderPlus, Pencil, X } from '@lucide/vue';
import type { FileTileData } from '../../types/tile';
import { getTileSpan, useTileStore } from '../../store/tileStore';
import { getFileVisual } from '../tiles/fileVisuals';

const props = defineProps<{
  file: FileTileData;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const tileStore = useTileStore();
const isEditing = ref(false);
const titleVal = ref(props.file.title);
const descVal = ref(props.file.description || '');

const visual = computed(() => getFileVisual(props.file.fileType));
const span = computed(() => getTileSpan(props.file.size, props.file.customSpan));
const groupTitle = computed(
  () => tileStore.groups.find(g => g.id === props.file.groupId)?.title ?? '未分组',
);

function saveEdits() {
  if (titleVal.value.trim()) {
    props.file.title = titleVal.value.trim();
  }
  props.file.description = descVal.value.trim();
  props.file.updatedAt = new Date().toISOString().slice(0, 10);
  tileStore.saveState();
  isEditing.value = false;
}

function cancelEdits() {
  titleVal.value = props.file.title;
  descVal.value = props.file.description || '';
  isEditing.value = false;
}

function handleAddToFolder() {
  const folders = tileStore.tiles.filter(t => t.type === 'folder') as any[];
  if (folders.length === 0) {
    alert('当前没有可用的文件夹，请先在空白处右键新建文件夹。');
    return;
  }
  const folderNames = folders.map((f, i) => `${i + 1}. ${f.title}`).join('\n');
  const choice = prompt(`请选择要加入的文件夹序号：\n${folderNames}`, '1');
  const index = Number(choice) - 1;
  if (!Number.isNaN(index) && folders[index]) {
    tileStore.addFileToFolder(folders[index].id, props.file.id);
    emit('close');
  }
}
</script>

<template>
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/25 p-4 backdrop-blur-[1px]"
    @click.self="emit('close')"
  >
    <!-- 文件详情：占屏很大的高透灰色亚克力面板 -->
    <div
      class="archive-modal-card relative flex h-[min(860px,90vh)] w-[min(1280px,94vw)] flex-col overflow-hidden border border-white/15 bg-[#0f172a]/70 text-white shadow-[inset_0_1px_0_0_rgba(255,255,255,0.14),0_24px_60px_-12px_rgba(0,0,0,0.6)] backdrop-blur-2xl"
    >
      <!-- 顶栏 -->
      <header class="flex shrink-0 items-center gap-2.5 border-b border-white/10 px-4 py-3">
        <span
          class="flex size-[26px] shrink-0 items-center justify-center border border-white/10"
          :class="visual.tint"
        >
          <component :is="visual.icon" class="size-4" :class="visual.color" :stroke-width="1.8" />
        </span>

        <h2 class="min-w-0 truncate text-[14px] font-medium tracking-wide text-white/90">
          {{ file.title }}
        </h2>

        <span
          class="shrink-0 border border-white/10 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-white/45"
        >
          {{ file.extension || file.fileType }}
        </span>

        <div class="ml-auto flex shrink-0 items-center gap-1">
          <button
            v-if="!isEditing"
            type="button"
            class="flex size-[26px] items-center justify-center border border-white/10 text-white/45 transition-colors hover:border-white/25 hover:text-white"
            title="编辑文件信息"
            @click="isEditing = true"
          >
            <Pencil class="size-3.5" :stroke-width="1.75" />
          </button>

          <button
            type="button"
            class="flex size-[26px] items-center justify-center border border-white/10 text-white/45 transition-colors hover:border-white/25 hover:text-white"
            title="关闭"
            @click="emit('close')"
          >
            <X class="size-3.5" :stroke-width="1.75" />
          </button>
        </div>
      </header>

      <!-- 主体 -->
      <div class="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[1fr_300px]">
        <!-- 左：归档备忘正文 -->
        <section class="min-h-0 overflow-y-auto px-6 py-6 md:px-9 md:py-8">
          <template v-if="!isEditing">
            <p class="text-[10px] uppercase tracking-[0.18em] text-white/30">
              Archive Note / 归档备忘
            </p>
            <p
              class="selectable-text mt-4 whitespace-pre-wrap text-[14px] leading-7 text-white/85"
            >
              {{ file.description || '暂无描述。点击右上角编辑，为这个文件补充说明。' }}
            </p>
          </template>

          <template v-else>
            <label class="text-[10px] uppercase tracking-[0.18em] text-white/30">文件标题</label>
            <input
              v-model="titleVal"
              type="text"
              class="mt-2 w-full border border-white/20 bg-black/25 px-3 py-2 text-sm text-white outline-none focus:border-sky-400/70"
            />

            <label class="mt-6 block text-[10px] uppercase tracking-[0.18em] text-white/30">
              描述备忘
            </label>
            <textarea
              v-model="descVal"
              rows="12"
              class="mt-2 w-full resize-none border border-white/20 bg-black/25 p-3 text-sm leading-6 text-white outline-none focus:border-sky-400/70"
            />
          </template>
        </section>

        <!-- 右：属性与操作 -->
        <aside
          class="flex min-h-0 flex-col border-t border-white/10 md:border-l md:border-t-0"
        >
          <div class="min-h-0 flex-1 overflow-y-auto px-5 py-6">
            <p class="text-[10px] uppercase tracking-[0.18em] text-white/30">属性</p>

            <dl class="mt-2 divide-y divide-white/[0.06] text-[11px]">
              <div class="flex items-center justify-between gap-3 py-2">
                <dt class="text-white/40">类型</dt>
                <dd class="truncate text-white/75">{{ file.fileType.toUpperCase() }}</dd>
              </div>
              <div class="flex items-center justify-between gap-3 py-2">
                <dt class="text-white/40">扩展名</dt>
                <dd class="truncate font-mono text-white/75">
                  {{ file.extension ? file.extension.toUpperCase() : '—' }}
                </dd>
              </div>
              <div class="flex items-center justify-between gap-3 py-2">
                <dt class="text-white/40">磁贴尺寸</dt>
                <dd class="font-mono text-white/75">{{ span.w }} × {{ span.h }} 格</dd>
              </div>
              <div class="flex items-center justify-between gap-3 py-2">
                <dt class="text-white/40">所在分组</dt>
                <dd class="truncate text-white/75">{{ groupTitle }}</dd>
              </div>
              <div class="flex items-center justify-between gap-3 py-2">
                <dt class="text-white/40">文件大小</dt>
                <dd class="font-mono text-white/75">{{ file.fileSize || '—' }}</dd>
              </div>
              <div class="flex items-center justify-between gap-3 py-2">
                <dt class="text-white/40">创建日期</dt>
                <dd class="font-mono text-white/75">{{ file.createdAt }}</dd>
              </div>
              <div class="flex items-center justify-between gap-3 py-2">
                <dt class="text-white/40">更新时间</dt>
                <dd class="font-mono text-white/75">{{ file.updatedAt }}</dd>
              </div>
            </dl>
          </div>

          <div class="shrink-0 space-y-2 border-t border-white/10 p-3">
            <button
              type="button"
              class="flex w-full items-center justify-center gap-1.5 border border-white/10 py-2 text-[11px] text-white/65 transition-colors hover:border-white/25 hover:text-white"
              @click="handleAddToFolder"
            >
              <FolderPlus class="size-3.5" :stroke-width="1.75" />
              <span>移入文件夹</span>
            </button>

            <div class="flex items-center gap-2">
              <template v-if="!isEditing">
                <button
                  type="button"
                  class="flex flex-1 items-center justify-center gap-1.5 bg-white/10 py-2 text-[11px] text-white/85 transition-colors hover:bg-white/15"
                  @click="isEditing = true"
                >
                  <Pencil class="size-3.5" :stroke-width="1.75" />
                  <span>编辑信息</span>
                </button>
              </template>
              <template v-else>
                <button
                  type="button"
                  class="flex-1 border border-white/10 py-2 text-[11px] text-white/60 transition-colors hover:border-white/25 hover:text-white"
                  @click="cancelEdits"
                >
                  取消
                </button>
                <button
                  type="button"
                  class="flex-1 bg-sky-500/90 py-2 text-[11px] font-medium text-white transition-colors hover:bg-sky-500"
                  @click="saveEdits"
                >
                  保存
                </button>
              </template>
            </div>
          </div>
        </aside>
      </div>
    </div>
  </div>
</template>
