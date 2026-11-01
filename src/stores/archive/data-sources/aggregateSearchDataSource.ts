/**
 * ============================================================================
 * 聚合搜索数据源接线器 (Aggregate Search Data Source Singleton)
 * ============================================================================
 * 定位：归档与聚合搜索业务域唯一的全局单例连接器。
 * 职责：
 * 1. 对接底层检索流（当前阶段对接 `aggregateSearchMock.ts`，真实后端就绪后直接替换此处实现并删除 Mock）；
 * 2. 提供支持 `AbortSignal` 的分块流式检索异步生成器 (`streamSearchPage`)；
 * 3. 统一托管触底懒加载的 `IntersectionObserver` 句柄与拖拽悬停展开定时器，保证视图层零本地 `ref`。
 */
import {
  MOCK_SCOPE_SESSIONS,
  MOCK_SEARCH_RESULTS_POOL,
  SEARCH_CATEGORY_OPTIONS,
} from '../mocks/aggregateSearchMock';
import type {
  AggregateSearchResultItem,
  SearchCategoryOption,
  SearchScopeSessionDto,
  StreamingSearchChunk,
  StreamingSearchQuery,
} from '../types';

const STREAM_CHUNK_SIZE = 3;
const STREAM_STEP_DELAY_MS = 80;

function sleepWithAbort(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise(resolve => {
    const timer = window.setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    const onAbort = () => {
      window.clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

class AggregateSearchDataSource {
  private activeAbortController: AbortController | null = null;
  private sentinelObserver: IntersectionObserver | null = null;
  private treeExpandTimer: number | null = null;

  /** 获取搜索前筛选的 5 类文件类型元数据 */
  getCategoryOptions(): SearchCategoryOption[] {
    return SEARCH_CATEGORY_OPTIONS;
  }

  /** 获取右栏搜索范围控制的两类会话列表（已加入的会话 + 只有凭据的会话） */
  getScopeSessions(): SearchScopeSessionDto[] {
    return MOCK_SCOPE_SESSIONS;
  }

  /** 中止当前在途的流式检索请求 */
  abortActiveStream(): void {
    if (this.activeAbortController) {
      this.activeAbortController.abort();
      this.activeAbortController = null;
    }
  }

  /** 创建新的流式检索取消信号 */
  createStreamSignal(): AbortSignal {
    this.abortActiveStream();
    this.activeAbortController = new AbortController();
    return this.activeAbortController.signal;
  }

  /**
   * 按查询条件过滤匹配结果全集（搜索前筛选在此阶段直接参与检索）
   */
  private filterPool(query: StreamingSearchQuery): AggregateSearchResultItem[] {
    const kw = query.keyword.trim().toLowerCase();
    const hasCategoryFilter = query.preCategories.length > 0;
    const categorySet = new Set(query.preCategories);
    const hasScopeFilter = query.scopeSessionIds.length > 0;
    const scopeSet = new Set(query.scopeSessionIds);

    return MOCK_SEARCH_RESULTS_POOL.filter(item => {
      // 1. 搜索前文件类型筛选（多选）
      if (hasCategoryFilter && !categorySet.has(item.category)) {
        return false;
      }
      // 2. 右栏会话范围控制筛选
      if (hasScopeFilter && !scopeSet.has(item.sessionId)) {
        return false;
      }
      // 3. 关键词全文匹配（标题 / 摘要 / 扩展名 / 所属会话 / 分类名）
      if (kw) {
        const hit =
          item.title.toLowerCase().includes(kw) ||
          item.snippet.toLowerCase().includes(kw) ||
          item.extension.toLowerCase().includes(kw) ||
          item.sessionTitle.toLowerCase().includes(kw) ||
          item.categoryLabel.toLowerCase().includes(kw);
        if (!hit) return false;
      }
      return true;
    });
  }

  /**
   * 流式分页检索生成器：模拟远端/本地索引引擎分块流式输出搜索结果卡片
   */
  async *streamSearchPage(
    query: StreamingSearchQuery,
    signal: AbortSignal,
  ): AsyncGenerator<StreamingSearchChunk, void, unknown> {
    const matchedAll = this.filterPool(query);
    const totalMatched = matchedAll.length;
    const startIdx = (query.page - 1) * query.pageSize;
    const endIdx = startIdx + query.pageSize;
    const pageSlice = matchedAll.slice(startIdx, endIdx);
    const hasMore = endIdx < totalMatched;

    if (pageSlice.length === 0) {
      const ok = await sleepWithAbort(60, signal);
      if (!ok) return;
      yield {
        items: [],
        totalMatched,
        hasMore: false,
        isFinalChunkOfPage: true,
      };
      return;
    }

    for (let offset = 0; offset < pageSlice.length; offset += STREAM_CHUNK_SIZE) {
      const ok = await sleepWithAbort(STREAM_STEP_DELAY_MS, signal);
      if (!ok || signal.aborted) return;

      const chunkItems = pageSlice.slice(offset, offset + STREAM_CHUNK_SIZE);
      const isFinalChunkOfPage = offset + STREAM_CHUNK_SIZE >= pageSlice.length;

      yield {
        items: chunkItems,
        totalMatched,
        hasMore,
        isFinalChunkOfPage,
      };
    }
  }

  /**
   * 绑定底部懒加载哨兵 DOM 节点（由自定义指令或挂载回调委托，视图层零 ref）
   */
  bindLazyLoadSentinel(
    el: HTMLElement | null,
    scrollRoot: HTMLElement | null,
    onReachBottom: () => void,
  ): void {
    this.unbindLazyLoadSentinel();
    if (!el || typeof IntersectionObserver === 'undefined') return;

    this.sentinelObserver = new IntersectionObserver(
      entries => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            onReachBottom();
          }
        }
      },
      {
        root: scrollRoot,
        rootMargin: '0px 0px 180px 0px',
        threshold: 0.01,
      },
    );
    this.sentinelObserver.observe(el);
  }

  unbindLazyLoadSentinel(): void {
    if (this.sentinelObserver) {
      this.sentinelObserver.disconnect();
      this.sentinelObserver = null;
    }
  }

  /**
   * 跨栏拖拽悬停在收起的树节点上时，延迟 420ms 自动展开该节点
   */
  scheduleTreeHoverExpand(callback: () => void, delayMs = 420): void {
    this.clearTreeHoverExpand();
    this.treeExpandTimer = window.setTimeout(() => {
      this.treeExpandTimer = null;
      callback();
    }, delayMs);
  }

  clearTreeHoverExpand(): void {
    if (this.treeExpandTimer !== null) {
      window.clearTimeout(this.treeExpandTimer);
      this.treeExpandTimer = null;
    }
  }
}

export const aggregateSearchDataSource = new AggregateSearchDataSource();
