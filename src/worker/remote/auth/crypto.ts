import { timingSafeEqual } from 'node:crypto';

const ITERATIONS = 25_000;
const KEY_LENGTH = 32;
const encoder = new TextEncoder();
const toHex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
const fromHex = (hex: string) => Uint8Array.from(hex.match(/.{2}/g) ?? [], (part) => Number.parseInt(part, 16));
const toBase64Url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const material = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt.slice().buffer as ArrayBuffer, iterations }, material, KEY_LENGTH * 8));
}

export async function hashPassword(password: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { hash: toHex(await derive(password, salt, ITERATIONS)), salt: toHex(salt), iterations: ITERATIONS };
}

export async function verifyPassword(password: string, saltHex: string, expectedHex: string, iterations: number): Promise<boolean> {
  const actual = await derive(password, fromHex(saltHex), iterations);
  const expected = fromHex(expectedHex);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function generateSessionToken(): Promise<string> {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function hashSessionToken(token: string): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(token))));
}

export async function verifyDummyPassword(password: string): Promise<void> {
  await derive(password, new Uint8Array(16), ITERATIONS);
}
