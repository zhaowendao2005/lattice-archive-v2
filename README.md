# Lattice Archive

基于 **Capacitor + Electron** 架构打造的跨平台现代化桌面应用项目。

---

## 🛠 技术栈组成

- **跨平台桥接 (Cross-Platform Bridge)**: [Capacitor](https://capacitorjs.com/) (`@capacitor/core`, `@capacitor/cli`)
- **桌面运行平台 (Desktop Platform)**: [`@capawesome/capacitor-electron`](https://capawesome.io/docs/sdks/capacitor/electron)
- **前端框架 (Frontend Framework)**: [Vue 3](https://vuejs.org/) + [TypeScript](https://www.typescriptlang.org/) + [Vite](https://vite.dev/)
- **UI 体系 (UI Components & Styling)**: [shadcn-vue](https://shadcn-vue.com/) + [Tailwind CSS v4](https://tailwindcss.com/)
- **高性能管理表格 (Admin Data Grid)**: [VXE-Table](https://vxetable.cn/)（服务端搜索/分页/排序、固定操作列、路由级按需加载）
- **全局状态管理 (State Management)**: [Pinia](https://pinia.vuejs.org/)
- **本地嵌入式数据库 (Local Database)**: [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3)（启用 WAL 模式，集成于 Electron 主进程并通过安全的 IPC/Preload 桥接）
- **远端聚合服务 (Remote Backend)**: Cloudflare Worker（同源托管前端静态资源 + `/api/auth/*` + `/api/admin/*`）+ D1 + Turnstile，启用结构化 Logs/Traces

---

## 📁 目录架构

```text
lattice-archive/
├── AGENTS.md                  # 面向 AI/协作者的仓库入口说明
├── .rules/                    # 强制性架构规范（前端/状态/设计/远端 Worker）
├── capacitor.config.ts        # Capacitor 根配置
├── components.json            # shadcn-vue 组件配置
├── deploy.config.json         # 远端 D1 部署模式（rebuild / migrate）
├── package.json               # 根项目依赖与运行脚本
├── scripts/
│   ├── deploy.mjs             # 一键部署编排（构建 → D1 模式 → Worker 发布）
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
│   ├── router/                # 路由表与守卫（含远端会话握手）
│   ├── services/database.ts   # 统一数据库服务 (含 Electron 与 Web Fallback)
│   ├── stores/                # Pinia 业务域（每域三层：data-sources / stores / mocks）
│   │   ├── auth/              # 鉴权域：远端 API、会话持久化、Turnstile 桥接
│   │   └── admin/             # 管理域：用户列表、搜索分页、增删弹窗状态
│   ├── views/                 # 页面与视图（零本地 ref）
│   │   ├── auth/              # 用户登录 / 注册 / TurnstileWidget
│   │   └── admin/             # 管理员登录 / 概览 / VXE 用户管理
│   ├── worker/remote/         # Cloudflare Worker：静态资源 + /api/auth/* + /api/admin/*
│   │   ├── auth/              # routes / service / repository / crypto / turnstile
│   │   ├── admin/             # 管理员鉴权与用户增删查
│   │   ├── shared/            # JSON 响应、CORS、结构化日志
│   │   ├── migrations/        # D1 schema 迁移
│   │   └── wrangler.jsonc     # Worker 配置（ASSETS + D1 + Turnstile）
│   ├── App.vue                # 应用外壳
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
5. **鉴权与建连（Auth & Session Handshake）**：
   登录 / 注册 / 管理员登录均先通过 Turnstile 服务端校验，再执行 PBKDF2 密码比对；
   会话只落库 Token 的 SHA-256 摘要，客户端冷启动时由路由守卫向 `/api/auth/session/connect`
   握手确认有效性，失效即静默清理并打回登录页。规则见 `.rules/remote-worker.md`。
6. **管理员用户管理（Admin User Lifecycle）**：
   `/admin/users` 是管理面板第一模块，VXE-Table 通过 `/api/admin/users` 完成真实 D1 用户搜索、分页、新增与删除；
   管理接口逐次验证远端管理员会话，删除用户时原子清理其远端会话，不返回密码哈希等敏感字段。

---

## ☁️ 远端聚合服务器（单个 Worker：前端 + API）

前端静态资源与 `/api/auth/*`、`/api/admin/*` 由**同一个 Worker** 提供，不依赖 Pages：

- 生产地址：`https://lattice-v2.zhaowendao2005.workers.dev`
- 配置：`src/worker/remote/wrangler.jsonc`（`assets.directory = ../../../dist`，`/api/*` 优先进入 Worker，其余路径回退 SPA）
- 数据：Cloudflare D1 `lattice-v2-d1`（`users` / `sessions`）

| 命令 | 作用 |
| --- | --- |
| `pnpm worker:migrate:local` / `worker:migrate:remote` | 应用 D1 迁移 |
| `pnpm worker:dev` | 本地 Worker（`local` 环境，允许 `localhost` hostname） |
| `pnpm dev` | Vite 开发服务器，`/api` 自动代理到 `127.0.0.1:8787` |
| `pnpm worker:types` | 由 Wrangler 生成 `Env` 绑定类型 |
| `pnpm deploy` | 一键部署：自动构建 → 按当前模式处理远端 D1 → 随 Worker 发布 |
| `pnpm deploy:rebuild` | 强制重建模式部署 |
| `pnpm deploy:migrate` | 强制迁移模式部署 |

本地密钥放在 `src/worker/remote/.dev.vars`（已忽略），生产密钥用 `wrangler secret put TURNSTILE_SECRET` 管理；前端 Sitekey 通过 `VITE_TURNSTILE_SITEKEY` 注入。

### 管理员账户配置（部署时自动同步）

管理员凭证在 `src/worker/remote/.dev.vars` 中配置，模板见 `src/worker/remote/.dev.vars.example`：

```dotenv
TURNSTILE_SECRET=...
ADMIN_EMAIL=operator@lattice.dev
ADMIN_PASSWORD=至少 8 位的强密码
ADMIN_NAME=System Operator
```

- `pnpm deploy` / `deploy:rebuild` / `deploy:migrate` 都会在数据库就绪后，用 `ADMIN_EMAIL` + `ADMIN_PASSWORD` 生成 PBKDF2 哈希并 **upsert 管理员账户**（改密码后重新部署即可生效）；
- `ADMIN_*` 只被部署脚本读取，**不会**上传为 Worker Secret（部署时自动过滤，仅上传 `TURNSTILE_SECRET` 等运行时密钥）；
- 本地开发库可单独播种：`pnpm worker:seed:local`；
- 部署脚本会校验 `.dev.vars` 必须包含 `TURNSTILE_SECRET`，缺失时立即中止（避免把空/旧密钥带上线）；
- 预览而不执行：`node scripts/deploy.mjs --mode=rebuild --dry-run`（会跳过种子与部署）。

> ⚠️ `.dev.vars` 含明文密码，已由 `.gitignore` 排除；**不要**把真实值写进 `.dev.vars.example` 或提交历史。

### 用户管理（管理员面板第一模块）

管理员登录后默认进入 `/admin/users`，可通过 VXE-Table 管理远端普通用户：

- 按用户名或邮箱搜索，服务端分页（20 / 50 / 100 条）及用户名、邮箱、创建时间排序；
- 通过弹窗新增普通用户，沿用 PBKDF2 密码存储，不切换当前管理员会话；
- 二次确认后删除用户及其全部远端会话；管理员账户不会出现在可操作列表中；
- 删除只影响远端账户和会话，不会清除用户设备上的本地归档。

| 接口 | 用途 |
| --- | --- |
| `GET /api/admin/users?page=1&pageSize=20&search=...&sort=created_at&direction=desc` | 查询普通用户 |
| `POST /api/admin/users` | 新增普通用户（`name` / `email` / `password`） |
| `DELETE /api/admin/users/:id` | 删除普通用户及其会话 |

以上接口都要求 `Authorization: Bearer <session-token>` 并在服务端逐次校验管理员角色。该功能复用现有 `users` / `sessions` 表，无需新增迁移；部署时应使用 `pnpm deploy:migrate` 保留线上数据。

### 远端 D1 的两种部署模式

`pnpm deploy` 每次都会先执行完整构建，再按当前模式处理远端数据库，最后部署 Worker。
模式由根目录 `deploy.config.json` 的 `d1Mode` 决定（也可用命令参数或环境变量临时覆盖）：

```json
{
  "d1Mode": "rebuild",
  "databaseName": "lattice-v2-d1",
  "rebuildLocation": "apac"
}
```

| 模式 | 行为 | 数据 | 适用场景 |
| --- | --- | --- | --- |
| `rebuild`（当前默认） | 删除远端 D1 → 按迁移模板重新创建 → 回写新的 `database_id` → 应用迁移 | **全部清空，不迁移** | 结构大改、希望从零开始，或按需重置数据库 |
| `migrate` | 只执行尚未应用的迁移 | 保留 | 日常迭代、线上已有真实用户数据 |

切换方式（任选其一，优先级从高到低）：

```bash
pnpm deploy:rebuild          # 本次强制重建
pnpm deploy:migrate          # 本次强制迁移
D1_MODE=migrate pnpm deploy  # 环境变量覆盖
# 或直接修改 deploy.config.json 里的 d1Mode
```

> ⚠️ 重建模式会永久删除 `lattice-v2-d1` 的所有账户与会话（含管理员账户），并生成新的数据库 ID，脚本会自动把新 ID 写回 `src/worker/remote/wrangler.jsonc`（该文件会因此产生 diff）。仅在明确需要重置时使用。
>
> 只想预览流程而不执行破坏性操作时，可运行 `node scripts/deploy.mjs --mode=rebuild --dry-run`。
