// Execute Capacitor Electron bridge first
try {
  require('@capawesome/capacitor-electron/dist/preload/index.js');
} catch (e) {
  console.warn('[Preload] Failed to load @capawesome/capacitor-electron preload bridge:', e);
}

import { contextBridge, ipcRenderer } from 'electron';

// Expose safe better-sqlite3 API to renderer process
contextBridge.exposeInMainWorld('sqliteAPI', {
  execute: (sql: string) => ipcRenderer.invoke('sqlite:execute', sql),
  query: (sql: string, params?: unknown[]) => ipcRenderer.invoke('sqlite:query', sql, params),
  run: (sql: string, params?: unknown[]) => ipcRenderer.invoke('sqlite:run', sql, params),
  getPlatformInfo: () => ipcRenderer.invoke('app:get-platform-info'),
});
