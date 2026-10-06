export interface ArchiveItem {
  id: number;
  title: string;
  category: string;
  content: string;
  tags: string[];
  created_at: string;
  updated_at: string;
}

export interface PlatformInfo {
  isElectron: boolean;
  platform?: string;
  versions?: {
    node?: string;
    electron?: string;
    chrome?: string;
  };
  dbPath?: string;
}

export interface SqliteQueryResult<T = unknown> {
  success: boolean;
  data?: T[];
  error?: string;
}

export interface SqliteRunResult {
  success: boolean;
  changes?: number;
  lastInsertRowid?: number;
  error?: string;
}

export interface SqliteAPI {
  execute(sql: string): Promise<{ success: boolean; error?: string }>;
  query<T = unknown>(sql: string, params?: unknown[]): Promise<SqliteQueryResult<T>>;
  run(sql: string, params?: unknown[]): Promise<SqliteRunResult>;
  getPlatformInfo(): Promise<PlatformInfo>;
}

declare global {
  interface Window {
    sqliteAPI?: SqliteAPI;
    Capacitor?: unknown;
  }
}
