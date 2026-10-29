import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    vue(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  server: {
    // 本地开发时前端由 Vite 提供，/api 代理到同一 Worker 的本地实例
    proxy: {
      '/api': 'http://127.0.0.1:8787',
    },
  },
})
