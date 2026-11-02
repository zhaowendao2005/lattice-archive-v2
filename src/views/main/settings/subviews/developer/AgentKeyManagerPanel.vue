<script setup lang="ts">
/**
 * [VIEW] Agent 运行日志渐进式查询访问密钥管理面板 (AgentKeyManagerPanel.vue)
 * 严格遵循零本地 ref / reactive 与语义化视觉令牌规范。
 */
import type { AgentKeyTtlPreset } from '@/stores/app/data-sources/debugLoggerDataSource';
import { useDebugLoggerStore } from '@/stores/app/stores/debugLoggerStore';

const logger = useDebugLoggerStore();

const ttlOptions: { value: AgentKeyTtlPreset; label: string }[] = [
  { value: '1h', label: '1 小时' },
  { value: '24h', label: '24 小时 (推荐)' },
  { value: '7d', label: '7 天' },
  { value: '30d', label: '30 天' },
  { value: 'never', label: '永不过期' },
];

function formatTime(ms: number): string {
  if (!ms || ms <= 0) return '永不过期';
  return new Date(ms).toLocaleString('zh-CN');
}
</script>

<template>
  <section class="space-y-2">
    <div>
      <div class="text-sm font-medium text-foreground">Agent 访问密钥与生命周期管理</div>
      <p class="text-xs text-muted-foreground">
        签发专供 Agent 渐进式检索运行日志的只读访问凭证（服务端仅存储 SHA-256 摘要）
      </p>
    </div>

    <div class="rounded-none border border-border bg-card divide-y divide-border text-xs">
      <!-- 创建新密钥表单 -->
      <div class="flex flex-wrap items-center gap-2 p-3">
        <input
          type="text"
          :value="logger.newKeyName"
          placeholder="密钥备注名称..."
          class="h-8 flex-1 min-w-40 rounded-none border border-border bg-background px-2.5 text-xs text-foreground outline-none focus:border-brand"
          @input="logger.newKeyName = ($event.target as HTMLInputElement).value"
        />
        <select
          :value="logger.newKeyTtlPreset"
          class="h-8 rounded-none border border-border bg-background px-2.5 text-xs text-foreground outline-none focus:border-brand"
          @change="logger.newKeyTtlPreset = ($event.target as HTMLSelectElement).value as AgentKeyTtlPreset"
        >
          <option v-for="opt in ttlOptions" :key="opt.value" :value="opt.value">
            有效期：{{ opt.label }}
          </option>
        </select>
        <button
          type="button"
          class="h-8 rounded-none border border-brand bg-brand px-3 text-xs font-semibold text-white transition-colors hover:opacity-90"
          @click="logger.createNewAgentKey()"
        >
          {{ logger.isCreatingKey ? '正在签发…' : '+ 创建访问密钥' }}
        </button>
      </div>

      <!-- 当前激活明文密钥提示 -->
      <div v-if="logger.activeRawKey" class="flex items-center justify-between gap-2 bg-muted/40 px-3 py-2 font-mono">
        <div class="truncate">
          <span class="text-muted-foreground">当前剪贴板绑定密钥：</span>
          <span class="font-semibold text-brand">{{ logger.activeRawKey }}</span>
        </div>
        <button
          type="button"
          class="shrink-0 rounded-none border border-brand bg-brand/10 px-2.5 py-1 text-[11px] font-semibold text-brand hover:bg-brand hover:text-white"
          @click="logger.copyAgentSkillAndKeyBundle()"
        >
          复制接口 + Skills + 密钥
        </button>
      </div>

      <!-- 已签发密钥列表 -->
      <div v-if="logger.agentKeys.length === 0" class="p-4 text-center text-muted-foreground">
        暂无已创建的 Agent 访问密钥（点击上方「AGENT SKILL」按钮也会自动为您签发）
      </div>
      <div v-else class="divide-y divide-border">
        <div
          v-for="item in logger.agentKeys"
          :key="item.id"
          class="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5"
        >
          <div class="space-y-0.5">
            <div class="flex items-center gap-2">
              <span class="font-medium text-foreground">{{ item.name }}</span>
              <span class="font-mono text-[11px] text-muted-foreground">{{ item.keyPrefix }}</span>
              <span
                v-if="item.expired"
                class="rounded-none border border-destructive px-1.5 py-0.5 text-[10px] text-destructive"
              >
                已过期
              </span>
            </div>
            <div class="font-mono text-[11px] text-muted-foreground">
              到期：{{ formatTime(item.expiresAt) }}
              <span v-if="item.lastUsedAt > 0"> · 最近调用：{{ formatTime(item.lastUsedAt) }}</span>
            </div>
          </div>
          <button
            type="button"
            class="rounded-none border border-border bg-background px-2.5 py-1 text-[11px] text-destructive hover:bg-destructive hover:text-white"
            @click="logger.revokeAgentKey(item.id)"
          >
            吊销
          </button>
        </div>
      </div>
    </div>
  </section>
</template>
