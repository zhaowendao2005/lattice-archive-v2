/** Shared local-session import DTOs used by the archive Store and local Worker. */
export interface DeviceFingerprintProfile {
  deviceModel: string;
  systemVersion: string;
  appVersion: string;
  langCode: string;
  systemLangCode: string;
}

export interface ParsedImportedSessionItem {
  id: string;
  label: string;
  phone?: string;
  sessionString: string;
  twoFaPassword?: string;
  dcId: number;
  deviceFingerprint: DeviceFingerprintProfile;
}

export interface SessionBatchFilePayload {
  name: string;
  type: string;
  lastModified: number;
  bytes: ArrayBuffer;
}

export type SessionBatchParseRequest =
  | { mode: 'text'; rawText: string }
  | { mode: 'files'; files: SessionBatchFilePayload[] };
