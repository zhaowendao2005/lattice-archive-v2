/** 仅用于展示的掩码，绝不参与任何鉴权判断。 */
export function maskSecret(value: string): string {
  if (value.length <= 6) return '••••';
  return `${value.slice(0, 3)}…${value.slice(-4)}`;
}
