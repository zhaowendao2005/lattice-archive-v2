/**
 * 脱敏工具：把 api_hash 变成「前 3 + … + 后 4」的展示形式。
 * 仅用于界面展示与日志，绝不参与任何鉴权判断。
 */
/** 仅用于展示的掩码，绝不参与任何鉴权判断。 */
export function maskSecret(value: string): string {
  if (value.length <= 6) return '••••'; // 太短的串直接全遮，避免泄露大部分字符
  return `${value.slice(0, 3)}…${value.slice(-4)}`;
}
