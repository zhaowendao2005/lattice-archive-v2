/**
 * ============================================================================
 * 工作区分区切换的缓冲与预热（会话 / 归档 / 设置）
 * ============================================================================
 * 首次切换某个分区时有两段耗时：
 *   1. 拉取该路由的懒加载分包（生产为网络下载，开发模式下 Vite 还要即时转译）；
 *   2. 首次挂载重组件（KeepAlive 之后的再次进入几乎为 0）。
 * 这里做两件事：
 *   · 预热：进入工作区后，在浏览器空闲时依次预取所有工作区子路由分包，消除第 1 段；
 *   · 缓冲：切换期间置 appStore.isSectionSwitching，AppLayout 渲染淡入遮罩与进度条。
 *     首次进入的分区会先让出一帧，确保遮罩的 CSS 过渡已提交给合成线程，
 *     这样即使随后主线程被挂载阻塞，动画仍能继续播放（只动 opacity / transform）。
 */
import { nextTick } from 'vue';
import type { RouteLocationNormalized, Router } from 'vue-router';
import { useAppStore } from '@/stores/app/stores/appStore';

const WORKSPACE_ROOT = '/workspace';
/** 预取等待浏览器空闲的最长时间：超时后无论是否空闲都开始预取。 */
const PREFETCH_IDLE_TIMEOUT_MS = 2_000;

/** 已经挂载过的分区（KeepAlive 缓存后再次进入无需让帧）。纯记账，不属于视图状态。 */
const visitedSections = new Set<string>();
/** 当前正在缓冲的目标路由；快速连点时只认最后一次导航，旧导航的收尾直接忽略。 */
let pendingTarget: RouteLocationNormalized | null = null;
let prefetchScheduled = false;

/** 分区标识 = 工作区下第一级子路由的路径；不在工作区内返回 null。 */
function sectionOf(route: RouteLocationNormalized): string | null {
  if (route.matched[0]?.path !== WORKSPACE_ROOT) return null;
  return route.matched[1]?.path ?? null;
}

/** 等到浏览器完成一次绘制（rAF 在绘制前触发，其后的宏任务在绘制后执行）。 */
function afterNextPaint() {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => { setTimeout(resolve, 0); });
  });
}

function whenIdle(task: () => void) {
  if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(task, { timeout: PREFETCH_IDLE_TIMEOUT_MS });
  else window.setTimeout(task, PREFETCH_IDLE_TIMEOUT_MS / 2);
}

/**
 * 依次（而非并发）预取工作区下所有懒加载路由组件，避免与首屏 Telegram 请求争抢带宽。
 * vue-router 的懒加载记录在解析前就是 `() => import(...)`；重复调用由打包器的模块缓存去重，
 * 真正导航时 vue-router 会再次调用并瞬时拿到已缓存的模块。
 */
function prefetchWorkspaceRoutes(router: Router) {
  const loaders = router.getRoutes()
    .filter((record) => record.path.startsWith(WORKSPACE_ROOT))
    .flatMap((record) => Object.values(record.components ?? {}))
    .filter((component): component is () => Promise<unknown> => typeof component === 'function');
  const next = () => {
    const loader = loaders.shift();
    if (!loader) return;
    // 预取失败不影响功能：真正导航时还会重新加载并走正常的错误处理。
    loader().catch(() => undefined).finally(() => whenIdle(next));
  };
  whenIdle(next);
}

function finish(target: RouteLocationNormalized) {
  if (pendingTarget !== target) return;
  pendingTarget = null;
  useAppStore().setSectionSwitching(false);
}

export function installWorkspaceTransition(router: Router) {
  router.beforeEach((to, from) => {
    const fromSection = sectionOf(from);
    const toSection = sectionOf(to);
    // 首次进入应用（from 尚无匹配）与同分区内跳转（如切换会话）都不展示缓冲。
    if (!fromSection || !toSection || fromSection === toSection) return;
    pendingTarget = to;
    useAppStore().setSectionSwitching(true);
  });

  router.beforeResolve(async (to) => {
    const section = sectionOf(to);
    if (pendingTarget !== to || !section || visitedSections.has(section)) return;
    await afterNextPaint();
  });

  router.afterEach((to, _from, failure) => {
    const section = sectionOf(to);
    if (!failure && section) visitedSections.add(section);
    if (!failure && section && !prefetchScheduled) {
      prefetchScheduled = true;
      prefetchWorkspaceRoutes(router);
    }
    if (pendingTarget !== to) return;
    if (failure) { finish(to); return; }
    // 等新页面挂载完成（nextTick）并绘制一帧之后再撤遮罩，淡出即为新页面的淡入。
    void nextTick().then(afterNextPaint).then(() => finish(to));
  });

  router.onError(() => {
    if (pendingTarget) finish(pendingTarget);
  });
}
