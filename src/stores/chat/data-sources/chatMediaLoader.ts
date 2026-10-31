/**
 * [DATA SOURCE] 媒体加载调度器
 *
 * 统一媒体 loader：内存 Object URL 缓存 + 相同资源请求去重 + 优先级队列 + 并发上限 + 指数退避重试。
 * Object URL 属于不可序列化的 DOM 资源句柄，只在本模块登记与回收；Store 中仅保存 URL 字符串与状态。
 * 媒体预载与消息历史请求解耦：并发上限保证滚动大列表时不会挤压会话 / 历史 RPC。
 *
 * 两条通道：
 * - image：照片档位 / 视频缩略图，并发 3，按条数（400）LRU；
 * - video：完整视频文件，并发 2，按字节（256 MB）LRU；正在播放的 URL 通过 pin 免于淘汰。
 * 视频任务可在下载中途 abort（Worker 在分片边界停止）。
 */
export type MediaLane = 'image' | 'video';

/** video 通道并发 2：查看器的大文件下载不会让气泡内的小 GIF / 圆形视频长时间排队。 */
const LANE_CONCURRENCY: Record<MediaLane, number> = { image: 3, video: 2 };
/** 参考实现的退避节奏：约 250 ms、500 ms、1 s、2 s、4 s，最多 5 次。 */
const IMAGE_RETRY_DELAYS_MS = [250, 500, 1_000, 2_000, 4_000];
/** 完整视频重新下载成本高：只对网络类错误重试 2 次。 */
const VIDEO_RETRY_DELAYS_MS = [1_000, 3_000];
/** 内存中最多保留的图片 Object URL；超出时按最近使用淘汰（可见元素会被持续 touch，不会被淘汰）。 */
const MAX_IMAGE_URLS = 400;
/** 内存中视频 Blob 的总字节预算。 */
const MAX_VIDEO_BYTES = 256 * 1024 * 1024;

export class MediaCanceledError extends Error {
  constructor() { super('MEDIA_CANCELED'); }
}

export interface MediaFetchContext {
  signal: AbortSignal;
  onProgress: (loaded: number, total: number) => void;
}

export interface MediaLoadOptions {
  priority: number;
  lane?: MediaLane;
  fetch: (context: MediaFetchContext) => Promise<Blob>;
  isRetryable: (error: unknown) => boolean;
  onProgress?: (loaded: number, total: number) => void;
}

interface MediaTask extends Required<Omit<MediaLoadOptions, 'onProgress'>> {
  key: string;
  onProgress?: (loaded: number, total: number) => void;
  controller: AbortController;
  resolve: (url: string) => void;
  reject: (error: unknown) => void;
}

interface UrlRecord { url: string; lane: MediaLane; bytes: number }

type EvictListener = (key: string) => void;

const urls = new Map<string, UrlRecord>();
const pinned = new Set<string>();
const inflight = new Map<string, Promise<string>>();
/** key → 当前拥有 inflight 条目的任务（排队或下载中）。 */
const inflightTasks = new Map<string, MediaTask>();
const runningTasks = new Map<string, MediaTask>();
let queue: MediaTask[] = [];
const running: Record<MediaLane, number> = { image: 0, video: 0 };
let generation = 0;
let evictListener: EvictListener | null = null;

const wait = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = window.setTimeout(resolve, ms);
  signal.addEventListener('abort', () => { window.clearTimeout(timer); reject(new MediaCanceledError()); }, { once: true });
});

function evict(key: string, record: UrlRecord) {
  urls.delete(key);
  URL.revokeObjectURL(record.url);
  evictListener?.(key);
}

function enforceBudgets() {
  let imageCount = 0;
  let videoBytes = 0;
  urls.forEach((record) => { if (record.lane === 'image') imageCount += 1; else videoBytes += record.bytes; });
  // Map 迭代顺序即 LRU 顺序（最久未用在前）。
  for (const [key, record] of [...urls]) {
    if (pinned.has(key)) continue;
    if (record.lane === 'image' && imageCount > MAX_IMAGE_URLS) { evict(key, record); imageCount -= 1; }
    else if (record.lane === 'video' && videoBytes > MAX_VIDEO_BYTES) { evict(key, record); videoBytes -= record.bytes; }
  }
}

function remember(key: string, lane: MediaLane, blob: Blob) {
  const url = URL.createObjectURL(blob);
  urls.set(key, { url, lane, bytes: blob.size });
  enforceBudgets();
  return url;
}

async function execute(task: MediaTask, taskGeneration: number) {
  const delays = task.lane === 'video' ? VIDEO_RETRY_DELAYS_MS : IMAGE_RETRY_DELAYS_MS;
  const context: MediaFetchContext = { signal: task.controller.signal, onProgress: (loaded, total) => task.onProgress?.(loaded, total) };
  let lastError: unknown;
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    try {
      const blob = await task.fetch(context);
      if (taskGeneration !== generation || task.controller.signal.aborted) throw new MediaCanceledError();
      return remember(task.key, task.lane, blob);
    } catch (error) {
      lastError = error;
      if (taskGeneration !== generation || task.controller.signal.aborted || error instanceof MediaCanceledError) throw new MediaCanceledError();
      if (!task.isRetryable(error) || attempt === delays.length) throw error;
      await wait(delays[attempt], task.controller.signal);
    }
  }
  throw lastError;
}

function pump() {
  queue.sort((a, b) => b.priority - a.priority);
  for (const lane of ['image', 'video'] as const) {
    while (running[lane] < LANE_CONCURRENCY[lane]) {
      const index = queue.findIndex((task) => task.lane === lane);
      if (index < 0) break;
      const [task] = queue.splice(index, 1);
      const taskGeneration = generation;
      running[lane] += 1;
      runningTasks.set(task.key, task);
      execute(task, taskGeneration)
        .then(task.resolve, task.reject)
        .finally(() => {
          // reset() 之后旧代次的任务不再占用并发计数，也不能误删新代次 / abort 后重新发起的同名请求。
          if (taskGeneration === generation) {
            running[lane] -= 1;
            if (runningTasks.get(task.key) === task) runningTasks.delete(task.key);
            if (inflightTasks.get(task.key) === task) { inflight.delete(task.key); inflightTasks.delete(task.key); }
          }
          pump();
        });
    }
  }
}

export const chatMediaLoader = {
  /** 已在内存中的 URL；命中时顺带刷新 LRU 顺序。 */
  get(key: string): string | undefined {
    const record = urls.get(key);
    if (record) { urls.delete(key); urls.set(key, record); }
    return record?.url;
  },

  /** 可见元素持续 touch，防止仍在屏幕上的图片被淘汰回收。 */
  touch(key: string) { this.get(key); },

  /** 正在播放的视频 URL 不参与淘汰；停止播放后 unpin 并按预算回收。 */
  pin(key: string) { pinned.add(key); this.touch(key); },
  unpin(key: string) { if (pinned.delete(key)) enforceBudgets(); },

  onEvict(listener: EvictListener) { evictListener = listener; },

  /** priority 越大越先执行：查看器 > 手动 > 可见 > 预取。重复请求合并为同一个 Promise 并提升优先级。 */
  load(key: string, options: MediaLoadOptions): Promise<string> {
    const cached = this.get(key);
    if (cached) return Promise.resolve(cached);
    const pending = inflight.get(key);
    if (pending) {
      const task = inflightTasks.get(key);
      if (task && queue.includes(task) && task.priority < options.priority) task.priority = options.priority;
      if (task && options.onProgress) task.onProgress = options.onProgress;
      return pending;
    }
    let created: MediaTask | undefined;
    const promise = new Promise<string>((resolve, reject) => {
      created = { key, lane: options.lane ?? 'image', priority: options.priority, fetch: options.fetch, isRetryable: options.isRetryable, onProgress: options.onProgress, controller: new AbortController(), resolve, reject };
    });
    queue.push(created!);
    inflight.set(key, promise);
    inflightTasks.set(key, created!);
    pump();
    return promise;
  },

  /** 取消尚未开始的下载（元素滚出预取范围）；已开始的下载不受影响，完成后照常进入缓存。 */
  cancel(key: string): boolean {
    const index = queue.findIndex((task) => task.key === key);
    if (index < 0) return false;
    const [task] = queue.splice(index, 1);
    inflight.delete(key);
    inflightTasks.delete(key);
    task.reject(new MediaCanceledError());
    return true;
  },

  /** 中断排队中或下载中的任务（关闭查看器 / 切换聊天 / 用户点取消）。 */
  abort(key: string): boolean {
    if (this.cancel(key)) return true;
    const task = runningTasks.get(key);
    if (!task) return false;
    task.controller.abort();
    // 立即让出 inflight 条目：随后对同一资源的请求会新建任务，而不是拿到即将以取消结束的旧 Promise。
    inflight.delete(key);
    inflightTasks.delete(key);
    return true;
  },

  isLoading(key: string) { return inflight.has(key); },

  /** 切换账户 / 用户时回收全部 Object URL 并丢弃队列；在途下载被中断并按代次丢弃。 */
  reset() {
    generation += 1;
    const pending = queue;
    queue = [];
    running.image = 0;
    running.video = 0;
    inflight.clear();
    inflightTasks.clear();
    runningTasks.forEach((task) => task.controller.abort());
    runningTasks.clear();
    pinned.clear();
    pending.forEach((task) => task.reject(new MediaCanceledError()));
    urls.forEach((record) => URL.revokeObjectURL(record.url));
    urls.clear();
  },

  /** 触发浏览器下载已加载的媒体。 */
  saveAs(url: string, fileName: string) {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  },
};
