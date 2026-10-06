import path from 'path';
import { app, ipcMain } from 'electron';
import { createCapacitorElectronApp } from '@capawesome/capacitor-electron';
import config from './capacitor.electron.config';
import { getDatabase } from './db';

// Register IPC handlers for better-sqlite3
ipcMain.handle('sqlite:execute', async (_event, sql: string) => {
  try {
    const db = getDatabase();
    db.exec(sql);
    return { success: true };
  } catch (error: any) {
    console.error('[IPC sqlite:execute error]', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('sqlite:query', async (_event, sql: string, params: unknown[] = []) => {
  try {
    const db = getDatabase();
    const stmt = db.prepare(sql);
    const rows = stmt.all(...params);
    return { success: true, data: rows };
  } catch (error: any) {
    console.error('[IPC sqlite:query error]', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('sqlite:run', async (_event, sql: string, params: unknown[] = []) => {
  try {
    const db = getDatabase();
    const stmt = db.prepare(sql);
    const result = stmt.run(...params);
    return {
      success: true,
      changes: result.changes,
      lastInsertRowid: Number(result.lastInsertRowid),
    };
  } catch (error: any) {
    console.error('[IPC sqlite:run error]', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('app:get-platform-info', async () => {
  return {
    isElectron: true,
    platform: process.platform,
    versions: {
      node: process.versions.node,
      electron: process.versions.electron,
      chrome: process.versions.chrome,
    },
    dbPath: path.join(app.getPath('userData'), 'lattice_archive.db'),
  };
});

// Start the Capacitor Electron platform application
createCapacitorElectronApp(config);
