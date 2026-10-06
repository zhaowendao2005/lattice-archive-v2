import type { ArchiveItem, PlatformInfo, SqliteQueryResult, SqliteRunResult } from '../types/database';

class DatabaseService {
  private isElectron = typeof window !== 'undefined' && !!window.sqliteAPI;

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

  async getAllArchives(): Promise<ArchiveItem[]> {
    if (this.isElectron && window.sqliteAPI) {
      const res = await window.sqliteAPI.query<any>(
        'SELECT * FROM archives ORDER BY id DESC'
      );
      if (res.success && res.data) {
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

    // Web Fallback
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

  async deleteArchive(id: number): Promise<boolean> {
    if (this.isElectron && window.sqliteAPI) {
      const res = await window.sqliteAPI.run('DELETE FROM archives WHERE id = ?', [id]);
      return !!res.success;
    }

    const list = this.getMockArchives().filter(a => a.id !== id);
    localStorage.setItem('mock_lattice_archives', JSON.stringify(list));
    return true;
  }

  async rawQuery(sql: string, params: unknown[] = []): Promise<SqliteQueryResult<unknown>> {
    if (this.isElectron && window.sqliteAPI) {
      return await window.sqliteAPI.query(sql, params);
    }
    return {
      success: true,
      data: this.getMockArchives(),
    };
  }

  async rawExecute(sql: string): Promise<SqliteRunResult> {
    if (this.isElectron && window.sqliteAPI) {
      return await window.sqliteAPI.execute(sql);
    }
    return {
      success: true,
      changes: 1,
    };
  }

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
