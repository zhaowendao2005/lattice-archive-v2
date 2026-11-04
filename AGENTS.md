# AGENTS.md

本文件是面向 AI / 协作者的仓库入口说明。**动手前先读本文件与 `.rules/` 下的规范**，冲突时以 `.rules/` 为准。

---

## 1. 项目概览

Lattice Archive v2：Vue 3 + TypeScript + Vite + Pinia + Tailwind CSS v4 的归档客户端，可运行在 Web / Electron / iOS；远端由**单个 Cloudflare Worker** 同时托管前端静态资源与 `/api/auth/*`、`/api/admin/*` 接口，数据存储在 Cloudflare D1。

- 生产地址：`https://lattice-v2.zhaowendao2005.workers.dev`
- Worker 名称：`lattice-v2`；数据库：`lattice-v2-d1`
- 远端代码：`src/worker/remote/`（配置 `wrangler.jsonc`、迁移 `migrations/`）

---

## 2. 常用命令

| 命令 | 作用 |
| --- | --- |
| `pnpm dev` | Vite 前端开发服务器，`/api` 代理到本机 Worker（`127.0.0.1:8787`） |
| `pnpm worker:dev` | 本地 Worker（`local` 环境，允许 `localhost` Turnstile hostname） |
| `pnpm build` | 架构检查 + 前端 + Worker 全量类型检查并构建到 `dist/` |
| `pnpm arch:check` | 架构边界检查（GramJS 边界、视图零 ref、禁止硬编码并发等，见 `scripts/check-architecture.mjs`） |
| `pnpm test:scheduler` | Telegram RequestScheduler 行为测试 |
| `pnpm test:bus` | 业务总线契约 / 路由 / Client / 监控映射一致性测试 |
| `pnpm worker:types` | 由 Wrangler 生成 `Env` 绑定类型（**禁止手写 Env**） |
| `pnpm worker:migrate:local` | 本地 D1 迁移 |
| `pnpm deploy` | 一键部署：自动构建 → 按 `deploy.config.json` 的 `d1Mode` 处理远端 D1 → 部署 Worker |
| `pnpm deploy:rebuild` | 强制重建模式（删除并重建远端库，**清空数据**） |
| `pnpm deploy:migrate` | 强制迁移模式（保留数据） |
| `pnpm worker:seed:local` | 用 `.dev.vars` 的 `ADMIN_*` 播种本地管理员 |

`node scripts/deploy.mjs --mode=rebuild --dry-run` 可预览重建流程而不执行破坏性操作。

---

## 3. 目录职责

```text
src/views/          # 纯表现层：零本地 ref/reactive
src/stores/         # Pinia 业务域，三层结构（严禁新建顶层 src/services/）：
  <domain>/data-sources/   # 薄桥接层（Thin Bridge）：仅转发调用至 local/remote Worker 或托管 DOM 句柄
  <domain>/stores/         # 唯一真相来源（SSOT）：响应式页面状态、getters、异步 actions，严禁跨 Store 复制状态
  <domain>/mocks/          # 仅未接线业务使用；接通真实服务后立即物理删除
src/worker/local/   # 本地 Web Worker 具体实现域（GramJS MTProto Gateway、PTS 状态机、Bot 按钮页码解析、批文件解析）
src/worker/remote/  # Cloudflare Worker 远端具体实现域：静态资源 + 认证/管理/同步/调试 API
  auth/             # routes → service → repository（crypto / turnstile 为基础设施）
  admin/            # 管理员鉴权与用户增删查（routes → service → repository）
  debug/            # 分片日志快照记录、Agent 密钥管理与四级渐进式查询 API（/api/debug/*）
  shared/           # JSON 响应、CORS、结构化日志
  migrations/       # D1 schema 迁移
scripts/deploy.mjs  # 部署编排（构建 + D1 模式 + 管理员播种 + wrangler deploy）
scripts/seed-admin.mjs # 由 .dev.vars 的 ADMIN_* 生成 PBKDF2 并 upsert 管理员
deploy.config.json  # 当前 D1 部署模式与库名
```

---

## 4. 硬性约束

1. **视图零本地 `ref` / `reactive`**：所有表单、加载态、错误态、一次性令牌都进 Store；DOM 句柄（如 Turnstile widgetId、终端滚动与时间轴滑轨容器）进 Data Source。
2. **三层解耦 / 薄桥接 / 唯一真相来源（SSOT）**：
   - 严禁新建 `src/services/` 层；具体业务实现统一放在 `src/worker/local/` 或 `src/worker/remote/`，Data Source 只做薄桥（Thin Bridge）；
   - 严禁跨 Store 复制状态再手动同步；视图不得直接 `fetch`；接通远端后必须删除 `DEFAULT_USER` 等 Mock 兜底。
3. **视觉令牌**：只用 `bg-card`、`text-foreground`、`border-border`、`text-destructive` 等语义类，禁止调色板色值与十六进制。
4. **主按钮不置灰**：不使用 `disabled` 表达可提交性；提交时校验、聚焦缺失项、展示中文错误。
5. **Telegram 总线与并发**：Telegram 数据只能经 `TelegramBusClient → BusRouter → 9 条业务总线 → RequestScheduler`；GramJS/RPC 不得越界；并发唯一来源为 `src/worker/local/telegram/contracts/concurrency.ts`，禁止硬编码或自建池，详见 `.rules/telegram-bus-and-concurrency.md`。
6. **远端安全**：
   - Turnstile 服务端校验 `success` + `action` + `hostname`，任何异常 fail-closed；
   - 密码使用 PBKDF2-HMAC-SHA256（25,000 次）+ 固定时间比较；账户不存在时也执行一次虚拟派生；
   - 会话只存 Token 的 SHA-256 摘要；普通用户与管理员凭证物理隔离，禁止公开管理员注册接口；
   - `/api/admin/*` 每次请求都必须在 D1 中重新验证会话及管理员角色；
   - 用户管理只创建、列出、删除普通用户；响应不得包含密码哈希/盐或会话 Token，删除用户必须同时清理其远端会话；
   - 管理员账户由 `.dev.vars` 的 `ADMIN_EMAIL` / `ADMIN_PASSWORD` / `ADMIN_NAME` 定义，部署时自动 upsert（模板见 `.dev.vars.example`）；`ADMIN_*` 不得上传为 Worker Secret；
   - 密钥只放 `.dev.vars`（已忽略）或 `wrangler secret`，**不得写入源码、配置或日志**。
7. **部署模式**：默认 `migrate` 会保留线上数据并只应用未执行迁移；只有明确需要清空数据库时才使用 `pnpm deploy:rebuild`。

---

## 5. 变更检查清单

- [ ] `src/views/**` 无 `ref` / `reactive`，无直接网络请求
- [ ] `pnpm build` 通过（含架构检查与 Worker 严格类型检查）；遗留豁免只减不增
- [ ] 改动 Telegram 调度 / 并发配置后 `pnpm test:scheduler` 通过
- [ ] 修改 Worker 绑定后已运行 `pnpm worker:types`
- [ ] 更换域名/子域时，同步 `TURNSTILE_HOSTNAMES`、`ALLOWED_ORIGINS`、Turnstile widget 域名与 README
- [ ] 新增/修改 Telegram bus/op 时 contracts、BusRouter、TelegramBusClient、monitor、测试同步；`pnpm test:bus` 通过
- [ ] 并发预算只从 concurrency.ts 读取，无业务硬编码或自建池
- [ ] 未提交 `.dev.vars`、`.env.local`、`.wrangler/`、`dist/`

---

## 6. 规则文档索引

- `.rules/frontend-architecture.md` —— 目录、路由、组件与零 ref 边界
- `.rules/state-management.md` —— 三层架构、鉴权数据流、会话持久化
- `.rules/design-system-and-tokens.md` —— 色彩令牌、圆角、登录页版式
- `.rules/telegram-bus-and-concurrency.md` —— Telegram 业务总线边界、RequestScheduler 并发与准入检查清单
- `.rules/telegram-bus-and-concurrency.md` —— Telegram 业务总线边界、并发预算与新增 bus/op 检查清单
- `.rules/remote-worker.md` —— Worker / D1 / Turnstile / 部署模式
