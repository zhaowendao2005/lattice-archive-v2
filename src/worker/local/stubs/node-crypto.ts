import { Buffer } from 'buffer';

/**
 * `crypto`（Node 内置模块）的浏览器替身。
 *
 * GramJS 的 `CryptoFile.js` 只是把 Node `crypto` 原样转出去，但 `Helpers.js`
 * （随机字节）与 `Password.js`（SRP 2FA 的 PBKDF2）却在用它的同步 API。
 * 浏览器里没有 Node crypto，这里用 WebCrypto 提供等价能力。
 *
 * 注意契约：`pbkdf2Sync` 与 `digest()` 返回 **Promise** —— GramJS 的调用点
 * 本身就在 async 函数里直接 `return`，因此语义等价（官方 webz fork 也是这么改的）。
 */
export function randomBytes(count: number): Uint8Array {
  const bytes = new Uint8Array(count);
  crypto.getRandomValues(bytes);
  return bytes;
}

class Hash {
  private readonly algorithm: 'sha1' | 'sha256';
  private data = new Uint8Array(0);

  constructor(algorithm: 'sha1' | 'sha256') { this.algorithm = algorithm; }

  update(data: Uint8Array) { this.data = new Uint8Array(data); }

  async digest(): Promise<Buffer> {
    const name = this.algorithm === 'sha1' ? 'SHA-1' : 'SHA-256';
    return Buffer.from(await crypto.subtle.digest(name, toArrayBuffer(this.data)));
  }
}

/** WebCrypto 只接受 ArrayBuffer 支撑的视图，这里做一次拷贝以消除类型收窄问题。 */
function toArrayBuffer(value: Uint8Array): ArrayBuffer {
  return Uint8Array.from(value).buffer;
}

export function createHash(algorithm: 'sha1' | 'sha256'): Hash {
  return new Hash(algorithm);
}

export async function pbkdf2Sync(password: Uint8Array, salt: Uint8Array, iterations: number): Promise<Buffer> {
  const passwordBytes = toArrayBuffer(password);
  const saltBytes = toArrayBuffer(salt);
  const key = await crypto.subtle.importKey('raw', passwordBytes, 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: saltBytes, iterations, hash: 'SHA-512' }, key, 512);
  return Buffer.from(bits);
}

/** 仅用于 CDN 加密媒体的下载解密，当前功能未使用。 */
export function createCipheriv(): never {
  throw new Error('CDN 加密媒体的解密的尚未接入（createCipheriv）');
}

export function createDecipheriv(): never {
  throw new Error('CDN 加密媒体的解密尚未接入（createDecipheriv）');
}

export default { randomBytes, createHash, pbkdf2Sync, createCipheriv, createDecipheriv };
