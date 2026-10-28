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
├── scripts/
│   ├── platform.mjs           # 跨平台策略与打包入口（info / doctor / pack）
│   └── cloud-build-ios.mjs    # iOS 云端构建流水线
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

### 6. 一键触发 iOS 云端编译与签名打包 (生成 .ipa)
无需频繁触发 Git CI，支持本地命令手动触发，实时回传编译日志并自动下载 IPA：
```bash
pnpm ios:cloud-build
```
- **自动化特性**：
  - 自动检测并推送本地更改至远端。
  - 自动触发 GitHub Actions 云端 macOS 虚拟机构建与苹果原生签名。
  - 控制台**实时流式输出**构建进度与阶段状态。
  - 构建完成后**自动将完整日志写入 `logs/` 目录**（失败时突出显示关键堆栈）。
  - 成功时**自动将 `.ipa` 下载至本地 `dist-ios/` 目录**。

---

## 🧭 跨平台（macOS / Windows）

同一个人在 macOS 与 Windows 上开发，所有「跟系统有关」的判断集中在 **`scripts/platform.mjs`** 一个文件里，不再散落 `if (process.platform === 'win32')`。

```bash
pnpm install          # preinstall 自动生成 pnpm 策略，postinstall 再装 electron/ 子工程
pnpm platform:doctor  # 换机器 / 系统升级后先跑自检
```

| 命令 | 说明 |
| --- | --- |
| `pnpm platform:info` | 当前系统解析出的策略：放行脚本 / better-sqlite3 / 本机打包参数 |
| `pnpm platform:doctor` | 环境自检（Node / pnpm / 策略文件 / electron / sqlite 加载 / 工具链 / 打包器），✗ 时非 0 退出 |
| `pnpm platform:sync-policy` | 重新生成 `electron/pnpm-workspace.yaml`（一般由 preinstall 自动做）|
| `pnpm electron:pack[:mac\|win\|linux]` | 打包，自动拼装 electron-builder 参数（`-- --dry-run` 只打印计划，`-- --arch=x64` 指定架构，`-- --skip-web` 跳过前端构建）|

它实际按系统切换的东西：

| | macOS | Windows |
| --- | --- | --- |
| 打包目标 | `dmg + zip`（可 `--arch=universal`）| `nsis + portable` |
| 交叉打包 | 打 Windows 包需 wine | 无法打 macOS 包（签名/公证依赖 macOS）|
| 原生模块重编译 | 依据是否存在 Node-API 预编译产物判定（13.x 无需重编译）| 同左 |
| 本地 iOS 同步 | 可用 | 不可用（云端构建仍可触发）|

**关于安装脚本放行（`allowBuilds`）为什么不分系统**：pnpm 在启动时就加载 `pnpm-workspace.yaml`，之后才跑 `preinstall`，所以脚本无法为「本次安装」切换配置；而仓库只能提交一份文件。`electron-winstaller` 的脚本只是按宿主架构拷贝 7z 二进制（纯 `copyFile`，无编译，两端实测安全），因此统一放行，保证哪个平台首次 `pnpm install` 都不会因 `ERR_PNPM_IGNORED_BUILDS` 失败。

> ⚠️ 新增带安装脚本的依赖时，先确认它在两个平台都安全；否则就不能再统一放行，需改为按平台生成且该文件不再提交。

---

## 💡 架构设计亮点

1. **双环境自适应（Isomorphic Fallback）**：
   `src/services/database.ts` 会自动探测当前环境。在 Electron 环境下调用真实的本地 SQLite 数据库文件（位于系统用户数据目录）；在浏览器单纯启动 `pnpm dev` 时自动无缝回退到轻量本地模拟层，避免开发时报错。
2. **安全隔离（Sandbox & Context Isolation）**：
   遵守 Electron 最新安全规范，主进程与渲染进程严格隔离，无 Node 原生注入风险，通过 `preload.ts` 对接。
3. **原生 C++ 模块与 Electron ABI**：
   `better-sqlite3` 自 13.x 起改为 Node-API 预编译产物（`prebuilds/<platform>-<arch>.node`），
   与 Electron ABI 无关，因此无需重编译即被主进程加载；`@electron/rebuild` 保留为兜底，
   `pnpm platform:doctor` 会在缺少对应预编译产物时提示执行 `pnpm electron:rebuild-sqlite`。
4. **跨平台一致性**：
   安装脚本放行、原生模块重编译判定、打包目标与架构统一由 `scripts/platform.mjs`
   决策，macOS 与 Windows 使用同一套命令（见上文「跨平台」）。
