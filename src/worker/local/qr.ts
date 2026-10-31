import qrcode from 'qrcode-generator';

/**
 * 二维码必须在 local worker 内本地生成。
 *
 * Telegram 登录 token 等价于一次性的账户控制权，绝不能发给任何第三方渲染服务
 * （这也是本文件不依赖任何远程接口的原因）。
 *
 * 返回可直接用于 `<img src>` 的 data URL：视图层因此不需要 canvas 句柄，
 * 也不需要 `v-html`，符合「DOM 句柄不进视图」的约束。
 */
export function renderQrDataUrl(text: string): string {
  const code = qrcode(0, 'M');
  code.addData(text);
  code.make();
  // 默认 margin = cellSize * 4，即 QR 规范要求的 4 模块静默区，不要改成 0。
  const svg = code.createSvgTag({ cellSize: 4, scalable: true });
  const bytes = new TextEncoder().encode(svg);
  return `data:image/svg+xml;base64,${btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''))}`;
}
