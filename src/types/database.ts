/**
 * 跨端数据层类型定义（Web / Electron / Capacitor 共用）
 * ------------------------------------------------------------
 * 这些声明描述的是「宿主环境向网页注入的桥接 API」：
 * Electron 主进程会挂 window.sqliteAPI（better-sqlite3），
 * 网页端则降级为 localStorage。因此这里的接口字段要与 electron/ 侧实现保持一致。
 */

/** 一条归档记录（对应 SQLite 里的 archives 表） */
export interface ArchiveItem {
  id: number;
  title: string;
  category: string;
  content: string;
  /** 数据库里以 JSON 字符串存储，前端取用前需要 JSON.parse */
  tags: string[];
  created_at: string;
  updated_at: string;
}

/** 当前运行环境信息（由宿主进程返回，Web 端返回降级描述） */
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
  /** 失败原因（原样展示给开发者面板，不向普通用户暴露） */
  error?: string;
}

/** 写操作的返回结果：影响行数与自增主键 */
export interface SqliteRunResult {
  success: boolean;
  changes?: number;
  lastInsertRowid?: number;
  error?: string;
}

/** 宿主注入到 window 上的 SQLite 桥接对象（仅 Electron 存在） */
export interface SqliteAPI {
  /** 执行 DDL / 多语句，不返回数据行 */
  execute(sql: string): Promise<{ success: boolean; error?: string }>;
  /** 查询，返回多行 */
  query<T = unknown>(sql: string, params?: unknown[]): Promise<SqliteQueryResult<T>>;
  /** 写入，返回影响行数 */
  run(sql: string, params?: unknown[]): Promise<SqliteRunResult>;
  /** 读取平台信息（路径、版本号） */
  getPlatformInfo(): Promise<PlatformInfo>;
}

// 扩展全局 Window：让 window.sqliteAPI / window.Capacitor 在 TS 中有类型
declare global {
  interface Window {
    sqliteAPI?: SqliteAPI;
    Capacitor?: unknown;
  }
}
