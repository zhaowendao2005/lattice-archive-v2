/**
 * GramJS 在 Worker 里需要三个全局垫片，缺一不可。这个文件必须是 tg.worker.ts
 * 的第一个 import —— ES 模块按 import 声明顺序求值，晚一步 GramJS 就已经炸了。
 *
 * 1. `Buffer`：TL 反序列化在模块求值阶段就用它（官方 webpack 构建同样用
 *    ProvidePlugin 注入，等价做法）。
 * 2. `window`：GramJS 的平台判定是 `isBrowser = typeof window !== 'undefined'`，
 *    而 Worker 里没有 `window`，它就会误判为 Node —— 于是选用
 *    `PromisedNetSockets`（node 的 net 模块）并强制 `useWSS = false`，
 *    在浏览器里必然连不上。把它指回 globalThis 即可走浏览器 WebSocket 分支。
 * 3. `process`：Node 专用模块会读它；浏览器路径只需一个不抛错的占位实现，
 *    因此不引入 `process` 包。
 */
import { Buffer } from 'buffer';

interface ProcessShim {
  env: Record<string, string | undefined>;
  platform: string;
  version: string;
  nextTick: (callback: (...args: unknown[]) => void, ...args: unknown[]) => void;
}

const scope = globalThis as unknown as Record<string, unknown>;

if (!scope.Buffer) scope.Buffer = Buffer;

if (!scope.window) scope.window = globalThis;

if (!scope.process) {
  const shim: ProcessShim = {
    env: {},
    platform: 'browser',
    version: '',
    nextTick: (callback, ...args) => { queueMicrotask(() => callback(...args)); },
  };
  scope.process = shim;
}
