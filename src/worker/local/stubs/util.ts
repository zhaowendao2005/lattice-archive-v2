/**
 * `util` 的极简替身。
 *
 * GramJS 的 `inspect.js` 只是把 `util.inspect` 转出去，但 `tl/api.js` 会用
 * `[inspect.custom]` 作为**类定义时的计算属性名** —— 也就是说它在模块求值阶段
 * 就会读取这个 symbol。Node 内置模块在浏览器构建里被 Vite 外部化成空壳，
 * 于是 `inspect.custom` 变成 undefined 并直接抛错，必须补上。
 */
const custom = Symbol.for('nodejs.util.inspect.custom');

function inspect(value: unknown): string {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value) ?? String(value); } catch { return String(value); }
}

inspect.custom = custom;

export { inspect };
