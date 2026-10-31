/**
 * `net` 的替身。
 *
 * GramJS 的 `extensions/net.js` 只是 `__exportStar(require('net'))`，
 * 供 Node 专用的 `PromisedNetSockets` 使用。浏览器走 WSS，这条路径永远不会被调用，
 * 但它仍会被静态打进 bundle —— 这里只需要保证「加载不报错、误用有明确错误」。
 */
export class Socket {
  constructor() { throw new Error('Node 的 net.Socket 在浏览器环境不可用'); }
}

export default { Socket };
