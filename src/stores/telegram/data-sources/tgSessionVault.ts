const DEVICE_KEY = 'lattice.telegram.device-id';
const DB_NAME = 'lattice-telegram-vault';
const STORE_NAME = 'sessions';
const CREDS_PREFIX = 'creds:';

export interface LocalCredentialsData { apiId: number; apiHash: string }
export interface LocalSessionData { dcId: number; stringSession: string; apiId?: number; apiHash?: string; ownerId?: string }
interface VaultRecord { accountId: string; iv: ArrayBuffer; payload: ArrayBuffer }

let dbPromise: Promise<IDBDatabase> | null = null;
let keyPromise: Promise<CryptoKey> | null = null;

function getStorage(): Storage | null { return typeof window === 'undefined' ? null : window.localStorage; }

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 2);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME, { keyPath: 'accountId' });
      if (!request.result.objectStoreNames.contains('keys')) request.result.createObjectStore('keys');
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onclose = () => { dbPromise = null; };
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };
    request.onerror = () => { dbPromise = null; reject(request.error); };
  });
  return dbPromise;
}

function key(): Promise<CryptoKey> {
  if (keyPromise) return keyPromise;
  keyPromise = (async () => {
    const db = await openDb();
    const existing = await new Promise<CryptoKey | undefined>((resolve, reject) => {
      const request = db.transaction('keys', 'readonly').objectStore('keys').get('session');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    if (existing) return existing;
    const generated = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    await new Promise<void>((resolve, reject) => {
      const request = db.transaction('keys', 'readwrite').objectStore('keys').put(generated, 'session');
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
    return generated;
  })().catch((error) => {
    keyPromise = null;
    throw error;
  });
  return keyPromise;
}

async function putEncrypted(recordKey: string, value: unknown) {
  const [database, cryptoKey] = await Promise.all([openDb(), key()]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const payload = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, new TextEncoder().encode(JSON.stringify(value)));
  await new Promise<void>((resolve, reject) => {
    const request = database.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).put({ accountId: recordKey, iv: iv.buffer, payload });
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

async function getDecrypted<T>(recordKey: string): Promise<T | null> {
  const [database, cryptoKey] = await Promise.all([openDb(), key()]);
  const record = await new Promise<VaultRecord | undefined>((resolve, reject) => {
    const request = database.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(recordKey);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  if (!record) return null;
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: record.iv }, cryptoKey, record.payload);
  return JSON.parse(new TextDecoder().decode(plain)) as T;
}

async function deleteRecord(recordKey: string) {
  const database = await openDb();
  await new Promise<void>((resolve, reject) => {
    const request = database.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).delete(recordKey);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

export const tgSessionVault = {
  deviceId(): string {
    const storage = getStorage();
    if (!storage) return 'server';
    const existing = storage.getItem(DEVICE_KEY);
    if (existing) return existing;
    const value = crypto.randomUUID();
    storage.setItem(DEVICE_KEY, value);
    return value;
  },
  save(accountId: string, session: LocalSessionData) { return putEncrypted(accountId, session); },
  read(accountId: string): Promise<LocalSessionData | null> { return getDecrypted<LocalSessionData>(accountId); },
  remove(accountId: string) { return deleteRecord(accountId); },
  /** 按 Lattice 用户加密缓存 Telegram 应用凭据（api_id / api_hash），供冷启动 0 远端等待直连。 */
  saveCredentials(ownerId: string, creds: LocalCredentialsData) { return putEncrypted(`${CREDS_PREFIX}${ownerId}`, creds); },
  readCredentials(ownerId: string): Promise<LocalCredentialsData | null> { return getDecrypted<LocalCredentialsData>(`${CREDS_PREFIX}${ownerId}`); },
  removeCredentials(ownerId: string) { return deleteRecord(`${CREDS_PREFIX}${ownerId}`); },
  async listAccountIds(): Promise<string[]> {
    const database = await openDb();
    const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
      const request = database.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).getAllKeys();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return keys.map(String).filter((item) => !item.startsWith(CREDS_PREFIX));
  },
  /** 用同一把不可导出的设备密钥加密任意 JSON，供本机聊天缓存等敏感数据落盘。 */
  async seal(value: unknown): Promise<{ iv: ArrayBuffer; payload: ArrayBuffer }> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const payload = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(), new TextEncoder().encode(JSON.stringify(value)));
    return { iv: iv.buffer, payload };
  },
  async open<T>(record: { iv: ArrayBuffer; payload: ArrayBuffer }): Promise<T> {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: record.iv }, await key(), record.payload);
    return JSON.parse(new TextDecoder().decode(plain)) as T;
  },
  /** 二进制版本：用于本机媒体缓存（图片字节），避免 JSON / base64 膨胀。 */
  async sealBytes(bytes: ArrayBuffer): Promise<{ iv: Uint8Array<ArrayBuffer>; payload: ArrayBuffer }> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const payload = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(), bytes);
    return { iv, payload };
  },
  async openBytes(iv: Uint8Array<ArrayBuffer>, payload: ArrayBuffer): Promise<ArrayBuffer> {
    return crypto.subtle.decrypt({ name: 'AES-GCM', iv }, await key(), payload);
  },
};
