/**
 * ============================================================================
 * 数据库服务（单例）—— 宿主 SQLite 与浏览器降级实现的统一外壳
 * ============================================================================
 * 调用方（Store）只见 dbService 的几个方法，不关心当前跑在哪：
 *   · Electron：走 window.sqliteAPI（主进程 better-sqlite3，WAL 模式）；
 *   · 浏览器 / 未注入桥接：走 localStorage 的 mock 数据，保证 UI 可跑通。
 *
 * 注意：archives 表来自早期原型，当前业务主体（聊天 / 归档瓦片）
 * 走各自 data-sources 里的存储实现，不要在此无脑堆业务表。
 */
import type { ArchiveItem, PlatformInfo, SqliteQueryResult, SqliteRunResult } from '../../../types/database';

class DatabaseService {
  /** 启动时探测一次：window.sqliteAPI 存在即视为 Electron 宿主 */
  private isElectron = typeof window !== 'undefined' && !!window.sqliteAPI;

  /** 获取平台信息：Electron 透传主进程结果，Web 返回一段写死的降级描述 */
  async getPlatformInfo(): Promise<PlatformInfo> {
    if (this.isElectron && window.sqliteAPI) {
      return await window.sqliteAPI.getPlatformInfo();
    }
    return {
      isElectron: false,
      platform: 'browser',
      versions: {
        node: 'Web Sandbox',
        electron: 'N/A (Web Fallback)',
        chrome: navigator.userAgent.includes('Chrome') ? 'Browser' : 'Unknown',
      },
      dbPath: 'localStorage (Web Fallback)',
    };
  }

  /** 列出全部归档（按 id 倒序，最新在前） */
  async getAllArchives(): Promise<ArchiveItem[]> {
    if (this.isElectron && window.sqliteAPI) {
      // 泛型用 any：数据库原始行与 ArchiveItem 形状不同（tags 是字符串）
      const res = await window.sqliteAPI.query<any>(
        'SELECT * FROM archives ORDER BY id DESC'
      );
      if (res.success && res.data) {
        // 把 SQLite 里的 tags 字符串还原成数组，对上层屏蔽存储差异
        return res.data.map(row => ({
          ...row,
          tags: typeof row.tags === 'string' ? JSON.parse(row.tags || '[]') : row.tags,
        }));
      }
      throw new Error(res.error || 'Failed to query archives');
    }

    // Web Fallback: localStorage
    return this.getMockArchives();
  }

  /** 新建归档，返回新记录的自增 id */
  async createArchive(item: Omit<ArchiveItem, 'id' | 'created_at' | 'updated_at'>): Promise<number> {
    const tagsJson = JSON.stringify(item.tags || []);
    if (this.isElectron && window.sqliteAPI) {
      const res = await window.sqliteAPI.run(
        'INSERT INTO archives (title, category, content, tags) VALUES (?, ?, ?, ?)',
        [item.title, item.category, item.content, tagsJson]
      );
      if (res.success && res.lastInsertRowid) {
        return res.lastInsertRowid;
      }
      throw new Error(res.error || 'Failed to create archive');
    }

    // Web 降级：在 localStorage 数组上手工模拟自增 id 与时间戳
    const list = this.getMockArchives();
    const newId = list.length > 0 ? Math.max(...list.map(a => a.id)) + 1 : 1;
    const now = new Date().toISOString();
    const newArchive: ArchiveItem = {
      id: newId,
      title: item.title,
      category: item.category,
      content: item.content,
      tags: item.tags,
      created_at: now,
      updated_at: now,
    };
    list.unshift(newArchive);
    localStorage.setItem('mock_lattice_archives', JSON.stringify(list));
    return newId;
  }

  /** 删除归档：宿主返回成功/失败；Web 端仅做本地数组过滤 */
  async deleteArchive(id: number): Promise<boolean> {
    if (this.isElectron && window.sqliteAPI) {
      const res = await window.sqliteAPI.run('DELETE FROM archives WHERE id = ?', [id]);
      return !!res.success;
    }

    const list = this.getMockArchives().filter(a => a.id !== id);
    localStorage.setItem('mock_lattice_archives', JSON.stringify(list));
    return true;
  }

  /** 开发者面板用：透传任意只读 SQL */
  async rawQuery(sql: string, params: unknown[] = []): Promise<SqliteQueryResult<unknown>> {
    if (this.isElectron && window.sqliteAPI) {
      return await window.sqliteAPI.query(sql, params);
    }
    return {
      success: true,
      data: this.getMockArchives(),
    };
  }

  /** 开发者面板用：透传任意写 SQL / DDL */
  async rawExecute(sql: string): Promise<SqliteRunResult> {
    if (this.isElectron && window.sqliteAPI) {
      return await window.sqliteAPI.execute(sql);
    }
    return {
      success: true,
      changes: 1,
    };
  }

  /**
   * Web 降级数据源：读 localStorage 的 mock_lattice_archives；
   * 首次访问时写入三条示例记录，避免空列表无法演示界面。
   */
  private getMockArchives(): ArchiveItem[] {
    const raw = localStorage.getItem('mock_lattice_archives');
    if (raw) {
      try {
        return JSON.parse(raw);
      } catch {
        // fallback
      }
    }
    const initial: ArchiveItem[] = [
      {
        id: 1,
        title: 'Quantum Lattice Simulation v1',
        category: 'Research',
        content: 'Initial quantum crystal lattice parameter data and simulation matrix results.',
        tags: ['quantum', 'simulation', 'physics'],
        created_at: '2026-10-07 00:00:00',
        updated_at: '2026-10-07 00:00:00',
      },
      {
        id: 2,
        title: 'System Architecture Blueprint',
        category: 'Design',
        content: 'Capacitor + Electron + Vue 3 + Tailwind CSS + Better-SQLite3 integrated design documentation.',
        tags: ['architecture', 'desktop', 'mobile'],
        created_at: '2026-10-07 00:05:00',
        updated_at: '2026-10-07 00:05:00',
      },
      {
        id: 3,
        title: 'Optical Diffraction Measurement',
        category: 'Experiment',
        content: 'Recorded photon beam diffraction patterns across the sub-micron lattice grid.',
        tags: ['optics', 'data', 'laser'],
        created_at: '2026-10-07 00:10:00',
        updated_at: '2026-10-07 00:10:00',
      },
    ];
    localStorage.setItem('mock_lattice_archives', JSON.stringify(initial));
    return initial;
  }
}

export const dbService = new DatabaseService();
