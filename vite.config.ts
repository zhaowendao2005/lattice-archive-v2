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
      // GramJS 的 inspect.js 在模块求值阶段就要用 util.inspect.custom，
      // Node 内置模块在浏览器构建里会被外部化成空壳，必须替身。
      util: path.resolve(import.meta.dirname, './src/worker/local/stubs/util.ts'),
      // GramJS 会静态打包 Node 专用传输层（socks / net）与 node-localstorage，
      // 它们在浏览器里永远不会被调到，但模块求值阶段就会因为 events / fs 是空壳而报错。
      socks: path.resolve(import.meta.dirname, './src/worker/local/stubs/socks.ts'),
      net: path.resolve(import.meta.dirname, './src/worker/local/stubs/node-net.ts'),
      os: path.resolve(import.meta.dirname, './src/worker/local/stubs/node-os.ts'),
      crypto: path.resolve(import.meta.dirname, './src/worker/local/stubs/node-crypto.ts'),
      path: path.resolve(import.meta.dirname, './src/worker/local/stubs/node-path.ts'),
      'node-localstorage': path.resolve(import.meta.dirname, './src/worker/local/stubs/node-localstorage.ts'),
    },
  },
  server: {
    // 本地开发时前端由 Vite 提供，/api 代理到同一 Worker 的本地实例
    proxy: {
      '/api': 'http://127.0.0.1:8787',
    },
  },
})
