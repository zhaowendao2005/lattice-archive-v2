/**
 * `socks` 的替身。
 *
 * `socks` 客户端继承 `events.EventEmitter`，而 `events` 在浏览器构建里是空的，
 * 会在模块求值阶段直接抛 `Class extends value undefined`。浏览器走 WSS 不需要
 * SOCKS 代理，因此替换成「一用就明确报错」的替身即可。
 */
export class SocksClient {
  static createConnection(): never {
    throw new Error('SOCKS 代理在浏览器环境不可用');
  }
}

export class SocksClientError extends Error {}

export default { SocksClient, SocksClientError };
