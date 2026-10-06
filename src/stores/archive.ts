import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type { ArchiveItem, PlatformInfo } from '../types/database';
import { dbService } from '../services/database';

export const useArchiveStore = defineStore('archive', () => {
  const archives = ref<ArchiveItem[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);
  const platformInfo = ref<PlatformInfo | null>(null);
  const selectedCategory = ref<string>('All');
  const searchQuery = ref<string>('');

  const categories = computed(() => {
    const set = new Set<string>();
    archives.value.forEach(a => set.add(a.category));
    return ['All', ...Array.from(set)];
  });

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

  async function fetchPlatformInfo() {
    try {
      platformInfo.value = await dbService.getPlatformInfo();
    } catch (err: any) {
      console.error('Failed to get platform info:', err);
    }
  }

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

  async function removeArchive(id: number) {
    try {
      await dbService.deleteArchive(id);
      archives.value = archives.value.filter(a => a.id !== id);
    } catch (err: any) {
      error.value = err.message || 'Failed to delete archive';
    }
  }

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
