/**
 * ============================================================================
 * 聚合搜索系统状态存储器 (Aggregate Search Store)
 * ============================================================================
 * 严格遵循 `.rules/state-management.md` 视图层零本地 `ref` 铁律：
 * 弹窗开关、左右两栏折叠态、左栏 Tree 展开状态、中栏搜索词、筛选菜单展开与「搜索前/搜索后」多选态、
 * 右栏两类会话范围（已加入会话 / 只有凭据会话）控制、逐会话流式结果与虚拟视口、
 * 卡片高亮多选与 Shift 连续多选、跨栏拖拽归档状态全部收敛于此 Store。
 */
import { defineStore } from 'pinia';
import { computed, nextTick, ref, watch, type ComponentPublicInstance } from 'vue';
import { SEARCH_CATEGORY_OPTIONS } from './searchCategories';
import { streamFocusedSearch } from './focusedSearch';
import { parseSearchSize, scopeRowHeight, searchWindow, SEARCH_ROW_HEIGHT, SearchResultProjection, variableWindow } from '@/worker/local/archive/searchModel';
import { searchResultGestureDataSource } from '../data-sources/searchResultGestureDataSource';
import { searchViewportDataSource, searchScopeViewportDataSource } from '../data-sources/searchViewportDataSource';
import { useChatStore } from '@/stores/chat/stores/chatStore';
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
  SearchPeerProgress,
  SearchToTreeDragState,
  TreeContextMenuState,
  TreeEditingNodeState,
} from '../types';

const PAGE_SIZE = 50;

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
  /** 搜索前多选文件类型 */
  const selectedPreCategories = ref<SearchPreFilterCategory[]>([]);
  const preExtensions = ref('');
  const forceFullScan = ref(false);
  /** 搜索后筛选：对已流式返回的结果集进行客户端二次筛选 */
  const selectedPostCategories = ref<SearchPreFilterCategory[]>([]);
  const postKeyword = ref('');
  const postResolutionFilter = ref<'all' | '720p' | '1080p' | '4k'>('all');
  const postDurationFilter = ref<'all' | 'short' | 'medium' | 'long'>('all');
  /**
   * 精确资源大小（MB）。Telegram Search 没有体积参数，因此只能在结果返回后本地过滤；
   * 该条件只作用于视频与图片，其他类型不受影响。
   */
  const postMinSizeMb = ref<string | number>('');
  const postMaxSizeMb = ref<string | number>('');
  const postExcludeNoForwards = ref(false);
  const postDeduplicateByDocId = ref(true);

  // ── 4. 右栏：搜索范围控制（按会话维度：已加入会话 / 只有凭据会话） ──
  const activeScopeTab = ref<SearchScopeSessionKind>('joined');
  const selectedScopeSessionIds = ref<string[]>([]);

  // ── 5. 流式搜索与虚拟视口状态 ────────────────────────────────────
  const rawResults = ref<AggregateSearchResultItem[]>([]);
  const isStreaming = ref(false);
  const hasSearched = ref(false);
  const totalMatched = ref(0);
  const peerProgress = ref<Record<string, SearchPeerProgress>>({});
  const searchEpoch = ref(0);
  const searchError = ref('');
  const searchStatus = ref<'idle' | 'streaming' | 'stopped' | 'completed' | 'partial' | 'error'>('idle');
  const viewportTop = ref(0);
  const viewportHeight = ref(600);
  const resultIds = new Set<string>();
  const coverControllers = new Map<string, AbortController>();
  let queuedItems: AggregateSearchResultItem[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | undefined;


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
  const categoryOptions = computed(() => SEARCH_CATEGORY_OPTIONS);
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

  const scopeViewportTop = ref(0);
  const scopeViewportHeight = ref(600);
  // 会话行高不统一（凭据且带过期时间的卡片更高），因此用前缀偏移做变高窗口。
  const scopeOffsets = computed(() => {
    const offsets = [0];
    for (const session of currentTabScopeSessions.value) offsets.push(offsets[offsets.length - 1] + scopeRowHeight(session));
    return offsets;
  });
  const scopeWindow = computed(() => variableWindow(scopeOffsets.value, scopeViewportTop.value, scopeViewportHeight.value));
  const virtualScopeSessions = computed(() => currentTabScopeSessions.value.slice(scopeWindow.value.start, scopeWindow.value.end));
  const scopePaddingTop = computed(() => scopeWindow.value.paddingTop);
  const scopePaddingBottom = computed(() => scopeWindow.value.paddingBottom);
  const scopeRowHeightOf = scopeRowHeight;
  const isPreTypeOptionsListed = ref(false);
  function togglePreTypeOptionsList() {
    isPreTypeOptionsListed.value = !isPreTypeOptionsListed.value;
  }
  const resultRowHeight = SEARCH_ROW_HEIGHT;
  const selectedScopeSet = computed(() => new Set(selectedScopeSessionIds.value));
  function bindScopeViewport(target: Element | ComponentPublicInstance | null) {
    searchScopeViewportDataSource.bind(target instanceof HTMLElement ? target : null, (top, height) => {
      scopeViewportTop.value = top; scopeViewportHeight.value = height;
    });
  }
  watch(activeScopeTab, () => { scopeViewportTop.value = 0; searchScopeViewportDataSource.reset(); });

  // 右栏真实会话头像：只给当前虚拟窗口 + overscan 内的会话加载，滚出窗口即取消并释放封面槽位。
  const scopeAvatarUrls = ref<Record<string, string>>({});
  const scopeAvatarControllers = new Map<string, AbortController>();
  function abortScopeAvatars() {
    for (const controller of scopeAvatarControllers.values()) controller.abort();
    scopeAvatarControllers.clear();
  }
  watch(() => [virtualScopeSessions.value, isModalOpen.value] as const, ([items, open]) => {
    const visible = new Set(items.map(item => item.id));
    for (const [id, controller] of scopeAvatarControllers) {
      if (!visible.has(id)) { controller.abort(); scopeAvatarControllers.delete(id); }
    }
    if (!open) return;
    for (const session of items) {
      if (!session.avatar || scopeAvatarUrls.value[session.id] || scopeAvatarControllers.has(session.id)) continue;
      const controller = new AbortController();
      scopeAvatarControllers.set(session.id, controller);
      void aggregateSearchDataSource.fetchScopeAvatarDataUrl(session, controller.signal)
        .then(url => {
          if (controller.signal.aborted || !url) return;
          scopeAvatarUrls.value = { ...scopeAvatarUrls.value, [session.id]: url };
        })
        .catch(() => undefined)
        .finally(() => {
          if (scopeAvatarControllers.get(session.id) === controller) scopeAvatarControllers.delete(session.id);
        });
    }
  }, { flush: 'post' });

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

  const resultProjection = new SearchResultProjection();
  /** 体积条件解析失败时不阻断渲染，错误文案在筛选菜单里提示。 */
  const postSizeBounds = computed(() => {
    try {
      const minSizeBytes = parseSearchSize(postMinSizeMb.value);
      const maxSizeBytes = parseSearchSize(postMaxSizeMb.value);
      if (minSizeBytes !== undefined && maxSizeBytes !== undefined && minSizeBytes > maxSizeBytes) {
        return { minSizeBytes: undefined, maxSizeBytes: undefined, error: '最小体积不能大于最大体积' };
      }
      return { minSizeBytes, maxSizeBytes, error: '' };
    } catch (error) {
      return { minSizeBytes: undefined, maxSizeBytes: undefined, error: error instanceof Error ? error.message : '请检查文件大小条件' };
    }
  });
  const displayedResults = computed(() => resultProjection.update(rawResults.value, {
    categories: [...selectedPostCategories.value],
    keyword: postKeyword.value,
    resolution: postResolutionFilter.value,
    duration: postDurationFilter.value,
    minSizeBytes: postSizeBounds.value.minSizeBytes,
    maxSizeBytes: postSizeBounds.value.maxSizeBytes,
    excludeProtected: postExcludeNoForwards.value,
    deduplicate: postDeduplicateByDocId.value,
  }));

  const resultWindow = computed(() => searchWindow(displayedResults.value.length, viewportTop.value, viewportHeight.value));
  const virtualResults = computed(() => displayedResults.value.slice(resultWindow.value.start, resultWindow.value.end));
  const virtualPaddingTop = computed(() => resultWindow.value.start * SEARCH_ROW_HEIGHT);
  const virtualPaddingBottom = computed(() => Math.max(0, displayedResults.value.length - resultWindow.value.end) * SEARCH_ROW_HEIGHT);
  const peerSummary = computed(() => Object.values(peerProgress.value).reduce((summary, peer) => {
    summary.total++;
    summary.checked += peer.checked;
    summary.matched += peer.matched;
    if (peer.status === 'completed') summary.completed++;
    if (peer.status === 'error') summary.failed++;
    return summary;
  }, { total: 0, completed: 0, failed: 0, checked: 0, matched: 0 }));
  const failedPeers = computed(() => Object.values(peerProgress.value).filter(peer => peer.status === 'error'));
  function bindResultsViewport(target: Element | ComponentPublicInstance | null) {
    searchViewportDataSource.bind(target instanceof HTMLElement ? target : null, (top, height) => {
      viewportTop.value = top;
      viewportHeight.value = height;
    });
  }
  function abortCovers() {
    for (const controller of coverControllers.values()) controller.abort();
    coverControllers.clear();
    loadingHighResIds.value = {};
  }
  watch(() => [virtualResults.value, isModalOpen.value] as const, ([items]) => {
    const visibleIds = new Set(items.map(item => item.id));
    for (const [id, controller] of coverControllers) if (!visibleIds.has(id)) controller.abort();
    if (isModalOpen.value && searchStatus.value !== 'stopped') {
      for (const item of items) if (canAutoLoadCover(item)) void loadHighResThumbnailForItem(item);
    }
  }, { flush: 'post' });
  watch(() => useChatStore().accountId, () => {
    stopSearch();
    abortScopeAvatars();
    scopeAvatarUrls.value = {};
    rawResults.value = [];
    resultIds.clear();
    selectedResultIds.value = [];
    peerProgress.value = {};
    totalMatched.value = 0;
    hasSearched.value = false;
    searchStatus.value = 'idle';
    searchError.value = '';
  });

  const selectedResultSet = computed(() => new Set(selectedResultIds.value));

  const selectedResultItems = computed(() =>
    displayedResults.value.filter(item => selectedResultSet.value.has(item.id)),
  );

  const activeFilterCount = computed(
    () =>
      selectedPreCategories.value.length +
      selectedPostCategories.value.length +
      (postKeyword.value.trim() ? 1 : 0) +
      (postResolutionFilter.value !== 'all' ? 1 : 0) +
      (postDurationFilter.value !== 'all' ? 1 : 0) +
      (postSizeBounds.value.minSizeBytes !== undefined || postSizeBounds.value.maxSizeBytes !== undefined ? 1 : 0) +
      (postExcludeNoForwards.value ? 1 : 0) +
      (preExtensions.value.trim() ? 1 : 0) +
      (forceFullScan.value ? 1 : 0),
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
    // 打开窗口不发起任何检索：关键词、范围与筛选都由用户显式提交后才生效。
  }

  function closeModal() {
    stopSearch();
    abortScopeAvatars();
    searchResultGestureDataSource.cancel();
    aggregateSearchDataSource.clearTreeHoverExpand();
    isStreaming.value = false;
    isFilterMenuOpen.value = false;
    cancelDragToTree();
    closeTreeContextMenu();
    cancelTreeInlineRename();
    isModalOpen.value = false;
  }

  function stopSearch() {
    flushSearchItems();
    abortCovers();
    if (searchStatus.value === 'streaming') searchStatus.value = 'stopped';
    searchEpoch.value += 1;
    aggregateSearchDataSource.abortActiveStream();
    isStreaming.value = false;
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

  /** 搜索前多选类型 */
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
    preExtensions.value = '';
    forceFullScan.value = false;
  }

  function togglePostCategory(category: SearchPreFilterCategory) {
    if (selectedPostCategories.value.includes(category)) {
      selectedPostCategories.value = selectedPostCategories.value.filter(c => c !== category);
    } else {
      selectedPostCategories.value.push(category);
    }
  }

  function resetAllFilters() {
    clearPreCategories();
    searchError.value = '';
    selectedPostCategories.value = [];
    postKeyword.value = '';
    postResolutionFilter.value = 'all';
    postDurationFilter.value = 'all';
    postMinSizeMb.value = '';
    postMaxSizeMb.value = '';
    postExcludeNoForwards.value = false;
    postDeduplicateByDocId.value = true;
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

  // ── 流式搜索与批量提交执行引擎 ──────────────────────────────────
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

  /** One persistent ID index; empty progress chunks never scan the result array. */
  function flushSearchItems() {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = undefined;
    if (queuedItems.length) {
      rawResults.value.push(...queuedItems);
      queuedItems = [];
    }
  }
  function appendChunkItems(items: AggregateSearchResultItem[], total: number) {
    for (const item of items) {
      if (resultIds.has(item.id)) continue;
      resultIds.add(item.id);
      queuedItems.push(item);
    }
    totalMatched.value = total;
    if (queuedItems.length && !flushTimer) flushTimer = setTimeout(flushSearchItems, 32);
  }

  async function executeStreamingSearch() {
    searchError.value = '';
    // 空关键词不发起任何检索：服务端按会话搜索时必须有关键词，否则会退化成全量拉取。
    if (!keyword.value.trim()) {
      searchError.value = '请输入关键词后再搜索';
      void nextTick(() => searchViewportDataSource.focusKeywordInput());
      return;
    }
    stopSearch();
    const epoch = ++searchEpoch.value;
    const signal = aggregateSearchDataSource.createStreamSignal();
    const startedAt = Date.now();
    const queryMeta = {
      keywordLength: keyword.value.trim().length,
      categories: selectedPreCategories.value.join(',') || 'all',
      scopeCount: selectedScopeSessionIds.value.length,
      forceRefresh: forceFullScan.value,
      pageSize: PAGE_SIZE,
    };
    logSearch('store_search_start', 'INFO', queryMeta, '开始逐会话聚焦搜索');
    hasSearched.value = true;
    isStreaming.value = true;
    searchStatus.value = 'streaming';
    rawResults.value = [];
    queuedItems = [];
    resultIds.clear();
    totalMatched.value = 0;
    selectedResultIds.value = [];
    lastClickedIndex.value = null;
    highResLoadedIds.value = {};
    brokenThumbIds.value = {};
    peerProgress.value = {};
    viewportTop.value = 0;
    searchViewportDataSource.reset();
    const query = {
      keyword: keyword.value,
      forceRefresh: forceFullScan.value,
      preCategories: [...selectedPreCategories.value],
      preExtensions: preExtensions.value.split(/[\s,;]+/).map(value => value.trim().replace(/^\./, '').toLowerCase()).filter(Boolean),
      scopeSessionIds: [...selectedScopeSessionIds.value], pageSize: PAGE_SIZE,
    };
    try {
      for await (const chunk of streamFocusedSearch(query, signal)) {
        if (epoch !== searchEpoch.value || signal.aborted) return;
        if (chunk.peerProgress) peerProgress.value[`${chunk.peerProgress.accountId}:${chunk.peerProgress.peerKey}`] = chunk.peerProgress;
        appendChunkItems(chunk.items, chunk.totalMatched);
      }
      if (epoch !== searchEpoch.value || signal.aborted) return;
      flushSearchItems();
      searchStatus.value = peerSummary.value.failed > 0 ? 'partial' : 'completed';
      logSearch('store_search_done', 'INFO', { ...queryMeta, loaded: rawResults.value.length, totalMatched: totalMatched.value, failedPeers: peerSummary.value.failed }, '聚焦搜索结束', Date.now() - startedAt);
    } catch (error) {
      if (epoch === searchEpoch.value && !signal.aborted) {
        flushSearchItems();
            searchStatus.value = 'error';
        const info = classifyTelegramError(error);
        searchError.value = info.bucket === 'UNKNOWN' ? '搜索未完成，请检查连接和会话范围后重试' : info.description;
        logSearch('store_search_error', 'ERROR', { ...queryMeta, bucket: info.bucket, code: info.code }, '聚焦搜索异常结束', Date.now() - startedAt);
      }
    } finally {
      if (epoch === searchEpoch.value) isStreaming.value = false;
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
  function handleResultCardClick(index: number, item: AggregateSearchResultItem, event: MouseEvent | KeyboardEvent) {
    if (event.type === 'click' && searchResultGestureDataSource.consumeClick(item.id)) return;
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
    const epoch = searchEpoch.value;
    const controller = new AbortController();
    coverControllers.set(item.id, controller);
    item.hdThumbAttempted = true;
    loadingHighResIds.value[item.id] = true;
    try {
      const hdDataUrl = await aggregateSearchDataSource.fetchHighResThumbnailDataUrl(item, controller.signal, epoch);
      if (controller.signal.aborted || epoch !== searchEpoch.value || !isModalOpen.value) return;
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
      if (controller.signal.aborted || epoch !== searchEpoch.value) return;
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
      if (controller.signal.aborted) {
        item.hdThumbAttempted = false;
        if (epoch === searchEpoch.value && isModalOpen.value && searchStatus.value !== 'stopped' && virtualResults.value.some(visible => visible.id === item.id)) {
          void nextTick(() => { if (canAutoLoadCover(item)) void loadHighResThumbnailForItem(item); });
        }
      }
      if (coverControllers.get(item.id) === controller) {
        coverControllers.delete(item.id);
        delete loadingHighResIds.value[item.id];
      }
    }
  }

  function startResultPointerGesture(item: AggregateSearchResultItem, event: PointerEvent) {
    searchResultGestureDataSource.begin(item.id, event, {
      start: (x, y) => startDragResultsToTree(item, x, y),
      move: updateDragToTreePointer,
      finish: finishDragToTree,
      cancel: cancelDragToTree,
    });
  }
  function releaseResultGesture(id: string) { searchResultGestureDataSource.release(id); }

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
    selectedPreCategories,
    preExtensions,
    forceFullScan,
    selectedPostCategories,
    postKeyword,
    postResolutionFilter,
    postDurationFilter,
    postMinSizeMb,
    postMaxSizeMb,
    postSizeBounds,
    postExcludeNoForwards,
    postDeduplicateByDocId,
    categoryOptions,
    activeFilterCount,
    toggleFilterMenu,
    setFilterStage,
    isPreTypeOptionsListed,
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
    virtualScopeSessions,
    scopePaddingTop,
    scopePaddingBottom,
    scopeRowHeightOf,
    scopeAvatarUrls,
    resultRowHeight,
    bindScopeViewport,
    selectedScopeSet,
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
    virtualResults,
    virtualPaddingTop,
    virtualPaddingBottom,
    resultWindow,
    bindResultsViewport,
    searchError,
    searchStatus,
    peerSummary,
    failedPeers,
    isStreaming,
    hasSearched,
    totalMatched,
    peerProgress,
    executeStreamingSearch,
    stopSearch,

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
    startResultPointerGesture,
    releaseResultGesture,
    updateDragToTreePointer,
    finishDragToTree,
    cancelDragToTree,
  };
});
