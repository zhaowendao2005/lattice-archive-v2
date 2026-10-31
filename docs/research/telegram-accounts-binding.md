# 「账户与绑定」设计研究 v2：凭据验证 / 设备授权 / 多设备在线 / 在线可用性

> 私用项目，许可不受约束（可复用 Telegram-web-z 的 GPL 代码），优先实现速度与线上稳定。
> 依据：core.telegram.org 官方文档（`api/auth`、`api/datacenter`、`api/pfs`、`api/updates`、`api/errors`、`api/qr-login`、`api/config`、`method/initConnection`）、GramJS / Telegram-web-z 源码、teleproto 1.232。
> v1 已归档在同文件历史中；本版按新约束（D1 绑定 + 多设备 + GUI 登录 + local worker 跑协议）重写。

---

## 1. 概念澄清：三个互不相同的层次

你的第 3 点判断完全正确，这是整个设计的基石。三者必须分开建模、分开验证、分开持久化：

```text
┌───────────────────────────────────────────────────────────────────────┐
│ ① 应用凭据 App credentials（my.telegram.org 申请）                     │
│    api_id + api_hash                                                  │
│    · 每个 Telegram 账号**只能申请 1 个**（官方："each number can only  │
│      have one api_id connected to it"）                               │
│    · 定义「哪个应用在与 Telegram 说话」，与登录谁无关                  │
│    · 每次建连的 initConnection 都要带 api_id；auth.* 系列要带 api_hash │
│    · 由它决定风控画像：公开的 api_id → API_ID_PUBLISHED_FLOOD          │
├───────────────────────────────────────────────────────────────────────┤
│ ② 设备授权 Device authorization（登录产物）                            │
│    一次成功登录 → 一枚**该设备独有**的 auth_key（MTProto 会话）        │
│    · 等价于账户控制权，绝不能跨设备共用（见 §2）                       │
│    · 手机上「设备」列表里就是一条 authorization                       │
├───────────────────────────────────────────────────────────────────────┤
│ ③ 账户绑定 Binding（Lattice 业务概念）                                 │
│    lattice_user_id  ↔  tg_user_id，1 : N                              │
│    再挂 N 条 ②（每台设备一条），用于多端展示与状态聚合                 │
└───────────────────────────────────────────────────────────────────────┘
```

由此推出的关系基数：

| 关系 | 基数 | 说明 |
| --- | --- | --- |
| Lattice 用户 → 应用凭据 | 1 : 1 | 用户自己的 my.telegram.org 应用（他若没有，先去申请） |
| 应用凭据 → Telegram 账户 | 1 : N | 同一个 api_id 可以登录任意多个不同 TG 账号 |
| Telegram 账户 → 设备授权 | 1 : N | 每台设备各自登录一次，各自一枚 auth_key（多设备在线的唯一合法形态） |
| Lattice 用户 → Telegram 账户 | 1 : N | 需求「允许绑定多个 TG 账户」 |
| 设备授权 → 设备 | 1 : 1 | 一台设备对同一账户只持有一条授权 |

**验证应用凭据 ≠ 验证账户可用。** 前者只回答「这组 id/hash 能不能跟 Telegram 正常说话」；后者要回答「这个账户的会话是否仍然有效、是否被冻结、是否被限流」。

---

## 2. 为什么绝对不能把同一个会话文件放到两台设备（协议依据）

官方错误文档对 `AUTH_KEY_DUPLICATED`（**406**）的原文要点：

- 只有当**非媒体 DC 的主连接**检测到「同一个授权会话从两条并行连接（甚至同一 IP 的两条 TCP 连接）发请求」时才触发；
- 触发后**会话已被服务端作废**，用户必须重新生成 auth_key 并重新登录（不可恢复）；
- 主连接允许的并行 session 数由 `config.tmp_sessions` / `auth.authorization.tmp_sessions` 通告，**缺省为 1**；超过就必须 ≤ 该值，否则同样被踢；
- 媒体 DC 的文件传输 session 例外，可并行（后续归档下载会用到）。

Telethon 生态的实际反馈也一致：「The authorization key (session file) was used under two different IP addresses simultaneously, and can no longer be used.」

**结论：**

1. 「多设备同时在线同一个 TG 账户」在协议层**不是靠共享会话实现的**，而是靠**每设备一次独立授权**（和 Telegram 官方多端登录完全同构）。
2. 我们要做的不是"同步 session"，而是"同步**绑定关系 + 设备清单 + 业务数据**"。
3. 反面设计（把 D1 里的 session 分发给三台设备）会在几秒内触发 `AUTH_KEY_DUPLICATED`，三台全部掉线且该会话永久报废——必须写进设计红线。

---

## 3. 多设备在线架构（核心方案）

### 3.1 一句话架构

> **一台设备 = 一条独立授权；D1 = 绑定与状态的权威源；MTProto 只在本地 worker 里跑；归档/业务数据经 remote worker 进 D1。**

```text
设备 A（Web/Electron/iOS）        设备 B                     设备 C
┌──────────────────────┐   ┌──────────────────────┐  ┌──────────────────────┐
│ local worker         │   │ local worker         │  │ local worker         │
│  auth_key_A (独立)   │   │  auth_key_B (独立)   │  │  auth_key_C (独立)   │
└─────────┬────────────┘   └─────────┬────────────┘  └─────────┬────────────┘
          │ WSS/TCP                  │                        │
          ▼                          ▼                        ▼
      Telegram DC  ◀─────────────── 同一个 TG 账户 ───────────────▶
          │
          │  HTTPS /api/tg/*（带 Lattice Bearer）
          ▼
   remote worker ── D1: tg_accounts / tg_authorizations / tg_devices / archives ...
```

### 3.2 关键设计点

| 设计点 | 做法 | 理由 |
| --- | --- | --- |
| 授权粒度 | 每设备登录一次，独立 auth_key | `tmp_sessions=1`，共享即踢 |
| 会话存放 | **仅本机**安全存储（加密），不进 D1 | 跨设备分发＝主动制造 `AUTH_KEY_DUPLICATED` |
| D1 存什么 | 绑定关系、设备清单、每设备健康状态、api_id/api_hash（加密） | 满足「绑定关系放 D1 + 多端可见」 |
| 重装/换机 | 重新扫码登录（30 秒内完成），旧授权可在设备列表中远程注销 | 迁移会话＝共享会话，禁止 |
| 登录提醒 | 收到 `updateNewAuthorization` 时提示「新设备登录」，可 `account.resetAuthorization(hash)` 一键踢出 | 官方客户端行为，7 天内不处理则自动确认（`authorization_autoconfirm_period=604800`） |
| 长时未用 | `account.authorizations.authorization_ttl_days` 到点会自然失效 | UI 直接展示「授权将于 X 天后过期」，不当成 bug |
| 并发上限 | 每设备每账户 1 条主连接；媒体下载另开 media DC session | 主连接超额即 406 |
| 云端代跑 | **严禁** Worker 用某设备的会话代发请求 | 那就是"同 key 异地并发"，必踢 |

### 3.3 「2~3 台设备同时在线」的验收时序

```text
[t0] 设备 A：验证 app 凭据 → 扫码/手机号登录 → 得到 auth_key_A → 上报 D1（tg_authorizations: A）
[t1] 设备 B：GET /api/tg/accounts → 看到「已绑定 1 个账户」→ 添加设备：再次扫码
             → Telegram 生成 auth_key_B → A 收到 updateNewAuthorization（unconfirmed，附设备名/IP/国家）
             → D1 新增一条 authorization(B)
[t2] A、B 同时在线：各自一条主连接，互不影响；D1 里同属一个 tg_account，两条授权
[t3] A 卸载/清空浏览器数据：B 用 /api/tg/accounts + account.getAuthorizations 发现 A 已失联，
             可对 A 的 hash 调 account.resetAuthorization 清理（或等 TTL 过期）
```

### 3.4 D1 数据模型（remote 侧）

```sql
-- ① 应用凭据（每 Lattice 用户一条；api_hash 加密存放，仅本人可取回）
CREATE TABLE tg_apps (
  user_id        TEXT PRIMARY KEY,          -- 关联 users.id
  api_id         INTEGER NOT NULL,
  api_hash_enc   TEXT NOT NULL,             -- AES-GCM(HKDF(TG_CRED_KEY, user_id))
  api_hash_mask  TEXT NOT NULL,             -- 452b…9750，仅展示
  validated_at   INTEGER,
  last_report    TEXT,                      -- JSON：DC/国家/延迟/层号/时钟偏差
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

-- ② 账户绑定（逻辑账户）
CREATE TABLE tg_accounts (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  tg_user_id  TEXT NOT NULL,                -- 大整数用 TEXT
  username    TEXT, first_name TEXT, last_name TEXT,
  phone_enc   TEXT, phone_mask TEXT,        -- PII 加密 + 掩码
  is_premium  INTEGER DEFAULT 0,
  home_dc     INTEGER,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  UNIQUE (user_id, tg_user_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ③ 设备授权（每设备一条；不存 session 明文/密文）
CREATE TABLE tg_authorizations (
  id            TEXT PRIMARY KEY,
  account_id    TEXT NOT NULL,
  device_id     TEXT NOT NULL,              -- 安装级 UUID（本机生成并持久化）
  device_label  TEXT NOT NULL,              -- 例：macOS · Chrome / iPhone · Lattice
  platform      TEXT NOT NULL,              -- web | electron | ios
  app_version   TEXT,
  session_state TEXT NOT NULL DEFAULT 'active',  -- active|expired|revoked|duplicated
  reachability  TEXT,                       -- ok|degraded|blocked
  flood_until   INTEGER,
  frozen        INTEGER DEFAULT 0,
  latency_ms    INTEGER,
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  revoked_at    INTEGER,
  UNIQUE (account_id, device_id),
  FOREIGN KEY (account_id) REFERENCES tg_accounts(id) ON DELETE CASCADE
);
CREATE INDEX idx_tg_auth_user ON tg_authorizations(account_id, last_seen_at);
```

> 若将来确实想做「会话灾备」（同机重装恢复），再单独加 `tg_session_backups`，用**用户口令派生密钥**做端到端加密，明确标注「服务器无法解密」。默认不做（见 §7）。

### 3.5 Remote API（`src/worker/remote/telegram/*`）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/tg/credentials` | 取回本用户的 api_id + 解密后的 api_hash（供任意设备直接使用） |
| PUT | `/api/tg/credentials` | 保存/更新 + 验证报告 |
| DELETE | `/api/tg/credentials` | 清除应用凭据（连带清除绑定？默认不连带，需显式 `?cascade=1`） |
| GET | `/api/tg/accounts` | 账户列表 + 每账户的设备授权摘要 |
| POST | `/api/tg/accounts` | 登录成功后创建绑定（tg 资料 + home_dc + 本设备授权） |
| DELETE | `/api/tg/accounts/:id` | 解绑（客户端先 `auth.logOut`，再删记录） |
| POST | `/api/tg/authorizations` | 本设备授权上线/续期（device_id + label + 状态） |
| PATCH | `/api/tg/authorizations/:id` | 心跳/健康状态（节流 ≥60s） |
| DELETE | `/api/tg/authorizations/:id` | 注销某设备记录（配合客户端 `account.resetAuthorization`） |
| POST | `/api/tg/events` | （可选）客户端侧事件审计：登录、失败、风控命中 |

分层仍按 `routes → service → repository`，复用 `AuthError`、`json()`、`requireUser`（需从现有 `admin/authorization.ts` 提炼一个通用鉴权）。新增 Worker secret `TG_CRED_KEY`（`.dev.vars` + `wrangler secret`），并 `pnpm worker:types` 重生成 `Env`。

---

## 4. 账户「是否正常在线可用」模型

Telegram 没有单一的「账号健康」接口，健康度必须由我们聚合。权威信号如下：

| 维度 | 探测手段 | 得到什么 |
| --- | --- | --- |
| 网络可达 | 建立 MTProto 连接（握手 + `help.getConfig`） | 直连是否可用、延迟、是否要走代理 |
| 会话有效 | `updates.getState`（最轻的授权校验；比 `getMe` 便宜） | `AUTH_KEY_UNREGISTERED` / `SESSION_REVOKED` / `SESSION_EXPIRED` |
| 账户状态 | `users.getFullUser(InputUserSelf)` | 昵称/用户名/`premium`/`about`；`USER_DEACTIVATED` = 账号已注销 |
| 设备全景 | `account.getAuthorizations` | 全部设备、`current` 标记、`date_active`、`authorization_ttl_days`（过期倒计时） |
| 2FA | `account.getPassword` | `hasPassword` / `hint`（展示"已开启两步验证"） |
| 冻结/处罚 | 命中 `FROZEN_METHOD_INVALID`(420) 后调 `help.getAppConfig` | `freeze_since_date` / `freeze_until_date` / `freeze_appeal_url` |
| 限流 | 命中 `FLOOD_WAIT_X`(420) | 精确等待秒数 → `flood_until` |
| 在线状态 | 我们自己的保活 + `account.updateStatus(offline:false/true)` | 「本设备在线」；也是官方客户端的前后台行为 |

对外只暴露一个状态机（UI 用它上色）：

```text
unbound → bound_offline → connecting → online(ok)
                                   ├→ degraded（高延迟/丢包/频繁重连）
                                   ├→ flood_wait(until)      ← 420 FLOOD_WAIT_X
                                   ├→ frozen(until, appeal)  ← FROZEN_METHOD_INVALID
                                   ├→ session_expired(ttl)   ← authorization_ttl_days 到期
                                   ├→ session_revoked        ← 被其他设备踢 / SESSION_REVOKED
                                   └→ deactivated            ← USER_DEACTIVATED
```

节流：健康检查在**本地 worker** 每 60s 一次（仅保活连接时用 `updates.getState`），只在**状态变化**或每 5 分钟把摘要 `PATCH /api/tg/authorizations/:id` 上报 D1，避免把 D1 写成日志表。

---

## 5. 对齐官方客户端的行为清单（风控与时序）

这一节是「避免 bug / 避免风控」的核心，几乎全部来自官方文档原文：

### 5.1 连接与初始化
1. `initConnection` 必须在**应用重启后首次调用**、**参数变化时**、以及**每次 `auth.bindTempAuthKey` 之后**发送；层号随 `invokeWithLayer` 保存，之后不必层层包裹。
2. 单设备主连接**只允许 1 条**（`tmp_sessions` 缺省 1）。媒体 DC 的传输 session 可并行。
3. 只有 `tmp_sessions > 1` 时才**强制**要求 PFS（`bindTempAuthKey`）；GramJS/webz fork 均未实现 PFS → 我们保持 `tmp_sessions=1` 即可不改协议栈（这是选择"不开并行主会话"的额外收益）。
4. `help.getConfig` 结果要按 `config.expires` 缓存，别每次操作都拉。
5. `msg_id` 单调递增且与服务器时间对齐（MTProto 时间同步）；偏差大时服务端会直接忽略消息。库内部有 `getServerTimeOffset`，我们要保证 worker 生命周期内在线时长与重连时刷新该偏移。

### 5.2 登录（GUI）
6. **QR 优先**：`auth.exportLoginToken` → `tg://login?token=<base64url>` → token 约 **30s** 过期，到期必须重新导出并重绘；收到 `updateLoginToken` 后**再导出一次** → 得 `loginTokenSuccess` 或 `loginTokenMigrateTo`（此时必须在**指定 DC** 上 `auth.importLoginToken`）。
7. 手机号路线：`auth.sendCode` → 验证码类型可能是 **App 内码 / 邮件码 / Fragment / 电话/闪呼**；**SMS 对第三方应用可能不可用**（官方："in some conditions, only the official applications can receive a login/signup code via SMS/call"）。因此 UI 必须能显示「验证码已发到你的 Telegram 其他设备」「验证码发到邮箱 xxx」「需要先设置登录邮箱」等分支，并提供「改用二维码」出口。
8. `auth.signIn` 返回 `SESSION_PASSWORD_NEEDED` → SRP 2FA（`account.getPassword` → `auth.checkPassword`）。
9. `auth.authorizationSignUpRequired` = 该手机号未注册 → **停止**，提示去官方客户端注册（我们不实现 `auth.signUp`）。
10. `future_auth_token`：登录响应与 `auth.logOut` 都可能返回；**本机最多存 20 个**，下次 `auth.sendCode` 时放进 `codeSettings.logout_tokens`，命中即可免验证码直接登录（显著降低风控暴露面，且是官方行为）。
11. 同一手机号每天登录次数有限（官方举例 5 次），超限 `FLOOD`；开发/演练请用 **Test DC**：手机号 `99966XYYYY`（X∈1..3），验证码 = DC 号重复 5 次。
12. 用「申请 api_id 的那个手机号」登录时，flood 限制更宽松（官方原文），可作为自用场景的实践建议。

### 5.3 多设备与授权
13. 登录成功会让其他在线设备收到 `updateNewAuthorization`（带 `unconfirmed` 时弹确认）；确认用 `account.changeAuthorizationSettings(hash, confirmed:true)`，拒绝用 `account.resetAuthorization(hash)`；不处理则 7 天后自动确认。
14. `account.getAuthorizations` 里 `authorization_ttl_days` 是**非活跃自动登出**天数，要展示。
15. **多标签页 / 多窗口 = 致命**：同一浏览器的两个标签各自连接同一 auth_key → 立刻 `AUTH_KEY_DUPLICATED`。必须做「单实例选主」：`BroadcastChannel` + 心跳令牌（webz 的 `establishMultitabRole` 就是这个），非主标签把请求转发给主标签（或直接用 `SharedWorker`，Chrome/Electron 可用，WKWebView 需降级）。刷新/关闭前主动 `disconnect()`。

### 5.4 错误处理矩阵（照官方分类实现，别自己想）

| 类别 | 错误 | 客户端正确动作 |
| --- | --- | --- |
| 303 | `PHONE_MIGRATE_X` / `USER_MIGRATE_X` / `FILE_MIGRATE_X` / `NETWORK_MIGRATE_X` | 切到 X 号 DC 重发（登录阶段尤其常见，必须实现） |
| 400 | `API_ID_INVALID` | 凭据不配对 → 引导重填 |
| 400 | `API_ID_PUBLISHED_FLOOD` | api_id 已公开 → 引导新建应用 |
| 400 | `PHONE_NUMBER_INVALID/BANNED`、`PHONE_CODE_INVALID/EXPIRED/HASH_EMPTY`、`AUTH_TOKEN_INVALID/EXPIRED/ALREADY_ACCEPTED`、`RANDOM_ID_DUPLICATE` | 就地提示/重发/重扫 |
| 400 | `SESSION_PASSWORD_NEEDED` | 进入 2FA 环节 |
| 401 | `AUTH_KEY_UNREGISTERED` / `AUTH_KEY_INVALID` | 会话无效 → 标记需重登（不清绑定） |
| 401 | `SESSION_REVOKED` / `SESSION_EXPIRED` | 被踢/TTL 过期 → 标记 `revoked/expired` |
| 401 | `USER_DEACTIVATED` | 账号已注销 → 标记 `deactivated`，禁用心跳 |
| 401 | `AUTH_KEY_PERM_EMPTY` | 临时 key 未绑定 → 重新 bind/重连 |
| 406 | `AUTH_KEY_DUPLICATED` | 会话永久作废 → 清除本机会话 + 标记 `duplicated` + 引导重登（并检查是否多实例） |
| 406 | 其它 406 | **不要弹自定义错误**：等 `updateServiceNotification` 的 popup 文案 |
| 420 | `FLOOD_WAIT_X` / `FLOOD_PREMIUM_WAIT_X` | 精确等待 X 秒（全局闸门 + UI 倒计时） |
| 420 | `FROZEN_METHOD_INVALID` | 拉 `help.getAppConfig` 取冻结信息，进 `frozen` 状态 |
| 500 | 任意 5xx | 关 socket → 重连 → `initConnection` → `updates.getDifference` |

### 5.5 更新序列（多设备正确性的隐形坑）
16. `pts/qts/seq` 是**每个会话私有**的本地状态，重连后用 `updates.getDifference` 补齐；**绝不要把 pts 同步到 D1**（否则设备间会互相覆盖，导致丢更新/重复处理）。D1 只同步"业务结果"（归档条目、消息实体、更新时间戳）。
17. `seq=0` 的更新不进 `getDifference`，需在会话内直接处理（库已处理，注意别在外层重排）。
18. 断开/切网后必须走 `getDifference`，不能"重新拉全量"。

### 5.6 行为节制（风控友好）
19. 登录后进入**静默期**（建议 90s）只做小请求（`getState`、`getDialogs(limit)`），不要立刻全量拉历史/下载文件。
20. 全局限速：同一账户 RPC 并发 ≤ 2，媒体下载分块 + 退避；登录相关操作全局串行（single-flight）。
21. `device_model` / `system_version` / `app_version` / `lang_pack` / `lang_code` 必须**稳定且真实**（不要每次随机），`lang_pack` 用 `web`/`tdesktop` 之类平台标识。
22. 前后台切换时 `account.updateStatus(offline:false/true)`，退出时置 offline（避免"永远在线"）。

---

## 6. 宿主三形态与 local worker 协议

### 6.1 三宿主

| 宿主 | MTProto 位置 | 传输 | 备注 |
| --- | --- | --- | --- |
| Web | **专用 module worker**（`tg.worker.ts`） | WSS（`zwsN.web.telegram.org/apiws`），HTTP 长轮询兜底 | 单实例选主（BroadcastChannel / SharedWorker） |
| Electron | 同一 worker（渲染进程），或主进程 `worker_threads` | 同上；可留 Node TCP 适配位（`net` + 443） | 复用同一份代码，减少分叉 |
| iOS（Capacitor/WKWebView） | 同一 worker | WSS | 后台挂起会断连：回前台 `connect()` + `getDifference` |

> 「登录与终端无关」→ worker 只暴露**事件 + 命令**，登录全程由 GUI 驱动，不出现任何 stdin/readline 逻辑。

### 6.2 worker ↔ 主线程消息协议（建议形态）

```ts
// 主线程 → worker（命令，全部带 requestId）
type TgCmd =
  | { t: 'init'; deviceId: string; platform: 'web'|'electron'|'ios'; appVersion: string }
  | { t: 'validateApp'; apiId: number; apiHash: string }          // §3 验证
  | { t: 'beginQrLogin'; apiId: number; apiHash: string; exceptTgUserIds: string[] }
  | { t: 'beginPhoneLogin'; apiId: number; apiHash: string; phone: string }
  | { t: 'submitCode'; code: string }
  | { t: 'submitPassword'; password: string }
  | { t: 'submitEmail'; email: string } | { t: 'submitEmailCode'; code: string }
  | { t: 'cancelLogin' } | { t: 'switchToQr' }
  | { t: 'restoreSession'; accountId: string }                    // 本机会话恢复
  | { t: 'healthCheck'; accountId: string }
  | { t: 'setOnline'; accountId: string; online: boolean }
  | { t: 'logout'; accountId: string }                            // auth.logOut
  | { t: 'destroy' };

// worker → 主线程（事件流）
type TgEvt =
  | { t: 'loginStage'; stage: 'qr'|'phone'|'code'|'password'|'email'|'ready'|'done' }
  | { t: 'qrToken'; token: string; expiresAt: number }            // 视图渲染二维码
  | { t: 'codeType'; kind: 'app'|'sms'|'call'|'email'|'fragment' ; lengthHint?: number }
  | { t: 'passwordHint'; hint?: string }
  | { t: 'validationReport'; report: ValidationReport }
  | { t: 'health'; accountId: string; state: HealthState; detail?: unknown }
  | { t: 'session'; accountId: string; sessionEnc: string; dcId: number }  // 供 local 存储
  | { t: 'newAuthorization'; deviceLabel: string; ip?: string; country?: string; hash: string }
  | { t: 'error'; scope: string; code: string; message: string; floodUntil?: number }
  | { t: 'needRelogin'; accountId: string; reason: 'revoked'|'expired'|'duplicated' };
```

Pinia 只镜像 `loginStage / qrToken / health / accounts` 等**页面态**；协议对象、client 句柄、二维码画布全部留在 Data Source（符合 `.rules` 的「句柄不进视图」）。

---

## 7. 会话与密钥存储（本机）

| 层 | 内容 | 做法 |
| --- | --- | --- |
| 会话（核心秘密） | `{dcId, keys:{dc: hexAuthKey}}` | Web：IndexedDB + **AES‑GCM**，密钥为 IndexedDB 里不可导出的 `CryptoKey`；Electron：`safeStorage` 包裹；iOS：Keychain 插件 |
| 应用凭据 | api_id + api_hash | 缓存本机；权威版本在 D1（`api_hash_enc`，Worker Secret 派生密钥加密），供新设备直接取回 |
| 未来的 `future_auth_token` | 最多 20 个 | 本机存（也是免验证码的凭据） |
| `device_id` | 安装级 UUID | 本机持久化（localStorage/SQLite），用于 D1 的授权行主键 |
| 服务端能力 | — | **服务器始终无法解密 Telegram 会话**（本设计的关键安全性质） |

> 说明：会话不上 D1 的代价是「换机需重登一次（30 秒扫码）」。这在 Telegram 的协议模型下是**唯一正确**的做法（见 §2），不是妥协。

---

## 8. 实现路线（每步都有验收）

**P0 · 凭据验证闭环（不碰 D1）**
- `telegram` 域 + `mtprotoBridge`（worker 内：connect → `help.getConfig` → `help.getNearestDc` → `auth.exportLoginToken` → 断开）
- 设置页新子页「账户与绑定」：凭据表单 + 验证成功元信息卡片（DC/端点/出口国家/时钟偏差/层号/耗时/api_hash 掩码）
- 验收：正确凭据出卡片；错 hash 出 `API_ID_INVALID` 文案；断网/不可达出网络文案；连点不叠加请求（single-flight）

**P0.5 · golden path 实测（不写业务代码，2 天）**
- 用 Test DC（`99966XYYYY`）把 QR/手机号/2FA 三条路径各跑一遍

**P1 · 多设备绑定（接 D1）**
- remote：`tg_apps / tg_accounts / tg_authorizations` + `/api/tg/*`（`TG_CRED_KEY` secret）
- local：QR 登录（含 30s 刷新、`migrateTo` 切 DC、二次导出）、2FA、`updateNewAuthorization` 提示与踢出
- 多端：设备 A/B/C 各用自己的授权；D1 列表互相可见；注销设备走 `account.resetAuthorization`
- 验收：A、B 同时在线 24h 不掉线；C 登录时 A/B 收到新设备提醒；踢掉 A 后 A 立刻 `SESSION_REVOKED`

**P2 · 在线可用性面板**
- 健康状态机 + 60s 探测 + 状态上报节流 + 冻结/限流/TTL 展示

**P3 · 归档管线（与绑定解耦）**
- 媒体下载走 media DC 独立 session（允许并行），`FILE_MIGRATE_X` 处理，分块 + 断点；`random_id` 去重；限速

---

## 9. 需要你确认的 4 个决策

1. **api_hash 是否允许服务端解密**（为了新设备免手输）→ 建议：允许，AES‑GCM + `TG_CRED_KEY`（私用项目，收益明显）。 允许
2. **会话是否做"加密灾备"**（同机重装可恢复）→ 建议：**不做**；重装重扫即可。 不做 
3. **协议内核**：teleproto（维护中的 232）还是 vendor webz 的 gramjs fork（231，浏览器现成）→ 建议：先做 P0.5 spike，用实测决定；两者都能套用本设计的 worker 协议。 
4. **每用户绑定上限**：建议 5 个 TG 账户 × 每账户 3 台设备。

---

## 10. 主要风险（含对策）

| 风险 | 触发条件 | 对策 |
| --- | --- | --- |
| `AUTH_KEY_DUPLICATED`（会话报废） | 多标签/多窗口/多设备共用会话、云端代跑 | 单实例选主 + 会话不出本机 + 代码层面禁止 session 上云 |
| 风控/限流 | 新设备立刻全量抓取、频繁登录、共享 api_id | 静默期 + 限速 + `future_auth_token` 免码 + 用户自备 api_id |
| 登录码收不到 | 第三方应用拿不到 SMS | QR 优先；展示 App 内码/邮件码分支；提示"改用二维码" |
| 授权被其他设备踢 | 用户在手机上清理设备 | `updateNewAuthorization`/`SESSION_REVOKED` → 引导重登，保留绑定记录 |
| iOS 后台断连 | WKWebView 挂起 | 回前台 `connect` + `getDifference`；不做常驻在线承诺 |
| 国内不可达 | 未开梯子 | 需求已声明用户自备 VPN；仍提供"连接失败→检查代理"提示与可选 MTProxy 配置位 |

---

## 11. 参考（关键条目）

- core.telegram.org：`api/errors`（406 `AUTH_KEY_DUPLICATED` 原文、401 家族、420、406 等 `updateServiceNotification`）、`api/datacenter`（`tmp_sessions` 与 PFS 强制条件、媒体 DC 例外）、`api/auth`（`authorization_autoconfirm_period=604800`、`authorization_ttl_days`、`updateNewAuthorization` 确认、`future_auth_token`、SMS 对第三方限制、Test DC `99966XYYYY`、同号 api_id 更宽松 flood）、`api/qr-login`（token 30s、二次导出、`migrateTo`→`importLoginToken`）、`api/invoking`（`initConnection` 时机）、`api/config`、`api/updates`、`api/pfs`、`api/obtaining_api_id`（一号一 api_id、示例 id 会 `API_ID_PUBLISHED_FLOOD`）
- 本仓：`src/worker/remote/{index.ts,wrangler.jsonc,shared/http.ts,migrations/}`、`src/stores/*`、`src/router/index.ts`、`.rules/*`
- 参考实现：`Telegram-web-z-master/src/util/establishMultitabRole.ts`（单实例选主）、`src/lib/gramjs/sessions/CallbackSession.ts`（会话结构）、`src/lib/gramjs/extensions/{PromisedWebSockets,HttpStream}.ts`（WSS + HTTP 兜底）、`src/api/gramjs/methods/auth.ts`（登录事件机）、`src/util/multiaccount.ts`（多账户存储命名，仅参考）

---

## 12. Telegram-web-z 官方源码级实现深度剖析（对标措施）

通过对本地参考仓库 `/Volumes/Lenovo/参考项目/Telegram-web-z-master` 的核心源码进行逐文件拆解，整理出官方客户端在**线程隔离、登录状态机、QR/手机号/2FA 流程、多标签选主、会话落盘与级联退出**上的真实工程措施，作为本仓落地实现的直接参照：

### 12.1 线程隔离与四层通信拓扑
官方不让主线程碰任何 MTProto 加解密或 Socket 连接，整体采用四层结构：
1. **UI / Global Actions 层**（`src/global/actions/api/initial.ts`）：响应用户点击，派发 `initApi`、`setAuthPhoneNumber`、`setAuthCode`、`setAuthPassword`、`goToAuthQrCode`、`signOut` 等动作。
2. **主线程连接器层**（`src/api/gramjs/worker/connector.ts`）：
   - 仅在 `isMasterTab === true` 时实例化 `new Worker(new URL('./worker.ts', import.meta.url), { name: params.toString(), type: 'module' })`；
   - 使用 `throttleWithTickEnd` 将同一事件循环 tick 内的多条请求合并为 `payloads` 数组批量 `postMessage` 给 Worker；
   - 在 Safari / macOS Tauri 下启动定时健康探测（`setupHealthCheck`，150ms 超时、5s 间隔），发现 Worker 假死时自动重建。
3. **Worker 宿主层**（`src/api/gramjs/worker/worker.ts` & `src/api/gramjs/methods/init.ts`）：
   - 接收 `initApi` 与 `callMethod` 消息，將二进制 `ArrayBuffer` 作为 `Transferable` 零拷贝传回主线程；
   - 聚合 `pendingUpdates` 批量推送给主线程 `onUpdate`。
4. **MTProto 客户端与协议层**（`src/api/gramjs/methods/client.ts` & `src/lib/gramjs/client/*`）：
   - 持有 `TelegramClient` 单例、本地实体缓存 `localDb`、差量更新管理器 `updateManager` 以及按会话中止的 `ChatAbortController`。

### 12.2 挂起式认证状态机（Promise 控制器模式）
源码位置：`src/api/gramjs/methods/auth.ts` 与 `src/lib/gramjs/client/auth.ts`。
- **核心机制**：`TelegramClient.start()` 内部是一个连续的 `while (true)` 异步协程，当需要用户输入时，调用回调（如 `onRequestPhoneNumber`、`onRequestCode`、`onRequestPassword`、`onRequestQrCode`）：
  1. 回调内部先向主线程发送状态更新事件：`sendApiUpdate(buildAuthStateUpdate('authorizationStateWait...'))`；
  2. 随后返回一个挂起的 `new Promise((resolve, reject) => { authController.resolve = resolve; authController.reject = reject; })`；
  3. 当用户在 GUI 提交表单时，调用 `provideAuthPhoneNumber(phone)` / `provideAuthCode(code)` / `provideAuthPassword(pwd)`，直接触发 `authController.resolve(val)` 唤醒 Worker 内的登录协程继续往下走；
  4. 当用户点击「切换二维码」或「返回修改手机号」时，调用 `restartAuthWithQr()` / `restartAuth()`，触发 `authController.reject(new Error('RESTART_AUTH_WITH_QR'))`，协程捕获该特定 Error 后无缝切换到另一条登录分支。
- **二维码登录双流竞速（`signInUserWithQrCode`）**：
  - `inputPromise` 循环调用 `Api.auth.ExportLoginToken({ apiId, apiHash, exceptIds })`，每次拿到 `{ token, expires }` 后通过 `Promise.race([authParams.qrCode({ token, expires }), sleep((expires - getServerTime()) * 1000)])` 实现**到期自动重刷**；
  - `updatePromise` 监听服务端推送的 `Api.UpdateLoginToken` 事件；
  - 一旦 `Promise.race([updatePromise, inputPromise])` 被扫码事件唤醒，**立即二次调用 `ExportLoginToken`**：
    - 若返回 `Api.auth.LoginTokenSuccess` → 直接拿到 `authorization.user` 完成登录；
    - 若返回 `Api.auth.LoginTokenMigrateTo({ dcId, token })` → 调用 `await client._switchDC(result2.dcId)` 切换到目标数据中心，再调用 `Api.auth.ImportLoginToken({ token })` 完成跨 DC 授权；
    - 若抛出 `RPCError('SESSION_PASSWORD_NEEDED')` → 自动转入 `signInWithPassword`（SRP 2FA 流程）。
- **手机号与验证码分支（`signInUser` & `sendCode`）**：
  - 调用 `Api.auth.SendCode({ phoneNumber, apiId, apiHash, settings: new Api.CodeSettings() })`；
  - 根据返回的 `SentCode.type` 区分 `SentCodeTypeApp`（Telegram 其他已登录设备内收码）与 `SentCodeTypeSms`；
  - 若捕获 `AUTH_RESTART` 错误则自动重发 `sendCode`；
  - 调用 `Api.auth.SignIn({ phoneNumber, phoneCodeHash, phoneCode })`，若遇 `SESSION_PASSWORD_NEEDED` 则走 `Api.account.GetPassword()` + `computePasswordSrpCheck(passwordSrpResult, password)` + `Api.auth.CheckPassword`。

### 12.3 单实例选主防 `AUTH_KEY_DUPLICATED`（`establishMultitabRole.ts`）
源码位置：`src/util/establishMultitabRole.ts`。
- 每个标签页启动时生成随机令牌 `token`，加入 `collectedTokens` 集合，并通过 `BroadcastChannel(ESTABLISH_BROADCAST_CHANNEL_NAME)` 广播；
- 在 `ESTABLISH_TIMEOUT`（100ms）窗口内收集所有存活标签页的 `token`，以 `masterToken = Math.max(...Array.from(collectedTokens))` 确定唯一主标签页（Master Tab）；
- 只有 Master Tab 才会启动 `Worker` 并建立 MTProto WSS 连接，从属标签页通过 `DATA_BROADCAST_CHANNEL_NAME` 将 `initApi` 等指令转发给 Master Tab；
- 监听 `window.addEventListener('beforeunload', signalTokenDead)`，当主标签页关闭时广播 `{ tokenDied: token }`，剩余标签页立即剔除死令牌并重新选出新 Master Tab 接管连接。

### 12.4 会话结构与持久化回调（`CallbackSession.ts` & `sessions.ts`）
源码位置：`src/lib/gramjs/sessions/CallbackSession.ts`、`src/util/sessions.ts`、`src/util/multiaccount.ts`。
- `CallbackSession` 继承自 `MemorySession`，内部维护 `_dcId`、`_serverAddress`、`_port` 以及按 DC 索引的字典 `_authKeys: Record<number, AuthKey>`（因为用户主连接在 `mainDcId`，而媒体下载或跨区时会在其它 DC 派生出对应的 `AuthKey`）；
- 每次 `setDC`、`setAuthKey` 或登录完成 `onAuthReady()` 时，触发 `onSessionUpdate(session.getSessionData())`，将 `{ mainDcId, keys: { [dcId]: hexKey }, isTest }` 传回主线程落盘；
- 多账户通过 `ACCOUNT_SLOT`（`session_account_1`、`session_account_2`...）隔离存储键名与 `BroadcastChannel` 名称，且支持通过 `passcode/sessionStore` 进行本地 AES 加密锁屏保护。

### 12.5 建连查活与四阶段级联退出（`client.ts` & `initial.ts`）
- **建连与查活**：
  1. `client.setPingCallback(getDifference)` 将心跳与差量拉取绑定；
  2. 若本地已有 `sessionData.keys`，启动时调用 `checkAuthorization`（内部执行 `await client.invoke(new Api.updates.GetState())`）做最轻量级的会话有效性验证；
  3. 验证通过后依次触发 `onAuthReady()` → `onSessionUpdate()` → `initUpdatesManager(invokeRequest)` → `fetchCurrentUser()`（拉取 `users.GetFullUser(InputUserSelf)`）。
- **级联退出（`signOut` + `destroy`）**：
  1. **服务端注销（带超时保护）**：在 `client.ts` 的 `destroy()` 中，若连接存活则执行 `await Promise.race([invokeRequest(new GramJs.auth.LogOut()), pause(2500)])`，防止因网络卡死阻塞本地退出；
  2. **清理 Worker 内存态**：调用 `clearLocalDb()`、`resetUpdatesManager()`、`client.destroy()` 彻底断开 Socket 并终止重连循环；
  3. **清理浏览器持久化与缓存**：在 `initial.ts` 中并行清除当前槽位的 Session、加密金库（Vault）、媒体缓存（`MEDIA_CACHE_NAME` / `AVATARS`）与全局状态缓存；
  4. **多账号切换或重置**：若还有其它已登录槽位则跳转到对应槽位，否则重新初始化未登录态。

---

## 13. Lattice 落地文件书（File Book）与模块职责

结合本仓现有的架构规范（`.rules/frontend-architecture.md` 视图层零 `ref`、`.rules/state-management.md` Pinia 三层架构、`.rules/remote-worker.md` 远端 Worker `routes → service → repository` 分层），「Telegram 账户与绑定」业务的完整文件书规划如下：

```text
lattice-archive-v2/
├── src/worker/
│   ├── local/                                     # [NEW] 本地 Web Worker：运行 MTProto 协议栈，会话不出本机
│   │   ├── tg.worker.ts                           # [NEW] 专用 Module Worker 入口（接收 TgCmd，派发 TgEvt）
│   │   ├── protocol.ts                            # [NEW] 主线程 ↔ local worker 强类型消息契约（TgCmd / TgEvt / HealthState）
│   │   ├── clientManager.ts                       # [NEW] 多 TG 账户 TelegramClient 实例池、CallbackSession 与单账户连接生命周期
│   │   ├── authStateMachine.ts                    # [NEW] 参照 web-z 的 Promise 挂起式登录状态机（QR 30s 刷新/二次导出/切 DC、手机号、2FA）
│   │   ├── validator.ts                           # [NEW] P0 应用凭据验证器（connect → help.getConfig → help.getNearestDc → exportLoginToken → destroy）
│   │   └── healthMonitor.ts                       # [NEW] 60s 保活探测（updates.getState）、错误分类映射（401/406/420）与静默期节流器
│   │
│   └── remote/                                    # [MODIFY] 远端 Cloudflare Worker：管理 D1 绑定关系与多设备状态聚合
│       ├── index.ts                               # [MODIFY] 挂载 `/api/tg/*` 路由分发
│       ├── wrangler.jsonc                         # [KEEP/MODIFY] 绑定 AUTH_DB，通过 wrangler secret 配置 TG_CRED_KEY
│       ├── migrations/
│       │   ├── 0001_init_auth_schema.sql          # [KEEP] 现有 Lattice 账户与会话表
│       │   └── 0002_init_tg_binding_schema.sql    # [NEW] 新增 tg_apps、tg_accounts、tg_authorizations 三张表与索引
│       ├── shared/
│       │   └── authGuard.ts                       # [NEW] 提炼通用 `requireUser(request, env)` 鉴权守卫（供 /api/tg/* 校验 Lattice Bearer Token）
│       └── telegram/                              # [NEW] Telegram 绑定与多设备状态聚合子域
│           ├── types.ts                           # [NEW] D1 行实体与 `/api/tg/*` 请求/响应 DTO 定义
│           ├── crypto.ts                          # [NEW] 基于 Web Crypto `AES-GCM(HKDF(TG_CRED_KEY, user_id))` 的 api_hash / phone 加解密与掩码生成
│           ├── repository.ts                      # [NEW] D1 预编译 SQL 访问层（凭据读写、账户绑定上限校验 5×3、设备授权 upsert 与级联删除）
│           ├── service.ts                         # [NEW] 领域服务层（凭据保存、绑定创建、设备心跳节流更新、解绑与设备踢出）
│           └── routes.ts                          # [NEW] `/api/tg/credentials`、`/api/tg/accounts`、`/api/tg/authorizations` 路由控制器
│
├── src/stores/telegram/                           # [NEW] 前端 Pinia Telegram 业务域（严格三层解耦）
│   ├── data-sources/
│   │   ├── mtprotoBridge.ts                       # [NEW] Local Worker 单例接线器 + BroadcastChannel 多标签选主（参照 establishMultitabRole）
│   │   ├── tgSessionVault.ts                      # [NEW] 本机加密会话存储（IndexedDB Irrevocable CryptoKey AES-GCM / Electron safeStorage + device_id 管理）
│   │   └── tgRemoteDataSource.ts                  # [NEW] `/api/tg/*` 远端 API 单例接线器（同步应用凭据、绑定列表、设备心跳）
│   └── stores/
│       └── telegramStore.ts                       # [NEW] 响应式页面状态（凭据表单、验证报告、登录状态机 stage/qrToken、已绑定账户与健康状态矩阵）
│
└── src/views/main/settings/                       # [MODIFY] 设置页视图层（严格遵守零本地 ref 与单文件 80~150 行精炼原则）
    ├── nav/
    │   └── SettingsNav.vue                        # [MODIFY] 新增「账户与绑定」子导航入口
    └── subviews/
        └── telegram-binding/                      # [NEW] 「账户与绑定」独立子目录（按逻辑同级拆分子组件）
            ├── TelegramBindingView.vue            # [NEW] 顶层聚合视图容器
            ├── AppCredentialsCard.vue             # [NEW] ① 应用凭据（api_id / api_hash）配置与连接探测报告卡片
            ├── BoundAccountsList.vue              # [NEW] ② 已绑定 TG 账户列表、在线健康徽标与本机/跨设备授权管理面板
            └── TgLoginModal.vue                   # [NEW] ③ GUI 登录引导弹窗（QR 自动刷新视图 / 手机号收码分支 / 2FA 密码输入）
```
