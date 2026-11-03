/**
 * [STORE] Telegram 性能与并发配额（设置 → 性能与网络）
 *
 * 唯一真相来源：当前模式、自定义草稿、保存提示与校验错误。
 * 数据流：View（零 ref）→ 本 Store action → telegramPerformancePreferences（落盘 + 主线程限流器）
 *        → mtprotoHub.bridge().setConcurrency（Worker RequestScheduler）。
 * 运行时临时降速只发生在 Worker 内，不回写这里的用户配置。
 */
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import {
  MEDIA_SUB_POOLS,
  NON_MEDIA_SUB_POOLS,
  TELEGRAM_CONCURRENCY_BOUNDS,
  TELEGRAM_CONCURRENCY_KEYS,
  TELEGRAM_CONCURRENCY_PRESETS,
  type TelegramConcurrencyConfig,
  type TelegramConcurrencyKey,
  type TelegramConcurrencyLimits,
  type TelegramConcurrencyMode,
} from '@/worker/local/telegram/contracts/concurrency';
import { telegramPerformancePreferences } from '../data-sources/telegramPerformancePreferences';
import { mtprotoHub } from '../data-sources/mtprotoBridge';

export const CONCURRENCY_FIELD_LABELS: Record<TelegramConcurrencyKey, string> = {
  nonMediaRpc: '账号级非媒体 RPC',
  mediaRpc: '账号级媒体 RPC',
  totalActiveTasks: '账号级总活跃任务',
  search: '搜索并发',
  chatRead: 'Chat 读取并发',
  chatCommand: 'Chat 命令并发',
  bot: '机器人交互并发',
  vault: '保险库转存并发',
  account: '账号会话并发',
  cover: '封面并发',
  searchCoverReserved: '搜索封面保留槽位',
  avatar: '头像并发',
  fullMedia: '完整文件下载',
  mediaPart: '文件分片并发',
  streamPart: '视频流分片并发',
};

export const useTelegramPerformanceStore = defineStore('telegramPerformance', () => {
  const initial = telegramPerformancePreferences.read();
  const mode = ref<TelegramConcurrencyMode>(initial.mode);
  const applied = ref<TelegramConcurrencyLimits>({ ...initial.limits });
  /** 自定义表单草稿：输入框内容（字符串，提交时校验）。 */
  const draft = ref<Record<TelegramConcurrencyKey, string>>(toDraft(initial.limits));
  const draftErrors = ref<Partial<Record<TelegramConcurrencyKey, string>>>({});
  const notice = ref('');
  const focusKey = ref<TelegramConcurrencyKey | null>(null);

  const isCustom = computed(() => mode.value === 'custom');
  const fields = computed(() => TELEGRAM_CONCURRENCY_KEYS.map((key) => ({
    key,
    label: CONCURRENCY_FIELD_LABELS[key],
    min: TELEGRAM_CONCURRENCY_BOUNDS[key].min,
    max: TELEGRAM_CONCURRENCY_BOUNDS[key].max,
    value: draft.value[key],
    applied: applied.value[key],
    error: draftErrors.value[key] ?? '',
  })));

  function toDraft(limits: TelegramConcurrencyLimits): Record<TelegramConcurrencyKey, string> {
    return Object.fromEntries(TELEGRAM_CONCURRENCY_KEYS.map((key) => [key, String(limits[key])])) as Record<TelegramConcurrencyKey, string>;
  }

  function commit(config: TelegramConcurrencyConfig, message: string) {
    const saved = telegramPerformancePreferences.write(config);
    mode.value = saved.mode;
    applied.value = { ...saved.limits };
    draft.value = toDraft(saved.limits);
    draftErrors.value = {};
    notice.value = message;
    mtprotoHub.bridge().setConcurrency(saved);
  }

  /** 选择预设：立即生效；选择自定义：以当前生效值作为草稿起点，待提交后生效。 */
  function selectMode(next: TelegramConcurrencyMode) {
    if (next === 'custom') {
      mode.value = 'custom';
      draft.value = toDraft(applied.value);
      draftErrors.value = {};
      notice.value = '';
      return;
    }
    commit({ mode: next, limits: { ...TELEGRAM_CONCURRENCY_PRESETS[next] } }, '已切换并立即生效，影响后续请求');
  }

  function updateDraft(key: TelegramConcurrencyKey, value: string) {
    draft.value = { ...draft.value, [key]: value };
    if (draftErrors.value[key]) {
      const next = { ...draftErrors.value };
      delete next[key];
      draftErrors.value = next;
    }
    notice.value = '';
  }

  /** 提交自定义配置：逐项校验，聚焦第一个错误项并给出中文提示（主按钮不置灰）。 */
  function applyCustom() {
    const errors: Partial<Record<TelegramConcurrencyKey, string>> = {};
    const limits = {} as TelegramConcurrencyLimits;
    for (const key of TELEGRAM_CONCURRENCY_KEYS) {
      const { min, max } = TELEGRAM_CONCURRENCY_BOUNDS[key];
      const raw = draft.value[key].trim();
      const num = Number(raw);
      if (!raw || !Number.isInteger(num)) errors[key] = '请输入整数';
      else if (num < min || num > max) errors[key] = `范围 ${min}–${max}`;
      else limits[key] = num;
    }
    if (!errors.searchCoverReserved && !errors.cover && limits.searchCoverReserved > limits.cover) {
      errors.searchCoverReserved = '不能超过封面并发';
    }
    for (const key of MEDIA_SUB_POOLS) {
      if (!errors[key] && !errors.mediaRpc && limits[key] > limits.mediaRpc) errors[key] = '不能超过账号级媒体 RPC';
    }
    for (const key of NON_MEDIA_SUB_POOLS) {
      if (!errors[key] && !errors.nonMediaRpc && limits[key] > limits.nonMediaRpc) errors[key] = '不能超过账号级非媒体 RPC';
    }
    if (!errors.totalActiveTasks && !errors.mediaRpc && !errors.nonMediaRpc && limits.totalActiveTasks < Math.max(limits.mediaRpc, limits.nonMediaRpc)) {
      errors.totalActiveTasks = '不能小于媒体 / 非媒体 RPC 预算';
    }
    const firstError = TELEGRAM_CONCURRENCY_KEYS.find((key) => errors[key]);
    if (firstError) {
      draftErrors.value = errors;
      notice.value = '';
      focusKey.value = firstError;
      return;
    }
    commit({ mode: 'custom', limits }, '自定义配额已保存并生效');
  }

  function resetDefault() {
    commit({ mode: 'balanced', limits: { ...TELEGRAM_CONCURRENCY_PRESETS.balanced } }, '已恢复默认均衡模式');
  }

  function consumeFocus() { focusKey.value = null; }

  return {
    mode,
    applied,
    draft,
    draftErrors,
    notice,
    focusKey,
    isCustom,
    fields,
    selectMode,
    updateDraft,
    applyCustom,
    resetDefault,
    consumeFocus,
  };
});
