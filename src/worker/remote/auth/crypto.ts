/**
 * ============================================================================
 * 密码学基础设施（密码哈希 / 会话 Token）
 * ============================================================================
 * 两条安全铁律：
 *   1. 密码用 PBKDF2-HMAC-SHA256 + 随机盐，迭代 25,000 次，从不存明文；
 *   2. 会话 Token 只存 SHA-256 摘要，数据库泄露也不等于会话泄露。
 * 比较一律用 timingSafeEqual（固定时间），防止时序攻击。
 */
import { timingSafeEqual } from 'node:crypto'; // Workers 的 nodejs_compat 提供了这个实现

const ITERATIONS = 25_000; // 迭代次数：兼顾安全与 Worker CPU 时间上限
const KEY_LENGTH = 32;     // 派生密钥长度（字节），即 256 bit
const encoder = new TextEncoder();
// 字节数组 → 十六进制字符串（存储格式）
const toHex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
// 十六进制字符串 → 字节数组（读取存储时反解）
const fromHex = (hex: string) => Uint8Array.from(hex.match(/.{2}/g) ?? [], (part) => Number.parseInt(part, 16));
// 字节 → Base64URL（无 + / =，可以直接放 URL / Header）
const toBase64Url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');

/** 底层 PBKDF2 派生：口令 + 盐 + 迭代次数 → 32 字节密钥 */
async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const material = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt.slice().buffer as ArrayBuffer, iterations }, material, KEY_LENGTH * 8));
}

/** 生成随机盐 + 哈希，返回可直接入库的三个字段（哈希 / 盐 / 迭代次数） */
export async function hashPassword(password: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { hash: toHex(await derive(password, salt, ITERATIONS)), salt: toHex(salt), iterations: ITERATIONS };
}

/** 校验口令：重算一遍再固定时间比较（长度不同直接 false） */
export async function verifyPassword(password: string, saltHex: string, expectedHex: string, iterations: number): Promise<boolean> {
  const actual = await derive(password, fromHex(saltHex), iterations);
  const expected = fromHex(expectedHex);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** 签发新会话 Token：32 字节 CSPRNG → Base64URL（明文只在签发瞬间存在） */
export async function generateSessionToken(): Promise<string> {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

/** 计算 Token 的 SHA-256 摘要（入库 / 查询用的都是它） */
export async function hashSessionToken(token: string): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(token))));
}

/**
 * 「虚拟派生」：账户不存在时也跑一次同等开销的 PBKDF2，
 * 使得「邮箱不存在」与「密码错误」的响应耗时无法区分，防用户枚举。
 */
export async function verifyDummyPassword(password: string): Promise<void> {
  await derive(password, new Uint8Array(16), ITERATIONS);
}
