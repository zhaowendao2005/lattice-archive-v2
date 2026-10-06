import path from 'path';
import { BrowserWindow } from 'electron';
import { defineConfig } from '@capawesome/capacitor-electron/config';

export default defineConfig({
  window: {
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: 'default',
  },
  hooks: {
    windowFactory: (options) => {
      // Connect our custom preload script that wraps Capacitor bridge and adds safe sqliteAPI
      const customOptions = {
        ...options,
        webPreferences: {
          ...options.webPreferences,
          preload: path.join(__dirname, 'build/preload.js'),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: false,
        },
      };
      return new BrowserWindow(customOptions);
    },
  },
});
