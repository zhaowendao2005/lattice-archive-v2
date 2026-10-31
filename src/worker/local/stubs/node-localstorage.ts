/**
 * `node-localstorage` 的替身。
 *
 * 只被 GramJS 的 `StoreSession`（Node 端的目录型会话存储）引用。浏览器侧我们
 * 使用 `StringSession` + IndexedDB 金库，这条路径不会被调用，但模块会静态打包进来，
 * 因此必须保证加载不报错。
 */
export class LocalStorage {
  constructor() { throw new Error('node-localstorage 在浏览器环境不可用'); }
}

export default { LocalStorage };
