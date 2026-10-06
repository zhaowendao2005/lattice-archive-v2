import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.example.latticearchive',
  appName: 'lattice-archive',
  webDir: 'dist',
  server: {
    url: process.env.CAPACITOR_DEV_SERVER_URL,
    cleartext: true,
  },
};

export default config;
