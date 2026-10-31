/**
 * `os` 的替身。
 *
 * GramJS 在没显式传入 `deviceModel` / `systemVersion` 时会调用
 * `os.type()` / `os.release()` 兜底。这两项我们已经显式传了，但为了让这条兜底
 * 路径在浏览器里也不会抛 `undefined is not a function`，仍然提供最小实现。
 */
export function type(): string { return 'Lattice'; }
export function release(): string { return '2.0.0'; }
export function platform(): string { return 'browser'; }
export function arch(): string { return 'wasm'; }
export function tmpdir(): string { return '/tmp'; }
export function cpus(): unknown[] { return []; }

export default { type, release, platform, arch, tmpdir, cpus };
