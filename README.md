# Lattice Archive

基于 **Capacitor + Electron** 架构打造的跨平台现代化桌面应用项目。

---

## 🛠 技术栈组成

- **跨平台桥接 (Cross-Platform Bridge)**: [Capacitor](https://capacitorjs.com/) (`@capacitor/core`, `@capacitor/cli`)
- **桌面运行平台 (Desktop Platform)**: [`@capawesome/capacitor-electron`](https://capawesome.io/docs/sdks/capacitor/electron)
- **前端框架 (Frontend Framework)**: [Vue 3](https://vuejs.org/) + [TypeScript](https://www.typescriptlang.org/) + [Vite](https://vite.dev/)
- **UI 体系 (UI Components & Styling)**: [shadcn-vue](https://shadcn-vue.com/) + [Tailwind CSS v4](https://tailwindcss.com/)
- **全局状态管理 (State Management)**: [Pinia](https://pinia.vuejs.org/)
- **本地嵌入式数据库 (Local Database)**: [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3)（启用 WAL 模式，集成于 Electron 主进程并通过安全的 IPC/Preload 桥接）

---

## 📁 目录架构

```text
lattice-archive/
├── capacitor.config.ts        # Capacitor 根配置
├── components.json            # shadcn-vue 组件配置
├── package.json               # 根项目依赖与运行脚本
├── electron/                  # Electron 桌面端主工程
│   ├── main.ts                # Electron 主进程入口与 IPC 处理
│   ├── preload.ts             # Preload 安全上下文桥接脚本
│   ├── db.ts                  # better-sqlite3 数据库连接与表结构初始化
│   ├── capacitor.electron.config.ts # 桌面窗口、深度链接、托盘与生命周期配置
│   ├── electron-builder.config.js   # 桌面安装包分发打包配置
│   └── package.json           # Electron 独立运行时依赖
├── src/                       # Vue 3 前端工程
│   ├── components/ui/         # shadcn-vue 原子 UI 组件库
│   ├── services/database.ts   # 统一数据库服务 (含 Electron 与 Web Fallback)
│   ├── stores/archive.ts      # Pinia 状态 Store
│   ├── types/database.ts      # 数据库与 IPC 类型定义
│   ├── App.vue                # 现代化归档系统前端界面
│   ├── main.ts                # Vue 初始化入口
│   └── style.css              # Tailwind CSS v4 与设计 Token
```

---

## 🚀 常用开发命令

### 1. 启动 Web 前端开发服务器
可在浏览器中直接快速调试界面与交互，内置智能 Web 模式 Fallback：
```bash
pnpm dev
```

### 2. 构建并同步到 Electron 平台
每次前端构建产物更新后同步到桌面端平台：
```bash
pnpm build
pnpm cap:sync
```

### 3. 运行 Electron 桌面端
以桌面窗口启动运行：
```bash
# 方式 A：使用预设脚本
pnpm electron:build
pnpm electron:run

# 方式 B：直接进入 electron 启动
cd electron && pnpm start
```

### 4. 重新编译 better-sqlite3（当 Electron 版本变动时）
当 Electron 版本更新或在不同平台环境下：
```bash
pnpm electron:rebuild-sqlite
```

### 5. 打包桌面端发布安装包 (.exe / .dmg / .deb)
```bash
pnpm electron:pack
```

---

## 💡 架构设计亮点

1. **双环境自适应（Isomorphic Fallback）**：
   `src/services/database.ts` 会自动探测当前环境。在 Electron 环境下调用真实的本地 SQLite 数据库文件（位于系统用户数据目录）；在浏览器单纯启动 `pnpm dev` 时自动无缝回退到轻量本地模拟层，避免开发时报错。
2. **安全隔离（Sandbox & Context Isolation）**：
   遵守 Electron 最新安全规范，主进程与渲染进程严格隔离，无 Node 原生注入风险，通过 `preload.ts` 对接。
3. **原生 C++ 模块针对 Electron ABI 构建**：
   已配置 `@electron/rebuild`，解决 Windows / Node.js 22 环境下 `better-sqlite3` 与 Electron 的 ABI 兼容编译问题。
