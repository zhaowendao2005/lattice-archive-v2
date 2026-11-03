/**
 * ============================================================================
 * 聚合搜索系统状态存储器 (Aggregate Search Store)
 * ============================================================================
 * 严格遵循 `.rules/state-management.md` 视图层零本地 `ref` 铁律：
 * 弹窗开关、左右两栏折叠态、左栏 Tree 展开状态、中栏搜索词、筛选菜单展开与「搜索前/搜索后」多选态、
 * 右栏两类会话范围（已加入会话 / 只有凭据会话）控制、流式检索结果与分页懒加载、
 * 卡片高亮多选与 Shift 连续多选、跨栏拖拽归档状态全部收敛于此 Store。
 */
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import type { FileTileData, FolderTileData } from '@/views/main/archive/types/tile';
import { useTileStore } from '@/stores/archive/stores/tileStore';
import { aggregateSearchDataSource } from '../data-sources/aggregateSearchDataSource';
import { debugLoggerDataSource } from '@/stores/app/data-sources/debugLoggerDataSource';
import { classifyTelegramError } from '@/worker/local/chat/telegramErrors';
import type {
  AggregateSearchResultItem,
  SearchFilterStage,
  SearchPreFilterCategory,
  SearchScopeSessionKind,
  SearchToTreeDragState,
  TreeContextMenuState,
  TreeEditingNodeState,
} from '../types';

const PAGE_SIZE = 15;

export const useAggregateSearchStore = defineStore('aggregateSearch', () => {
  const tileStore = useTileStore();

  // ── 1. 对话框与三栏显隐控制（顶栏 Header 驱动，无突变折叠） ──────────
  const isModalOpen = ref(false);
  const isLeftPaneOpen = ref(true);
  const isRightPaneOpen = ref(true);

  // ── 2. 左栏：磁贴拓扑文件树 Explorer 状态 ───────────────────────────
  const expandedGroupIds = ref<string[]>([]);
  const expandedFolderIds = ref<string[]>([]);
  const expandedExploreFolderIds = ref<string[]>([]);
  const recentlyImportedTargetId = ref<string | null>(null);
  const lastImportBannerText = ref<string | null>(null);
  /** 左栏 Explore 树 macOS 风格上下文菜单状态 */
  const treeContextMenu = ref<TreeContextMenuState>({
    isOpen: false,
    x: 0,
    y: 0,
    targetType: 'blank',
    title: '',
  });
  /** 左栏 Explore 树传统资源管理器行内输入框重命名状态 */
  const editingTreeNode = ref<TreeEditingNodeState>({
    isEditing: false,
    targetType: null,
    id: null,
    parentId: undefined,
    title: '',
  });

  // ── 3. 中栏：搜索框与「搜索前 / 搜索后」筛选菜单状态 ────────────────
  const keyword = ref('');
  const isFilterMenuOpen = ref(false);
  const activeFilterStage = ref<SearchFilterStage>('pre');
  /** 搜索前筛选步骤 1：点击「按文件类型筛选」标签后展开所有可选项 */
  const isPreTypeOptionsListed = ref(false);
  /** 搜索前筛选步骤 2 & 3：多选选中的文件类型（视频、图片、会话、文本文件、其他） */
  const selectedPreCategories = ref<SearchPreFilterCategory[]>([]);
  /** 搜索后筛选：对已流式返回的结果集进行客户端二次筛选 */
  const selectedPostCategories = ref<SearchPreFilterCategory[]>([]);
  const postKeyword = ref('');
  const postResolutionFilter = ref<'all' | '720p' | '1080p' | '4k'>('all');
  const postDurationFilter = ref<'all' | 'short' | 'medium' | 'long'>('all');
  const postSizeFilter = ref<'all' | 'small' | 'medium' | 'large'>('all');
  const postExcludeNoForwards = ref(false);
  const postDeduplicateByDocId = ref(true);

  // ── 4. 右栏：搜索范围控制（按会话维度：已加入会话 / 只有凭据会话） ──
  const activeScopeTab = ref<SearchScopeSessionKind>('joined');
  const selectedScopeSessionIds = ref<string[]>([]);

  // ── 5. 流式搜索与触底懒加载状态 ────────────────────────────────────
  const rawResults = ref<AggregateSearchResultItem[]>([]);
  const isStreaming = ref(false);
  const isLoadingMore = ref(false);
  const hasSearched = ref(false);
  const currentPage = ref(1);
  const totalMatched = ref(0);
  const hasMore = ref(false);
  const searchEpoch = ref(0);

  // ── 6. 搜索结果卡片选择与 Shift 连续多选状态 ───────────────────────
  const selectedResultIds = ref<string[]>([]);
  const lastClickedIndex = ref<number | null>(null);
  /** 正在按需拉取高清缩略图的搜索结果卡片 ID 映射 */
  const loadingHighResIds = ref<Record<string, boolean>>({});
  /** 已完成高清缩略图加载的搜索结果卡片 ID 映射 */
  const highResLoadedIds = ref<Record<string, boolean>>({});
  /** 缩略图 Data URL 解码失败（坏图）的卡片 ID 映射 */
  const brokenThumbIds = ref<Record<string, boolean>>({});

  // ── 7. 向左栏文件树拖拽归档与树内节点拖拽状态 ──────────────────────
  const internalTreeDragTileId = ref<string | null>(null);
  const dragToTree = ref<SearchToTreeDragState>({
    isDragging: false,
    items: [],
    pointerX: 0,
    pointerY: 0,
    hoverTargetType: null,
    hoverTargetId: null,
    hoverTargetTitle: null,
  });

  // ── Getters / 派生状态 ─────────────────────────────────────────────
  const categoryOptions = computed(() => aggregateSearchDataSource.getCategoryOptions());
  const allScopeSessions = computed(() => aggregateSearchDataSource.getScopeSessions());

  const joinedScopeSessions = computed(() =>
    allScopeSessions.value.filter(s => s.kind === 'joined'),
  );
  const credentialOnlyScopeSessions = computed(() =>
    allScopeSessions.value.filter(s => s.kind === 'credential_only'),
  );
  const currentTabScopeSessions = computed(() =>
    activeScopeTab.value === 'joined'
      ? joinedScopeSessions.value
      : credentialOnlyScopeSessions.value,
  );

  const selectedJoinedCount = computed(
    () =>
      joinedScopeSessions.value.filter(s => selectedScopeSessionIds.value.includes(s.id)).length,
  );
  const selectedCredentialCount = computed(
    () =>
      credentialOnlyScopeSessions.value.filter(s => selectedScopeSessionIds.value.includes(s.id))
        .length,
  );

  /** Explore 系统中归类的包含会话的文件夹列表 */
  const exploreSessionFolders = computed(() => {
    return tileStore.tiles
      .filter(
        t =>
          t.type === 'folder' &&
          (t as FolderTileData).children.some(
            c => c.type === 'file' && (c.sessionId || c.isSessionLink || c.peerKey),
          ),
      )
      .map(t => {
        const folder = t as FolderTileData;
        const sessions = folder.children.filter(
          (c): c is FileTileData =>
            c.type === 'file' && Boolean(c.sessionId || c.isSessionLink || c.peerKey),
        );
        return {
          id: folder.id,
          title: folder.title,
          groupId: folder.groupId,
          groupTitle: tileStore.groups.find(g => g.id === folder.groupId)?.title ?? '默认分组',
          sessions: sessions.map(s => ({
            id: s.sessionId || s.peerKey || s.id,
            title: s.title,
            sessionTitle: s.sessionTitle || s.title,
            fileType: s.fileType,
          })),
        };
      });
  });

  /** Explore 系统中直接位于分组根目录下的独立会话链接 */
  const exploreStandaloneSessions = computed(() => {
    return tileStore.tiles
      .filter(t => t.type === 'file' && ((t as FileTileData).sessionId || (t as FileTileData).isSessionLink))
      .map(t => {
        const file = t as FileTileData;
        return {
          id: file.sessionId || file.id,
          tileId: file.id,
          title: file.title,
          sessionTitle: file.sessionTitle || file.title,
          groupId: file.groupId,
          groupTitle: tileStore.groups.find(g => g.id === file.groupId)?.title ?? '默认分组',
          fileType: file.fileType,
        };
      });
  });

  /** Explore 空间中所有归类会话的总数 */
  const allExploreSessionIds = computed(() => {
    const set = new Set<string>();
    exploreSessionFolders.value.forEach(f => f.sessions.forEach(s => set.add(s.id)));
    exploreStandaloneSessions.value.forEach(s => set.add(s.id));
    return Array.from(set);
  });

  const selectedExploreCount = computed(() => {
    return allExploreSessionIds.value.filter(id => selectedScopeSessionIds.value.includes(id)).length;
  });

  /** 经过「搜索后筛选」二次过滤后的最终展示卡片列表 */
  const displayedResults = computed(() => {
    let list = rawResults.value;
    if (selectedPostCategories.value.length > 0) {
      const postSet = new Set(selectedPostCategories.value);
      list = list.filter(item => postSet.has(item.category));
    }
    const pkw = postKeyword.value.trim().toLowerCase();
    if (pkw) {
      list = list.filter(
        item =>
          item.title.toLowerCase().includes(pkw) ||
          item.snippet.toLowerCase().includes(pkw) ||
          item.sessionTitle.toLowerCase().includes(pkw),
      );
    }
    if (postExcludeNoForwards.value) {
      list = list.filter(item => !item.noforwards);
    }
    if (postResolutionFilter.value !== 'all') {
      list = list.filter(item => {
        const h = item.height ?? 0;
        if (postResolutionFilter.value === '4k') return h >= 2160;
        if (postResolutionFilter.value === '1080p') return h >= 1080;
        if (postResolutionFilter.value === '720p') return h >= 720;
        return true;
      });
    }
    if (postDurationFilter.value !== 'all') {
      list = list.filter(item => {
        const d = item.durationSeconds ?? 0;
        if (postDurationFilter.value === 'short') return d > 0 && d < 60;
        if (postDurationFilter.value === 'medium') return d >= 60 && d <= 900;
        if (postDurationFilter.value === 'long') return d > 900;
        return true;
      });
    }
    if (postSizeFilter.value !== 'all') {
      list = list.filter(item => {
        const b = item.sizeBytes ?? 0;
        const mb = b / (1024 * 1024);
        if (postSizeFilter.value === 'small') return mb < 50;
        if (postSizeFilter.value === 'medium') return mb >= 50 && mb <= 500;
        if (postSizeFilter.value === 'large') return mb > 500;
        return true;
      });
    }
    if (postDeduplicateByDocId.value) {
      const seenDocIds = new Set<string>();
      list = list.filter(item => {
        const docId = item.videoInfo?.id ?? item.fileInfo?.id ?? item.photoInfo?.id;
        if (!docId) return true;
        if (seenDocIds.has(docId)) return false;
        seenDocIds.add(docId);
        return true;
      });
    }
    return list;
  });

  const selectedResultSet = computed(() => new Set(selectedResultIds.value));

  const selectedResultItems = computed(() =>
    displayedResults.value.filter(item => selectedResultSet.value.has(item.id)),
  );

  const activeFilterCount = computed(
    () =>
      selectedPreCategories.value.length +
      selectedPostCategories.value.length +
      (postKeyword.value.trim() ? 1 : 0),
  );

  // ── Actions ────────────────────────────────────────────────────────

  function ensureTreeInitialized() {
    if (expandedGroupIds.value.length === 0) {
      expandedGroupIds.value = tileStore.groups.map(g => g.id);
    }
    if (expandedFolderIds.value.length === 0) {
      expandedFolderIds.value = tileStore.tiles
        .filter(t => t.type === 'folder')
        .map(t => t.id);
    }
  }

  function openModal() {
    ensureTreeInitialized();
    isModalOpen.value = true;
    if (!hasSearched.value && rawResults.value.length === 0) {
      void executeStreamingSearch();
    }
  }

  function closeModal() {
    aggregateSearchDataSource.abortActiveStream();
    aggregateSearchDataSource.unbindLazyLoadSentinel();
    aggregateSearchDataSource.clearTreeHoverExpand();
    isStreaming.value = false;
    isLoadingMore.value = false;
    isFilterMenuOpen.value = false;
    cancelDragToTree();
    closeTreeContextMenu();
    cancelTreeInlineRename();
    isModalOpen.value = false;
  }

  function toggleLeftPane() {
    isLeftPaneOpen.value = !isLeftPaneOpen.value;
  }

  function toggleRightPane() {
    isRightPaneOpen.value = !isRightPaneOpen.value;
  }

  // ── 左栏 Tree 交互 ────────────────────────────────────────────────
  function isGroupExpanded(groupId: string): boolean {
    return expandedGroupIds.value.includes(groupId);
  }

  function toggleGroupExpand(groupId: string) {
    if (expandedGroupIds.value.includes(groupId)) {
      expandedGroupIds.value = expandedGroupIds.value.filter(id => id !== groupId);
    } else {
      expandedGroupIds.value.push(groupId);
    }
  }

  function isFolderExpanded(folderId: string): boolean {
    return expandedFolderIds.value.includes(folderId);
  }

  function toggleFolderExpand(folderId: string) {
    if (expandedFolderIds.value.includes(folderId)) {
      expandedFolderIds.value = expandedFolderIds.value.filter(id => id !== folderId);
    } else {
      expandedFolderIds.value.push(folderId);
    }
  }

  function isExploreFolderExpanded(folderId: string): boolean {
    return expandedExploreFolderIds.value.includes(folderId);
  }

  function toggleExploreFolderExpand(folderId: string) {
    if (expandedExploreFolderIds.value.includes(folderId)) {
      expandedExploreFolderIds.value = expandedExploreFolderIds.value.filter(id => id !== folderId);
    } else {
      expandedExploreFolderIds.value.push(folderId);
    }
  }

  function expandAllTreeNodes() {
    expandedGroupIds.value = tileStore.groups.map(g => g.id);
    expandedFolderIds.value = tileStore.tiles.filter(t => t.type === 'folder').map(t => t.id);
  }

  function collapseAllTreeNodes() {
    expandedFolderIds.value = [];
    expandedGroupIds.value = [];
  }

  // ── 中栏筛选菜单交互 ──────────────────────────────────────────────
  function toggleFilterMenu() {
    isFilterMenuOpen.value = !isFilterMenuOpen.value;
  }

  function setFilterStage(stage: SearchFilterStage) {
    activeFilterStage.value = stage;
  }

  /** 步骤 1：点击「按文件类型筛选」标签，把所有可选项罗列出来 */
  function togglePreTypeOptionsList() {
    isPreTypeOptionsListed.value = !isPreTypeOptionsListed.value;
  }

  /** 步骤 2：点击可选项表示选中/取消选中（支持多选） */
  function togglePreCategory(category: SearchPreFilterCategory) {
    if (selectedPreCategories.value.includes(category)) {
      selectedPreCategories.value = selectedPreCategories.value.filter(c => c !== category);
    } else {
      selectedPreCategories.value.push(category);
    }
  }

  function selectAllPreCategories() {
    selectedPreCategories.value = categoryOptions.value.map(o => o.value);
  }

  function clearPreCategories() {
    selectedPreCategories.value = [];
  }

  function togglePostCategory(category: SearchPreFilterCategory) {
    if (selectedPostCategories.value.includes(category)) {
      selectedPostCategories.value = selectedPostCategories.value.filter(c => c !== category);
    } else {
      selectedPostCategories.value.push(category);
    }
  }

  function resetAllFilters() {
    selectedPreCategories.value = [];
    selectedPostCategories.value = [];
    postKeyword.value = '';
    postResolutionFilter.value = 'all';
    postDurationFilter.value = 'all';
    postSizeFilter.value = 'all';
    postExcludeNoForwards.value = false;
  }

  // ── 右栏：按会话控制搜索范围交互 ──────────────────────────────────
  function setScopeTab(kind: SearchScopeSessionKind) {
    activeScopeTab.value = kind;
  }

  function toggleScopeSession(sessionId: string) {
    if (selectedScopeSessionIds.value.includes(sessionId)) {
      selectedScopeSessionIds.value = selectedScopeSessionIds.value.filter(id => id !== sessionId);
    } else {
      selectedScopeSessionIds.value.push(sessionId);
    }
  }

  /** 批量切换 Explore 文件夹下所有会话的勾选态 */
  function toggleExploreFolderSessions(folderSessionIds: string[]) {
    if (folderSessionIds.length === 0) return;
    const allSelected = folderSessionIds.every(id => selectedScopeSessionIds.value.includes(id));
    if (allSelected) {
      selectedScopeSessionIds.value = selectedScopeSessionIds.value.filter(
        id => !folderSessionIds.includes(id),
      );
    } else {
      const newIds = new Set([...selectedScopeSessionIds.value, ...folderSessionIds]);
      selectedScopeSessionIds.value = Array.from(newIds);
    }
  }

  function selectAllExploreSessions() {
    const newIds = new Set([...selectedScopeSessionIds.value, ...allExploreSessionIds.value]);
    selectedScopeSessionIds.value = Array.from(newIds);
  }

  function clearAllExploreSessions() {
    const removeSet = new Set(allExploreSessionIds.value);
    selectedScopeSessionIds.value = selectedScopeSessionIds.value.filter(id => !removeSet.has(id));
  }

  function selectAllCurrentTabSessions() {
    if (activeScopeTab.value === 'explore') {
      selectAllExploreSessions();
      return;
    }
    const currentIds = currentTabScopeSessions.value.map(s => s.id);
    const merged = new Set([...selectedScopeSessionIds.value, ...currentIds]);
    selectedScopeSessionIds.value = Array.from(merged);
  }

  function clearCurrentTabSessions() {
    if (activeScopeTab.value === 'explore') {
      clearAllExploreSessions();
      return;
    }
    const currentIdSet = new Set(currentTabScopeSessions.value.map(s => s.id));
    selectedScopeSessionIds.value = selectedScopeSessionIds.value.filter(
      id => !currentIdSet.has(id),
    );
  }

  function clearAllScopeSessions() {
    selectedScopeSessionIds.value = [];
  }

  // ── 左栏 Explore 树 macOS 风格上下文菜单 ────────────────────────────
  function openTreeContextMenu(options: Omit<TreeContextMenuState, 'isOpen'>) {
    treeContextMenu.value = {
      ...options,
      isOpen: true,
    };
  }

  function closeTreeContextMenu() {
    treeContextMenu.value.isOpen = false;
  }

  function execTreeNewFolder(targetGroupId?: string) {
    closeTreeContextMenu();
    const gId = targetGroupId || tileStore.groups[0]?.id || 'group-common';
    const folder = tileStore.addNewFolder('新建文件夹', gId);
    if (!expandedGroupIds.value.includes(gId)) {
      expandedGroupIds.value.push(gId);
    }
    if (!expandedFolderIds.value.includes(folder.id)) {
      expandedFolderIds.value.push(folder.id);
    }
    startTreeInlineRename({
      targetType: 'folder',
      id: folder.id,
      title: folder.title,
    });
    return folder;
  }

  function execTreeNewSubFolder(parentFolderId?: string) {
    closeTreeContextMenu();
    if (!parentFolderId) return null;
    const sub = tileStore.addSubFolder(parentFolderId, '新建子文件夹');
    if (sub) {
      if (!expandedFolderIds.value.includes(parentFolderId)) {
        expandedFolderIds.value.push(parentFolderId);
      }
      if (!expandedFolderIds.value.includes(sub.id)) {
        expandedFolderIds.value.push(sub.id);
      }
      startTreeInlineRename({
        targetType: 'folder',
        id: sub.id,
        title: sub.title,
      });
    }
    return sub;
  }

  function startTreeInlineRename(options: {
    targetType: 'group' | 'folder' | 'file' | 'subfile';
    id: string;
    parentId?: string;
    title: string;
  }) {
    closeTreeContextMenu();
    editingTreeNode.value = {
      isEditing: true,
      targetType: options.targetType,
      id: options.id,
      parentId: options.parentId,
      title: options.title,
    };
  }

  function updateEditingTreeTitle(val: string) {
    editingTreeNode.value.title = val;
  }

  function commitTreeInlineRename() {
    if (!editingTreeNode.value.isEditing) return;
    const { targetType, id, parentId, title } = editingTreeNode.value;
    const trimmed = title.trim();

    if (trimmed && id) {
      if (targetType === 'group') {
        tileStore.renameGroup(id, trimmed);
      } else if (targetType === 'folder') {
        tileStore.renameTile(id, trimmed);
      } else if (targetType === 'subfile' && parentId) {
        tileStore.renameChildFile(parentId, id, trimmed);
      } else if (targetType === 'file') {
        tileStore.renameTile(id, trimmed);
      }
    }

    cancelTreeInlineRename();
  }

  function cancelTreeInlineRename() {
    editingTreeNode.value = {
      isEditing: false,
      targetType: null,
      id: null,
      parentId: undefined,
      title: '',
    };
  }

  function execTreeRename() {
    const ctx = treeContextMenu.value;
    closeTreeContextMenu();
    if (ctx.isUndeletable) return;

    if (ctx.targetType === 'group' && ctx.groupId) {
      startTreeInlineRename({
        targetType: 'group',
        id: ctx.groupId,
        title: ctx.title,
      });
    } else if (ctx.targetType === 'folder' && ctx.folderId) {
      startTreeInlineRename({
        targetType: 'folder',
        id: ctx.folderId,
        title: ctx.title,
      });
    } else if (ctx.targetType === 'subfile' && ctx.folderId && ctx.fileId) {
      startTreeInlineRename({
        targetType: 'subfile',
        id: ctx.fileId,
        parentId: ctx.folderId,
        title: ctx.title,
      });
    } else if (ctx.targetType === 'file' && ctx.fileId) {
      startTreeInlineRename({
        targetType: 'file',
        id: ctx.fileId,
        title: ctx.title,
      });
    }
  }

  function execTreeDelete() {
    const ctx = treeContextMenu.value;
    closeTreeContextMenu();
    if (ctx.isUndeletable) return;

    if (!window.confirm(`确定要删除「${ctx.title}」吗？`)) return;

    if (ctx.targetType === 'group' && ctx.groupId) {
      tileStore.deleteGroup(ctx.groupId);
    } else if (ctx.targetType === 'folder' && ctx.folderId) {
      tileStore.deleteTile(ctx.folderId);
    } else if (ctx.targetType === 'subfile' && ctx.folderId && ctx.fileId) {
      tileStore.deleteChildFile(ctx.folderId, ctx.fileId);
    } else if (ctx.targetType === 'file' && ctx.fileId) {
      tileStore.deleteTile(ctx.fileId);
    }
  }

  // ── 流式搜索与触底懒加载执行引擎 ──────────────────────────────────
  function logSearch(
    action: string,
    level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR',
    tags: Record<string, string | number | boolean | undefined>,
    message?: string,
    durMs?: number,
  ) {
    debugLoggerDataSource.emitFrontendLog({
      domain: 'archive.search',
      action,
      level,
      message,
      durMs,
      tags,
    });
  }

  /** 只有真正带可下载媒体/头像的结果才自动升级高清封面，纯文本消息直接跳过。 */
  function canAutoLoadCover(item: AggregateSearchResultItem): boolean {
    if (item.hdThumbLoaded || item.hdThumbAttempted) return false;
    if (loadingHighResIds.value[item.id]) return false;
    if (item.category === 'session') return true;
    return Boolean(item.photoInfo || item.videoInfo || item.fileInfo?.preview);
  }

  /** 新卡片落位后自动补全高清封面（经 coverImageBus 的 search 通道限流）。 */
  function autoLoadCoversForChunk(items: AggregateSearchResultItem[]) {
    let queued = 0;
    for (const item of items) {
      if (!canAutoLoadCover(item)) continue;
      queued += 1;
      void loadHighResThumbnailForItem(item);
    }
    if (queued > 0) {
      logSearch(
        'store_auto_cover_queued',
        'DEBUG',
        { queued, chunkSize: items.length },
        '自动为新结果卡片补全高清缩略图',
      );
    }
  }

  /** 把新分片并入 rawResults，并用数组里的响应式代理触发自动补图。 */
  function appendChunkItems(
    chunkItems: AggregateSearchResultItem[],
    chunkTotalMatched: number,
    chunkHasMore: boolean,
  ) {
    const existing = new Set(rawResults.value.map((item) => item.id));
    const fresh = chunkItems.filter((item) => !existing.has(item.id));
    rawResults.value.push(...fresh);
    totalMatched.value = chunkTotalMatched;
    hasMore.value = chunkHasMore;
    if (fresh.length > 0) {
      const proxies = rawResults.value.slice(rawResults.value.length - fresh.length);
      autoLoadCoversForChunk(proxies);
    }
  }

  async function executeStreamingSearch() {
    const epoch = ++searchEpoch.value;
    const signal = aggregateSearchDataSource.createStreamSignal();
    const startedAt = Date.now();
    const queryMeta = {
      keywordLength: keyword.value.trim().length,
      categories: selectedPreCategories.value.join(',') || 'all',
      scopeCount: selectedScopeSessionIds.value.length,
      pageSize: PAGE_SIZE,
    };
    logSearch('store_search_start', 'INFO', queryMeta, '开始新的聚合搜索');

    hasSearched.value = true;
    isStreaming.value = true;
    isLoadingMore.value = false;
    currentPage.value = 1;
    rawResults.value = [];
    totalMatched.value = 0;
    hasMore.value = false;
    selectedResultIds.value = [];
    lastClickedIndex.value = null;
    loadingHighResIds.value = {};
    highResLoadedIds.value = {};
    brokenThumbIds.value = {};

    const query = {
      keyword: keyword.value,
      preCategories: [...selectedPreCategories.value],
      scopeSessionIds: [...selectedScopeSessionIds.value],
      page: 1,
      pageSize: PAGE_SIZE,
    };

    try {
      for await (const chunk of aggregateSearchDataSource.streamSearchPage(query, signal)) {
        if (epoch !== searchEpoch.value || signal.aborted) return;
        appendChunkItems(chunk.items, chunk.totalMatched, chunk.hasMore);
      }
      logSearch(
        'store_search_done',
        'INFO',
        {
          ...queryMeta,
          loaded: rawResults.value.length,
          totalMatched: totalMatched.value,
          hasMore: hasMore.value,
        },
        '搜索流式推送完成',
        Date.now() - startedAt,
      );
    } catch (error) {
      const info = classifyTelegramError(error);
      if (epoch === searchEpoch.value) {
        hasMore.value = false;
        logSearch(
          'store_search_error',
          'ERROR',
          {
            ...queryMeta,
            bucket: info.bucket,
            code: info.code,
            retryable: info.retryable,
            loaded: rawResults.value.length,
          },
          info.description,
          Date.now() - startedAt,
        );
      }
    } finally {
      if (epoch === searchEpoch.value) {
        isStreaming.value = false;
      }
    }
  }

  async function loadNextPageLazy() {
    if (isStreaming.value || isLoadingMore.value || !hasMore.value) {
      logSearch(
        'store_load_more_skipped',
        'DEBUG',
        {
          reason: isStreaming.value
            ? 'still_streaming'
            : isLoadingMore.value
              ? 'already_loading'
              : 'no_more',
          currentPage: currentPage.value,
          totalMatched: totalMatched.value,
        },
        '本次触底懒加载被跳过',
      );
      return;
    }

    const epoch = searchEpoch.value;
    const nextPage = currentPage.value + 1;
    const signal = aggregateSearchDataSource.createStreamSignal();
    const startedAt = Date.now();
    const queryMeta = {
      nextPage,
      keywordLength: keyword.value.trim().length,
      categories: selectedPreCategories.value.join(',') || 'all',
      scopeCount: selectedScopeSessionIds.value.length,
    };
    logSearch('store_load_more_start', 'INFO', queryMeta, '触底加载下一页');

    isLoadingMore.value = true;

    const query = {
      keyword: keyword.value,
      preCategories: [...selectedPreCategories.value],
      scopeSessionIds: [...selectedScopeSessionIds.value],
      page: nextPage,
      pageSize: PAGE_SIZE,
    };

    try {
      for await (const chunk of aggregateSearchDataSource.streamSearchPage(query, signal)) {
        if (epoch !== searchEpoch.value || signal.aborted) return;
        appendChunkItems(chunk.items, chunk.totalMatched, chunk.hasMore);
      }
      // 只有成功完成一页才推进页码，失败时保持在原页以便重试
      currentPage.value = nextPage;
      logSearch(
        'store_load_more_done',
        'INFO',
        {
          ...queryMeta,
          loaded: rawResults.value.length,
          totalMatched: totalMatched.value,
          hasMore: hasMore.value,
        },
        '下一页加载完成',
        Date.now() - startedAt,
      );
    } catch (error) {
      const info = classifyTelegramError(error);
      if (epoch === searchEpoch.value) {
        logSearch(
          'store_load_more_error',
          'ERROR',
          {
            ...queryMeta,
            bucket: info.bucket,
            code: info.code,
            retryable: info.retryable,
            loaded: rawResults.value.length,
          },
          info.description,
          Date.now() - startedAt,
        );
      }
    } finally {
      if (epoch === searchEpoch.value) {
        isLoadingMore.value = false;
      }
    }
  }

  /** 浏览器无法解码缩略图（坏 Data URL / MIME 不匹配）时记录并隐藏图片。 */
  function markThumbBroken(item: AggregateSearchResultItem, srcPrefix: string) {
    if (brokenThumbIds.value[item.id]) return;
    brokenThumbIds.value[item.id] = true;
    logSearch(
      'store_thumb_decode_error',
      'WARN',
      {
        itemId: item.id,
        category: item.category,
        srcPrefix: srcPrefix.slice(0, 24),
        srcLength: srcPrefix.length,
        bucket: 'BROKEN_IMAGE',
      },
      '浏览器无法解码该缩略图，已回退到占位图',
    );
  }

  // ── 卡片点击选择与按住 Shift 连续区间多选 ─────────────────────────
  function handleResultCardClick(index: number, item: AggregateSearchResultItem, event: MouseEvent) {
    const list = displayedResults.value;
    if (event.shiftKey && lastClickedIndex.value !== null && list.length > 0) {
      const start = Math.max(0, Math.min(lastClickedIndex.value, index));
      const end = Math.min(list.length - 1, Math.max(lastClickedIndex.value, index));
      const rangeIds = list.slice(start, end + 1).map(r => r.id);
      const merged = new Set([...selectedResultIds.value, ...rangeIds]);
      selectedResultIds.value = Array.from(merged);
      return;
    }

    if (selectedResultIds.value.includes(item.id)) {
      selectedResultIds.value = selectedResultIds.value.filter(id => id !== item.id);
    } else {
      selectedResultIds.value.push(item.id);
    }
    lastClickedIndex.value = index;
  }

  function selectAllDisplayedResults() {
    selectedResultIds.value = displayedResults.value.map(r => r.id);
  }

  function clearResultSelection() {
    selectedResultIds.value = [];
    lastClickedIndex.value = null;
  }

  /**
   * 单独点击搜索结果卡片左端缩略图时，按需从 Telegram 拉取较高清晰度的预览缩略图并同步更新已落位磁贴
   */
  async function loadHighResThumbnailForItem(item: AggregateSearchResultItem) {
    if (!item || loadingHighResIds.value[item.id]) return;
    item.hdThumbAttempted = true;
    loadingHighResIds.value[item.id] = true;
    try {
      const hdDataUrl = await aggregateSearchDataSource.fetchHighResThumbnailDataUrl(item);
      if (hdDataUrl) {
        item.thumbnailUrl = hdDataUrl;
        item.hdThumbLoaded = true;
        item.hdThumbError = undefined;
        delete brokenThumbIds.value[item.id];
        highResLoadedIds.value[item.id] = true;
        tileStore.applyUpdatedSearchResultThumb(item.id, hdDataUrl);
        logSearch(
          'store_hd_applied',
          'INFO',
          { itemId: item.id, category: item.category, dataUrlLength: hdDataUrl.length },
          '搜索结果卡片已升级为高清缩略图',
        );
      } else {
        logSearch(
          'store_hd_unavailable',
          'WARN',
          {
            itemId: item.id,
            category: item.category,
            bucket: item.hdThumbError || 'NO_MEDIA',
          },
          '该结果没有可用的高清缩略图',
        );
      }
    } catch (error) {
      const info = classifyTelegramError(error);
      item.hdThumbError = info.code;
      logSearch(
        'store_hd_error',
        'ERROR',
        {
          itemId: item.id,
          category: item.category,
          bucket: info.bucket,
          code: info.code,
          retryable: info.retryable,
        },
        info.description,
      );
    } finally {
      delete loadingHighResIds.value[item.id];
    }
  }

  // ── 跨栏拖拽：从搜索结果向左拖拽到文件树（磁贴拓扑） ─────────────
  function startDragResultsToTree(
    originItem: AggregateSearchResultItem,
    clientX: number,
    clientY: number,
  ) {
    // 若起拖卡片尚未选中，则自动选中该卡片；若已选中，则携带全部已选中卡片一起拖拽
    if (!selectedResultIds.value.includes(originItem.id)) {
      selectedResultIds.value = [originItem.id];
    }
    const itemsToDrag = displayedResults.value.filter(r =>
      selectedResultIds.value.includes(r.id),
    );
    if (itemsToDrag.length === 0) {
      itemsToDrag.push(originItem);
    }

    // 若左栏处于收起状态，开始拖拽时自动展开左栏，方便落入文件树
    if (!isLeftPaneOpen.value) {
      isLeftPaneOpen.value = true;
    }

    dragToTree.value = {
      isDragging: true,
      items: itemsToDrag,
      pointerX: clientX,
      pointerY: clientY,
      hoverTargetType: null,
      hoverTargetId: null,
      hoverTargetTitle: null,
    };
  }

  function updateDragToTreePointer(clientX: number, clientY: number) {
    if (!dragToTree.value.isDragging) return;
    dragToTree.value.pointerX = clientX;
    dragToTree.value.pointerY = clientY;

    // 探测指针下方的左栏 Tree 节点 ([data-tree-drop-type] + [data-tree-drop-id])
    const hitEl = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
    const dropNode = hitEl?.closest('[data-tree-drop-type]') as HTMLElement | null;

    if (!dropNode) {
      aggregateSearchDataSource.clearTreeHoverExpand();
      dragToTree.value.hoverTargetType = null;
      dragToTree.value.hoverTargetId = null;
      dragToTree.value.hoverTargetTitle = null;
      return;
    }

    const dropType = dropNode.getAttribute('data-tree-drop-type') as 'group' | 'folder' | null;
    const dropId = dropNode.getAttribute('data-tree-drop-id');
    const dropTitle = dropNode.getAttribute('data-tree-drop-title');

    if (dropType && dropId) {
      if (dragToTree.value.hoverTargetId !== dropId) {
        dragToTree.value.hoverTargetType = dropType;
        dragToTree.value.hoverTargetId = dropId;
        dragToTree.value.hoverTargetTitle = dropTitle;

        // 悬停在收起的分组或文件夹上满 420ms 自动展开该分支
        aggregateSearchDataSource.scheduleTreeHoverExpand(() => {
          if (dropType === 'group' && !expandedGroupIds.value.includes(dropId)) {
            expandedGroupIds.value.push(dropId);
          } else if (dropType === 'folder' && !expandedFolderIds.value.includes(dropId)) {
            expandedFolderIds.value.push(dropId);
          }
        }, 420);
      }
    }
  }

  function startInternalTreeNodeDrag(tileId: string, title: string, clientX: number, clientY: number) {
    const tile = tileStore.getTileById(tileId);
    if (!tile || tile.undeletable || tile.systemApp) return;
    internalTreeDragTileId.value = tileId;
    dragToTree.value = {
      isDragging: true,
      items: [
        {
          id: tileId,
          title,
          snippet: '',
          category: 'other',
          categoryLabel: tile.type === 'folder' ? '文件夹' : '文件',
          fileType: tile.type === 'file' ? tile.fileType : 'generic',
          extension: tile.type === 'file' ? tile.extension || '' : 'DIR',
          fileSize: '',
          sessionId: '',
          sessionTitle: '',
          sessionKind: 'joined',
          updatedAt: tile.updatedAt,
          badgeMeta: tile.type === 'folder' ? 'DIR' : 'FILE',
          thumbnailUrl: '',
        },
      ],
      pointerX: clientX,
      pointerY: clientY,
      hoverTargetType: null,
      hoverTargetId: null,
      hoverTargetTitle: null,
    };
  }

  function finishDragToTree() {
    aggregateSearchDataSource.clearTreeHoverExpand();
    if (!dragToTree.value.isDragging) return;

    const { items, hoverTargetType, hoverTargetId, hoverTargetTitle } = dragToTree.value;
    const movingTileId = internalTreeDragTileId.value;

    if (movingTileId && hoverTargetType && hoverTargetId && hoverTargetId !== movingTileId) {
      if (hoverTargetType === 'folder') {
        tileStore.addFileToFolder(hoverTargetId, movingTileId);
        if (!expandedFolderIds.value.includes(hoverTargetId)) {
          expandedFolderIds.value.push(hoverTargetId);
        }
      } else if (hoverTargetType === 'group') {
        tileStore.batchMoveTilesToGroup(hoverTargetId, undefined, undefined, [movingTileId]);
        if (!expandedGroupIds.value.includes(hoverTargetId)) {
          expandedGroupIds.value.push(hoverTargetId);
        }
      }
      recentlyImportedTargetId.value = hoverTargetId;
      lastImportBannerText.value = `已移入「${hoverTargetTitle || '目标目录'}」`;
      window.setTimeout(() => {
        if (recentlyImportedTargetId.value === hoverTargetId) {
          recentlyImportedTargetId.value = null;
        }
      }, 1600);
      cancelDragToTree();
      return;
    }

    if (hoverTargetType && hoverTargetId && items.length > 0) {
      const importedCount = tileStore.importSearchResultsToTopology(
        items,
        hoverTargetType,
        hoverTargetId,
      );

      // 自动展开目标节点，让用户立即在文件树中看到新加入的磁贴
      if (hoverTargetType === 'group' && !expandedGroupIds.value.includes(hoverTargetId)) {
        expandedGroupIds.value.push(hoverTargetId);
      } else if (hoverTargetType === 'folder') {
        if (!expandedFolderIds.value.includes(hoverTargetId)) {
          expandedFolderIds.value.push(hoverTargetId);
        }
        const folderTile = tileStore.getTileById(hoverTargetId);
        if (folderTile && !expandedGroupIds.value.includes(folderTile.groupId)) {
          expandedGroupIds.value.push(folderTile.groupId);
        }
      }

      recentlyImportedTargetId.value = hoverTargetId;
      lastImportBannerText.value =
        importedCount > 0
          ? `已将 ${importedCount} 项归入「${hoverTargetTitle || '目标目录'}」`
          : `所选项目已在「${hoverTargetTitle || '目标目录'}」中`;

      window.setTimeout(() => {
        if (recentlyImportedTargetId.value === hoverTargetId) {
          recentlyImportedTargetId.value = null;
        }
      }, 1600);
    }

    cancelDragToTree();
  }

  function cancelDragToTree() {
    aggregateSearchDataSource.clearTreeHoverExpand();
    internalTreeDragTileId.value = null;
    dragToTree.value = {
      isDragging: false,
      items: [],
      pointerX: 0,
      pointerY: 0,
      hoverTargetType: null,
      hoverTargetId: null,
      hoverTargetTitle: null,
    };
  }

  return {
    // 弹窗与分栏开关
    isModalOpen,
    isLeftPaneOpen,
    isRightPaneOpen,
    openModal,
    closeModal,
    toggleLeftPane,
    toggleRightPane,

    // 左栏文件树与 macOS 上下文菜单
    expandedGroupIds,
    expandedFolderIds,
    recentlyImportedTargetId,
    lastImportBannerText,
    isGroupExpanded,
    toggleGroupExpand,
    isFolderExpanded,
    toggleFolderExpand,
    expandedExploreFolderIds,
    isExploreFolderExpanded,
    toggleExploreFolderExpand,
    expandAllTreeNodes,
    collapseAllTreeNodes,
    treeContextMenu,
    openTreeContextMenu,
    closeTreeContextMenu,
    execTreeNewFolder,
    execTreeNewSubFolder,
    execTreeRename,
    execTreeDelete,
    editingTreeNode,
    startTreeInlineRename,
    updateEditingTreeTitle,
    commitTreeInlineRename,
    cancelTreeInlineRename,

    // 中栏搜索与筛选菜单
    keyword,
    isFilterMenuOpen,
    activeFilterStage,
    isPreTypeOptionsListed,
    selectedPreCategories,
    selectedPostCategories,
    postKeyword,
    postResolutionFilter,
    postDurationFilter,
    postSizeFilter,
    postExcludeNoForwards,
    postDeduplicateByDocId,
    categoryOptions,
    activeFilterCount,
    toggleFilterMenu,
    setFilterStage,
    togglePreTypeOptionsList,
    togglePreCategory,
    selectAllPreCategories,
    clearPreCategories,
    togglePostCategory,
    resetAllFilters,

    // 右栏会话范围控制与 Explore 专有会话视角
    activeScopeTab,
    selectedScopeSessionIds,
    allScopeSessions,
    joinedScopeSessions,
    credentialOnlyScopeSessions,
    currentTabScopeSessions,
    selectedJoinedCount,
    selectedCredentialCount,
    exploreSessionFolders,
    exploreStandaloneSessions,
    allExploreSessionIds,
    selectedExploreCount,
    toggleExploreFolderSessions,
    selectAllExploreSessions,
    clearAllExploreSessions,
    setScopeTab,
    toggleScopeSession,
    selectAllCurrentTabSessions,
    clearCurrentTabSessions,
    clearAllScopeSessions,

    // 流式搜索与懒加载
    rawResults,
    displayedResults,
    isStreaming,
    isLoadingMore,
    hasSearched,
    currentPage,
    totalMatched,
    hasMore,
    executeStreamingSearch,
    loadNextPageLazy,

    // 多选与 Shift 区间选择
    selectedResultIds,
    selectedResultSet,
    selectedResultItems,
    lastClickedIndex,
    loadingHighResIds,
    highResLoadedIds,
    brokenThumbIds,
    handleResultCardClick,
    selectAllDisplayedResults,
    clearResultSelection,
    loadHighResThumbnailForItem,
    markThumbBroken,

    // 跨栏拖拽归档与树内节点拖拽
    internalTreeDragTileId,
    dragToTree,
    startInternalTreeNodeDrag,
    startDragResultsToTree,
    updateDragToTreePointer,
    finishDragToTree,
    cancelDragToTree,
  };
});
