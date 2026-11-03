<script setup lang="ts">
/**
 * [VIEW] 搜索机器人翻页收割候选池弹窗 (BotHarvestCandidateModal)
 * 严格遵循零本地 ref / reactive 约束。
 */
import { Bot, CheckSquare, ExternalLink, FolderPlus, Sparkles, Square, Trash2, X } from '@lucide/vue';
import { useBotHarvesterStore } from '@/stores/chat/stores/botHarvesterStore';
import { useTileStore } from '@/stores/archive/stores/tileStore';

const harvesterStore = useBotHarvesterStore();
const tileStore = useTileStore();
</script>

<template>
  <Teleport to="body">
    <Transition name="fade">
      <div
        v-if="harvesterStore.isCandidateModalOpen"
        class="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-md p-4"
        @click.self="harvesterStore.closeCandidateModal()"
      >
        <div class="flex h-[82vh] w-full max-w-3xl flex-col overflow-hidden rounded-3xl border border-border bg-card text-card-foreground shadow-2xl">
          <!-- 头部 -->
          <header class="flex items-center justify-between border-b border-border bg-muted/30 px-6 py-4">
            <div class="flex items-center gap-3">
              <div class="flex size-9 items-center justify-center rounded-2xl bg-primary/15 text-primary">
                <Bot class="size-5" />
              </div>
              <div>
                <h2 class="text-base font-bold text-foreground">
                  搜索机器人链接收割池 ({{ harvesterStore.candidates.length }})
                </h2>
                <p class="text-xs text-muted-foreground">
                  支持一键免打扰入驻临时会话凭据池，或批量静默加群并归档至探索页
                </p>
              </div>
            </div>
            <button
              type="button"
              class="rounded-full p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
              @click="harvesterStore.closeCandidateModal()"
            >
              <X class="size-5" />
            </button>
          </header>

          <!-- 工具栏与入驻配置 -->
          <div class="border-b border-border bg-muted/15 px-6 py-3 space-y-3 text-xs">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <div class="flex rounded-lg border border-border bg-background p-0.5">
                <button
                  v-for="tab in [
                    { id: 'all', label: '全部' },
                    { id: 'username', label: '公开频道/群' },
                    { id: 'invite_hash', label: '私有邀请 (+hash)' },
                    { id: 'deep_link', label: '单条消息深链' },
                  ]"
                  :key="tab.id"
                  type="button"
                  class="rounded-md px-2.5 py-1 transition-colors"
                  :class="
                    harvesterStore.candidateFilterKind === tab.id
                      ? 'bg-primary text-primary-foreground font-semibold'
                      : 'text-muted-foreground hover:text-foreground'
                  "
                  @click="harvesterStore.candidateFilterKind = tab.id as any"
                >
                  {{ tab.label }}
                </button>
              </div>

              <div class="flex items-center gap-2">
                <button
                  type="button"
                  class="rounded-lg border border-border bg-background px-2.5 py-1 text-foreground hover:bg-accent"
                  @click="harvesterStore.selectAllFiltered()"
                >
                  全选当前
                </button>
                <button
                  type="button"
                  class="rounded-lg border border-border bg-background px-2.5 py-1 text-muted-foreground hover:text-foreground"
                  @click="harvesterStore.clearSelection()"
                >
                  取消全选
                </button>
                <button
                  type="button"
                  class="flex items-center gap-1 rounded-lg border border-border bg-background px-2.5 py-1 text-destructive hover:bg-destructive/10"
                  @click="harvesterStore.clearPool()"
                >
                  <Trash2 class="size-3.5" />
                  <span>清空池</span>
                </button>
              </div>
            </div>

            <div class="flex flex-wrap items-center justify-between gap-3 border-t border-border/60 pt-2.5">
              <div class="flex flex-wrap items-center gap-3">
                <label class="flex items-center gap-1.5 text-muted-foreground">
                  <span>收纳分组：</span>
                  <select
                    :value="harvesterStore.targetExploreGroupId"
                    class="h-7 rounded-lg border border-border bg-background px-2 text-xs text-foreground"
                    @change="harvesterStore.targetExploreGroupId = ($event.target as HTMLSelectElement).value"
                  >
                    <option v-for="g in tileStore.groups" :key="g.id" :value="g.id">{{ g.title }}</option>
                  </select>
                </label>

                <label class="flex items-center gap-1.5 text-muted-foreground">
                  <span>入驻方式：</span>
                  <select
                    :value="harvesterStore.placementMode"
                    class="h-7 rounded-lg border border-border bg-background px-2 text-xs text-foreground"
                    @change="harvesterStore.placementMode = ($event.target as HTMLSelectElement).value as any"
                  >
                    <option value="temp_auto_renew">🔵 免加群 · 临时自动续期凭据 (推荐)</option>
                    <option value="temp_ephemeral">🟡 免加群 · 单次临时快照凭据</option>
                    <option value="joined">🟢 正式加入并在 Telegram 归档</option>
                  </select>
                </label>
              </div>

              <button
                type="button"
                class="flex items-center gap-1.5 rounded-xl bg-primary px-4 py-1.5 text-xs font-semibold text-primary-foreground"
                @click="harvesterStore.commitSelectedCandidates()"
              >
                <FolderPlus class="size-3.5" />
                <span>
                  {{
                    harvesterStore.isCommitting
                      ? '正在入驻…'
                      : `一键收纳已选 (${harvesterStore.selectedCandidates.length})`
                  }}
                </span>
              </button>
            </div>

            <p v-if="harvesterStore.harvestNotice" class="font-medium text-primary">
              {{ harvesterStore.harvestNotice }}
            </p>
          </div>

          <!-- 候选列表 -->
          <div class="flex-1 min-h-0 overflow-y-auto p-4 space-y-2">
            <div
              v-if="harvesterStore.filteredCandidates.length === 0"
              class="flex flex-col items-center justify-center py-16 text-center text-muted-foreground"
            >
              <Sparkles class="size-8 mb-2 opacity-40" />
              <p class="text-sm font-medium">暂无收割到的链接条目</p>
            </div>

            <div
              v-for="item in harvesterStore.filteredCandidates"
              :key="item.key"
              class="flex items-center justify-between gap-3 rounded-xl border p-3 text-xs transition-colors cursor-pointer"
              :class="item.selected ? 'border-primary bg-primary/5' : 'border-border bg-background hover:bg-accent/40'"
              @click="harvesterStore.toggleCandidate(item.key)"
            >
              <div class="flex min-w-0 items-center gap-2.5">
                <component
                  :is="item.selected ? CheckSquare : Square"
                  class="size-4 shrink-0"
                  :class="item.selected ? 'text-primary' : 'text-muted-foreground'"
                />
                <div class="min-w-0">
                  <div class="flex items-center gap-2">
                    <span class="truncate font-semibold text-foreground">{{ item.title }}</span>
                    <span class="shrink-0 rounded bg-secondary px-1.5 py-0.5 text-[10px] text-secondary-foreground">
                      P{{ item.sourcePage }}
                    </span>
                  </div>
                  <p class="truncate text-[11px] text-muted-foreground">{{ item.sourceTextSnippet }}</p>
                </div>
              </div>

              <a
                :href="item.sourceTextSnippet"
                target="_blank"
                rel="noopener noreferrer"
                class="shrink-0 rounded-lg p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                title="在新标签页预览链接"
                @click.stop
              >
                <ExternalLink class="size-3.5" />
              </a>
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
