/**
 * ============================================================================
 * 批量无头会话导入底层解析实现 (src/worker/local/sessionBatchParser.ts)
 * ============================================================================
 * 归属：本地 Worker 具体业务实现域（供 Data Source 薄桥接层调用）。
 * 支持：
 * 1. 多行 GramJS / Telethon StringSession 字符串批量解析；
 * 2. `.session` (SQLite3 二进制 / 文本) + `.json` (含黏性设备指纹与 2FA) 成对文件解析；
 * 3. 自动将提取出的 dcId + serverAddress + port + 256B authKey 编码为 GramJS 标准 StringSession。
 */
import type { DeviceFingerprintProfile } from '@/stores/archive/types';

export interface ParsedImportedSessionItem {
  id: string;
  label: string;
  phone?: string;
  sessionString: string;
  twoFaPassword?: string;
  dcId: number;
  deviceFingerprint: DeviceFingerprintProfile;
}

const DEFAULT_DC_IPV4: Record<number, { ip: string; port: number }> = {
  1: { ip: '149.154.175.53', port: 443 },
  2: { ip: '149.154.167.51', port: 443 },
  3: { ip: '149.154.175.100', port: 443 },
  4: { ip: '149.154.167.91', port: 443 },
  5: { ip: '91.108.56.130', port: 443 },
};

export const DEFAULT_DEVICE_FINGERPRINT: DeviceFingerprintProfile = {
  deviceModel: 'Desktop',
  systemVersion: 'Mac OS X 14.5',
  appVersion: '5.12.3',
  langCode: 'zh-hans',
  systemLangCode: 'zh-CN',
};

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

/**
 * 将 dcId + IPv4 + port + 256B authKey 编码为 GramJS / Telethon 标准 v1 StringSession
 */
export function encodeGramJsStringSession(
  dcId: number,
  ip: string,
  port: number,
  authKey: Uint8Array,
): string {
  if (authKey.byteLength !== 256) {
    throw new Error(`Invalid auth_key length: expected 256 bytes, got ${authKey.byteLength}`);
  }
  const ipBytes = new TextEncoder().encode(ip);
  const totalLen = 1 + 2 + ipBytes.byteLength + 2 + 256;
  const buf = new Uint8Array(totalLen);
  const view = new DataView(buf.buffer);

  let offset = 0;
  view.setUint8(offset, dcId);
  offset += 1;
  view.setUint16(offset, ipBytes.byteLength, true);
  offset += 2;
  buf.set(ipBytes, offset);
  offset += ipBytes.byteLength;
  view.setInt16(offset, port, true);
  offset += 2;
  buf.set(authKey, offset);
  return `1${bytesToBase64(buf)}`;
}

/**
 * 从 Telethon / Pyrogram SQLite 3 二进制文件字节流中定位 256 字节 auth_key 与 dc_id
 */
export function extractFromSqliteBytes(bytes: Uint8Array): {
  dcId: number;
  authKey: Uint8Array;
} | null {
  const textSample = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, 512)).trim();
  if (/^1[A-Za-z0-9+/=_-]{300,}$/.test(textSample)) {
    return null;
  }

  for (let i = 16; i + 270 < bytes.byteLength; i++) {
    if (bytes[i] === 0x84 && bytes[i + 1] === 0x0c) {
      for (let hdrOffset = 2; hdrOffset <= 12; hdrOffset++) {
        const candidateStart = i + hdrOffset;
        if (candidateStart + 256 <= bytes.byteLength) {
          const slice = bytes.subarray(candidateStart, candidateStart + 256);
          const uniqueValues = new Set(slice).size;
          if (uniqueValues >= 96) {
            let dcId = 2;
            for (let k = Math.max(0, candidateStart - 32); k < candidateStart; k++) {
              const v = bytes[k]!;
              if (v >= 1 && v <= 5) {
                dcId = v;
                break;
              }
            }
            return { dcId, authKey: new Uint8Array(slice) };
          }
        }
      }
    }
  }
  return null;
}

export function parseSessionTextLines(rawText: string): ParsedImportedSessionItem[] {
  const lines = rawText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const out: ParsedImportedSessionItem[] = [];

  lines.forEach((line, idx) => {
    if (line.startsWith('{') && line.endsWith('}')) {
      try {
        const obj = JSON.parse(line) as Record<string, unknown>;
        const sessionStr = String(obj.session ?? obj.session_string ?? obj.stringSession ?? '').trim();
        if (sessionStr.length >= 100) {
          out.push({
            id: `imp-${Date.now()}-${idx}`,
            label: String(obj.phone ?? obj.username ?? `导入账号 #${idx + 1}`),
            phone: typeof obj.phone === 'string' ? obj.phone : undefined,
            sessionString: sessionStr,
            twoFaPassword:
              typeof obj.twoFA === 'string'
                ? obj.twoFA
                : typeof obj.password === 'string'
                  ? obj.password
                  : undefined,
            dcId: typeof obj.dc_id === 'number' ? obj.dc_id : 2,
            deviceFingerprint: {
              deviceModel: String(obj.device_model ?? obj.device ?? DEFAULT_DEVICE_FINGERPRINT.deviceModel),
              systemVersion: String(obj.system_version ?? obj.sdk ?? DEFAULT_DEVICE_FINGERPRINT.systemVersion),
              appVersion: String(obj.app_version ?? DEFAULT_DEVICE_FINGERPRINT.appVersion),
              langCode: String(obj.lang_code ?? obj.lang_pack ?? DEFAULT_DEVICE_FINGERPRINT.langCode),
              systemLangCode: String(obj.system_lang_code ?? DEFAULT_DEVICE_FINGERPRINT.systemLangCode),
            },
          });
        }
      } catch {
        // ignore malformed JSON line
      }
      return;
    }

    const parts = line.split(/[:|,;\t]+|----/);
    const sessionCandidate = parts.find((p) => /^1[A-Za-z0-9+/=_-]{120,}$/.test(p.trim()))?.trim();
    if (sessionCandidate) {
      const phoneCandidate = parts.find((p) => /^\+?\d{7,15}$/.test(p.trim()))?.trim();
      out.push({
        id: `imp-${Date.now()}-${idx}`,
        label: phoneCandidate || `Session #${idx + 1}`,
        phone: phoneCandidate,
        sessionString: sessionCandidate,
        dcId: 2,
        deviceFingerprint: { ...DEFAULT_DEVICE_FINGERPRINT },
      });
    }
  });

  return out;
}

export async function parseSessionFiles(files: FileList | File[]): Promise<ParsedImportedSessionItem[]> {
  const fileArray = Array.from(files);
  const jsonByStem = new Map<string, Record<string, unknown>>();
  const sessionFiles: { stem: string; file: File }[] = [];

  for (const file of fileArray) {
    const lower = file.name.toLowerCase();
    const stem = file.name.replace(/\.(session|json|txt)$/i, '');
    if (lower.endsWith('.json')) {
      try {
        const text = await file.text();
        const parsed = JSON.parse(text) as Record<string, unknown>;
        jsonByStem.set(stem, parsed);
      } catch {
        // ignore invalid json
      }
    } else if (lower.endsWith('.session') || lower.endsWith('.txt')) {
      sessionFiles.push({ stem, file });
    }
  }

  const results: ParsedImportedSessionItem[] = [];

  for (const { stem, file } of sessionFiles) {
    const meta = jsonByStem.get(stem) ?? {};
    const fp: DeviceFingerprintProfile = {
      deviceModel: String(meta.device ?? meta.device_model ?? DEFAULT_DEVICE_FINGERPRINT.deviceModel),
      systemVersion: String(meta.sdk ?? meta.system_version ?? DEFAULT_DEVICE_FINGERPRINT.systemVersion),
      appVersion: String(meta.app_version ?? DEFAULT_DEVICE_FINGERPRINT.appVersion),
      langCode: String(meta.lang_pack ?? meta.lang_code ?? DEFAULT_DEVICE_FINGERPRINT.langCode),
      systemLangCode: String(meta.system_lang_pack ?? meta.system_lang_code ?? DEFAULT_DEVICE_FINGERPRINT.systemLangCode),
    };
    const twoFa =
      typeof meta.twoFA === 'string'
        ? meta.twoFA
        : typeof meta.password === 'string'
          ? meta.password
          : undefined;
    const phone = typeof meta.phone === 'string' ? meta.phone : /^\+?\d{7,15}$/.test(stem) ? stem : undefined;

    const ab = await file.arrayBuffer();
    const bytes = new Uint8Array(ab);
    const sqliteExtracted = extractFromSqliteBytes(bytes);

    if (sqliteExtracted) {
      const dcInfo = DEFAULT_DC_IPV4[sqliteExtracted.dcId] ?? DEFAULT_DC_IPV4[2]!;
      const encoded = encodeGramJsStringSession(
        sqliteExtracted.dcId,
        dcInfo.ip,
        dcInfo.port,
        sqliteExtracted.authKey,
      );
      results.push({
        id: `file-${stem}-${Date.now()}`,
        label: phone ? `+${phone.replace(/^\+/, '')}` : stem,
        phone,
        sessionString: encoded,
        twoFaPassword: twoFa,
        dcId: sqliteExtracted.dcId,
        deviceFingerprint: fp,
      });
    } else {
      const text = new TextDecoder().decode(bytes).trim();
      const fromLines = parseSessionTextLines(text);
      for (const item of fromLines) {
        item.deviceFingerprint = fp;
        if (twoFa) item.twoFaPassword = twoFa;
        if (phone && !item.phone) {
          item.phone = phone;
          item.label = `+${phone.replace(/^\+/, '')}`;
        }
        results.push(item);
      }
    }
    jsonByStem.delete(stem);
  }

  for (const [stem, meta] of jsonByStem.entries()) {
    const sessionStr = String(meta.session ?? meta.session_string ?? meta.stringSession ?? '').trim();
    if (sessionStr.length >= 100) {
      const phone = typeof meta.phone === 'string' ? meta.phone : stem;
      results.push({
        id: `json-${stem}-${Date.now()}`,
        label: phone,
        phone,
        sessionString: sessionStr,
        twoFaPassword: typeof meta.twoFA === 'string' ? meta.twoFA : undefined,
        dcId: typeof meta.dc_id === 'number' ? meta.dc_id : 2,
        deviceFingerprint: {
          deviceModel: String(meta.device ?? meta.device_model ?? DEFAULT_DEVICE_FINGERPRINT.deviceModel),
          systemVersion: String(meta.sdk ?? meta.system_version ?? DEFAULT_DEVICE_FINGERPRINT.systemVersion),
          appVersion: String(meta.app_version ?? DEFAULT_DEVICE_FINGERPRINT.appVersion),
          langCode: String(meta.lang_pack ?? meta.lang_code ?? DEFAULT_DEVICE_FINGERPRINT.langCode),
          systemLangCode: String(meta.system_lang_pack ?? meta.system_lang_code ?? DEFAULT_DEVICE_FINGERPRINT.systemLangCode),
        },
      });
    }
  }

  return results;
}
