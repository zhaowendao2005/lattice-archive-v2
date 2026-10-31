/**
 * `path` 的替身。
 *
 * GramJS 的 `client/path.js` 只是把 Node `path` 转出去，上传/下载辅助函数会用到。
 * 浏览器里没有 Node path，这里提供与 POSIX 语义一致的最小实现。
 */
export function join(...parts: string[]): string {
  return parts.filter(Boolean).join('/').replace(/\/{2,}/g, '/');
}

export function basename(value: string): string {
  return value.split('/').filter(Boolean).pop() ?? '';
}

export function dirname(value: string): string {
  const parts = value.split('/').filter(Boolean);
  parts.pop();
  return parts.length ? `/${parts.join('/')}` : '.';
}

export function extname(value: string): string {
  const name = basename(value);
  const index = name.lastIndexOf('.');
  return index > 0 ? name.slice(index) : '';
}

export function resolve(...parts: string[]): string {
  return join(...parts);
}

export const sep = '/';

export default { join, basename, dirname, extname, resolve, sep };
