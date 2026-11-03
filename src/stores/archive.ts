/**
 * ============================================================================
 * 归档 Store（早期原型业务，采用组合式 Store 写法）
 * ============================================================================
 * 与其它域的三层结构（data-sources + stores）不同，这里是 vue 早期版本，
 * 直接引用 dbService。新业务请按 .rules/state-management.md 的三层式组织，
 * 不要再把这个文件当成模板。
 *
 * 职责：列表读取、关键词/分类筛选、增删。
 */
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import type { ArchiveItem, PlatformInfo } from '../types/database';
import { dbService } from './archive/data-sources/databaseDataSource';

export const useArchiveStore = defineStore('archive', () => {
  // ── 数据 ────────────────────────────────────────────────
  const archives = ref<ArchiveItem[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);
  const platformInfo = ref<PlatformInfo | null>(null);
  // ── 筛选条件（属于页面状态，所以也放在 Store）──
  const selectedCategory = ref<string>('All');
  const searchQuery = ref<string>('');

  /** 由现有数据动态聚合出分类列表，首个固定为「全部」 */
  const categories = computed(() => {
    const set = new Set<string>();
    archives.value.forEach(a => set.add(a.category));
    return ['All', ...Array.from(set)];
  });

  /** 分类 + 关键词双重过滤（标题 / 正文 / 标签任一命中即可） */
  const filteredArchives = computed(() => {
    return archives.value.filter(item => {
      const matchCategory =
        selectedCategory.value === 'All' || item.category === selectedCategory.value;
      const q = searchQuery.value.toLowerCase().trim();
      const matchSearch =
        !q ||
        item.title.toLowerCase().includes(q) ||
        item.content.toLowerCase().includes(q) ||
        item.tags.some(t => t.toLowerCase().includes(q));
      return matchCategory && matchSearch;
    });
  });

  /** 读取宿主平台信息（Electron 路径 / 版本号），失败只打日志不影响页面 */
  async function fetchPlatformInfo() {
    try {
      platformInfo.value = await dbService.getPlatformInfo();
    } catch (err: any) {
      console.error('Failed to get platform info:', err);
    }
  }

  /** 全量拉取归档；loading/error 用来驱动列表的三态展示 */
  async function loadArchives() {
    loading.value = true;
    error.value = null;
    try {
      archives.value = await dbService.getAllArchives();
    } catch (err: any) {
      error.value = err.message || 'Failed to fetch archives';
    } finally {
      loading.value = false;
    }
  }

  /** 新增后重新拉取列表（简单粗暴但能保证与服务端顺序一致） */
  async function addArchive(item: { title: string; category: string; content: string; tags: string[] }) {
    loading.value = true;
    try {
      await dbService.createArchive(item);
      await loadArchives();
      return true;
    } catch (err: any) {
      error.value = err.message || 'Failed to add archive';
      return false;
    } finally {
      loading.value = false;
    }
  }

  /** 删除：成功后只从本地数组移除，不重新拉全量，减少一次往返 */
  async function removeArchive(id: number) {
    try {
      await dbService.deleteArchive(id);
      archives.value = archives.value.filter(a => a.id !== id);
    } catch (err: any) {
      error.value = err.message || 'Failed to delete archive';
    }
  }

  // 对外暴露：状态 + 派生数据 + 动作（组合式 Store 必须显式 return）
  return {
    archives,
    loading,
    error,
    platformInfo,
    selectedCategory,
    searchQuery,
    categories,
    filteredArchives,
    fetchPlatformInfo,
    loadArchives,
    addArchive,
    removeArchive,
  };
});
