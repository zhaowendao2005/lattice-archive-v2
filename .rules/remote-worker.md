# 远端 Worker 规范 (Remote Worker Rules)

本规范约束 `src/worker/remote/` 下的 Cloudflare Worker：它同时托管前端静态资源、`/api/auth/*` 认证接口与 `/api/admin/*` 管理接口，并使用 Cloudflare D1 存储账户与会话。

---

## 一、 部署形态

* **单 Worker 同源**：`assets.directory` 指向 `dist/`，`not_found_handling = "single-page-application"`，`run_worker_first = ["/api/*"]`。
  - `/api/*` 先进入 Worker 代码；
  - 其余路径由静态资源服务，未命中时回退 `index.html`（Vue Router history 模式）；
  - 前端默认使用相对路径 `/api/...`，**不要写死绝对地址**；仅原生客户端可用 `VITE_REMOTE_WORKER_URL` 覆盖。
* **入口**：`index.ts` 只做 CORS、路由分发、异常兜底与结构化日志；业务逻辑按 `routes → service → repository` 分层。
* **本地开发**：`pnpm worker:dev` 使用 `local` 环境（允许 `localhost` / `127.0.0.1` 的 Turnstile hostname），Vite 通过 `/api` 代理联调。

---

## 二、 绑定与密钥

* `Env` 必须由 `wrangler types` 生成（`src/worker/remote/worker-configuration.d.ts`），**禁止手写**。
* 非敏感配置放 `vars`：`TURNSTILE_HOSTNAMES`、`ALLOWED_ORIGINS`。
* 敏感信息只放 Secret：`TURNSTILE_SECRET`。
  - 本地：`.dev.vars`（已 Git 忽略）；
  - 线上：`wrangler secret put TURNSTILE_SECRET` 或部署时 `--secrets-file`；
  - 严禁出现在源码、`wrangler.jsonc`、日志、命令参数或对话中。
* 管理员凭证 `ADMIN_EMAIL` / `ADMIN_PASSWORD` / `ADMIN_NAME` 也放在 `.dev.vars`，但**仅部署脚本读取**；
  `scripts/deploy.mjs` 会在上传前过滤掉 `ADMIN_*`，禁止把它们变成 Worker Secret。
  模板文件：`src/worker/remote/.dev.vars.example`（只放占位符）。
* 新增或重命名绑定后，必须重新运行 `pnpm worker:types` 并提交生成文件。

---

## 三、 认证与安全红线

1. **Turnstile（fail-closed）**
   - 调用 `https://challenges.cloudflare.com/turnstile/v0/siteverify`，超时 10s；
   - 必须同时满足 `success === true`、`action` 与入口匹配（`login` / `register` / `admin_login`）、`hostname` 在 `TURNSTILE_HOSTNAMES` 白名单；
   - 网络异常、非 2xx、token 为空/超长一律拒绝。
2. **密码**
   - PBKDF2-HMAC-SHA256，25,000 次迭代，16 字节随机盐，32 字节输出（适配 Workers 免费版 CPU 限制）；
   - 校验使用固定时间比较；账户不存在时执行一次虚拟派生，避免枚举时序差异。
3. **会话**
   - 32 字节随机 Token 交给客户端；数据库只存 `SHA-256(token)`；
   - `sessions` 记录角色、过期时间、`last_connected_at`；
   - `/api/auth/session/connect` 校验未过期且角色一致，再更新心跳；失效即删除记录并返回 401。
4. **角色隔离**
   - 普通注册固定 `role = 'user'`；
   - 管理员由部署脚本按 `.dev.vars` 的 `ADMIN_*` 生成 PBKDF2 哈希并 upsert（`scripts/seed-admin.mjs`），禁止任何公开管理员注册接口；
   - 修改 `ADMIN_PASSWORD` 后重新部署即生效；本地库用 `pnpm worker:seed:local` 同步；
   - 普通用户凭证不得登录 `/api/auth/admin/login`。
5. **管理接口与用户生命周期**
   - `/api/admin/*` 每次请求都必须查询 D1 会话，确认未过期、会话角色与用户角色一致且为 `admin`；前端路由守卫不是权限边界；
   - `GET /api/admin/users` 只返回普通用户，支持服务端搜索、分页与白名单排序；页大小最大 100，响应禁止包含密码哈希、盐及会话字段；
   - `POST /api/admin/users` 固定创建普通用户，沿用统一邮箱/密码校验和 PBKDF2，不为新用户创建会话；
   - `DELETE /api/admin/users/:id` 必须再次核验目标角色，使用 D1 batch 原子清理该用户会话与账户；管理员及未知目标均不得按成功处理；
   - 删除范围仅远端账户和会话，不宣称清除用户设备上的本地归档。
6. **CORS**
   - 同源部署下无需跨域；`ALLOWED_ORIGINS` 仅服务于 Capacitor/本地等显式客户端，禁止使用 `*`。

---

## 四、 数据与迁移

* Schema 只通过 `migrations/*.sql` 演进，禁止手改线上表结构。
* 唯一数据库名：`lattice-v2-d1`；绑定名：`AUTH_DB`。
* 部署模式由 `deploy.config.json` 的 `d1Mode` 决定：

| 模式 | 行为 | 数据 | 命令 |
| --- | --- | --- | --- |
| `migrate`（当前默认） | 仅应用未执行迁移 | 保留 | `pnpm deploy` / `pnpm deploy:migrate` |
| `rebuild` | 删除远端库 → 重建 → 回写新 `database_id` → 应用迁移 | **清空** | `pnpm deploy:rebuild` |

> ⚠️ 重建会生成新的 `database_id`，`scripts/deploy.mjs` 会自动改写 `wrangler.jsonc`，因此该文件会产生 diff；这是预期行为。
>
> 重建会清空账户与会话（含管理员），执行前确认无需保留数据。

* 部署前必须通过 `pnpm build`（包含 `tsc -p tsconfig.worker.json`）；`pnpm deploy` 已内置构建步骤。
* 每次部署都会按 `.dev.vars` 重新 upsert 管理员；未配置 `ADMIN_EMAIL` / `ADMIN_PASSWORD` 时跳过并告警。
* 部署脚本要求 `.dev.vars` 必须包含非空 `TURNSTILE_SECRET`，否则中止部署；`ADMIN_*` 永不写入 Worker Secret。

---

## 五、 可观测性与错误契约

* `observability.logs` 与 `observability.traces` 保持开启，日志必须是结构化 JSON。
* API 错误统一返回 `{ error, message }`，`message` 为可直接展示的中文；不得把内部堆栈返回给客户端。
* 未捕获异常返回 500，并记录 `request.failed` 事件（包含 path，不含密钥/密码）。

---

## 六、 域名变更检查清单

更换 Worker 名、账号子域或自定义域名时，必须同步：

- [ ] `src/worker/remote/wrangler.jsonc` 的 `TURNSTILE_HOSTNAMES`、`ALLOWED_ORIGINS`
- [ ] Turnstile widget 的允许域名（`wrangler turnstile widget update ...`）
- [ ] `README.md` / `AGENTS.md` 中的生产地址
- [ ] `pnpm deploy` 后验证：页面 200、SPA 深链 200、无效 Turnstile 403、无效会话 401、普通角色访问管理 API 403
