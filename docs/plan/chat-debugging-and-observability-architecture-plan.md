# 聊天流状态治理、三层架构归位与生产级 Agent 渐进式日志系统设计方案

> **状态**：方案定稿（待确认后实施，当前代码未做改动）
> **涉及模块**：
> - 本地 Worker 实现域：`src/worker/local/`（`chatService.ts`、`converters.ts`、`tg.worker.ts` 及新增统一网关与业务实现）
> - 远端 Worker 实现域：`src/worker/remote/`（新增 `/api/debug/*` 单行 Gzip 快照、Agent 密钥管理与渐进式日志查询接口）
> - 状态与薄桥接层：`src/stores/chat/`、`src/stores/telegram/`、`src/stores/archive/`、`src/stores/app/`
> - 视图表现层：`src/views/main/chats/`、`src/views/main/settings/subviews/DeveloperSettingsView.vue`、`src/views/main/archive/`
> - 仓库架构规范：`.rules/frontend-architecture.md`、`.rules/state-management.md`、`.rules/remote-worker.md`、`AGENTS.md`

---

## 一、 核心问题与设计目标总览

在近期针对「聊天流（Chats）与搜索机器人自动翻页采集（Bot Harvester）」的实机联调中，暴露出 5 类典型的交互与状态异常；同时，在深入审计全仓代码结构时，发现部分模块出现了「职责越界（重度业务塞入 Data Source 与 Store）」、「跨 Store 复制状态违背 SSOT（唯一真相来源）」以及「缺乏统一的敏感请求网关与可追踪日志系统」等架构隐患。

本方案旨在一次性达成以下 **四大目标**：
1. **彻底根治聊天流与机器人自动翻页的 5 大异常现象**（自己发出的消息被冲掉、4 按钮翻页加载圈按坐标顺序错位残留、`BOT_RESPONSE_TIMEOUT` 导致只翻 1 页即停、发出查询与回复消息脱钩、连接稳定性抖动）；
2. **严格归位三层+双端实现域架构（不新增前端 `src/services/` 层）**：确立 `View（纯表现） → Store（视图状态 & SSOT） → Data Source（纯薄桥接层） → Worker（local / remote 具体业务实现域）` 的清晰边界，并在 Worker 内建立统一居中管理的请求/事件总线；
3. **构建零额外云端事件配额消耗的「三端无圆角终端 + 时间轴视口拖拽器」**：在设置页提供 `LOCAL` / `REMOTE` / `FRONTEND` 三个无圆角开关标签、定高虚拟列表防卡顿终端、可拖拽时间轴观察视口与一键复制/下载；
4. **首创免 MCP 配置的「Agent 渐进式日志查询系统 + 生命周期密钥管理」**：在 Cloudflare 生产环境基于 D1 单行 Gzip 快照，提供支持时间区间与类文件系统/Grep 渐进式下钻查询的 HTTP 接口，配合设置页 Hover 提示的一键复制按钮（同时复制接口、渐进式查询 Skills 文档与访问密钥），让 Agent 无需繁琐 MCP 配置即可在数次渐进式查询内精准定位任意线上问题。

---

## 二、 聊天流与机器人翻页 5 大异常的底层根因全链路诊断

### 1. 现象一：给机器人发消息后，机器人一回复，我刚发出的消息就消失了
- **触发链路**：
  1. **发消息漏推进 `pts`**：在私聊/机器人会话中调用 [`sendMessage`](file:///Volumes/Lenovo/code-dev/lattice-archive-v2/src/worker/local/chat/chatService.ts#L508-L536)，Telegram 对私聊返回 `Api.UpdateShortSentMessage`（含 `id`、`pts`、`ptsCount = 1`、`date`）。然而 [`ingestUpdatesResult`](file:///Volumes/Lenovo/code-dev/lattice-archive-v2/src/worker/local/chat/chatService.ts#L130-L136) 只识别 `Api.Updates` / `Api.UpdatesCombined`，[`firstNewMessageOf`](file:///Volumes/Lenovo/code-dev/lattice-archive-v2/src/worker/local/chat/chatService.ts#L519-L536) 虽然拼装了 DTO 推给前端展示，但**完全没有将 `UpdateShortSentMessage.pts` 推进到 `engine.state.pts`**（假设原 `pts = 100`，发出消息占用了 `101`，但 Worker 内存仍停留在 `100`）。
  2. **机器人回复触发假性 `pts` Gap**：几百毫秒后机器人回复到达，携带 `pts = 102, ptsCount = 1`。Worker 的 [`checkCommonPts`](file:///Volumes/Lenovo/code-dev/lattice-archive-v2/src/worker/local/chat/chatService.ts#L144-L151) 计算 `100 + 1 !== 102`，误判发生消息空洞，立即向主线程广播 `{ type: 'gap' }`。
  3. **主线程状态回退与窗口覆盖**：主线程 [`handleLiveUpdates`](file:///Volumes/Lenovo/code-dev/lattice-archive-v2/src/stores/chat/stores/chatStore.ts#L1063-L1069) 仅在 `this.syncPhase === 'live'` 时才更新 `this.updatesState`；收到 `gap` 后触发 [`runSync`](file:///Volumes/Lenovo/code-dev/lattice-archive-v2/src/stores/chat/stores/chatStore.ts#L650-L671)，若 `updatesState` 为空或滞后导致走 `resetState`，会调用 `invalidateWindows` 将窗口 `win.continuous` 置为 `false`（此期间到达的实时消息被丢弃），随后 `loadLatest` 调用 [`mergeLatestPage`](file:///Volumes/Lenovo/code-dev/lattice-archive-v2/src/stores/chat/stores/chatModel.ts#L33-L52) 直接覆盖整个 `win.messages` 数组，导致刚发出的消息瞬间消失。

### 2. 现象二：4 个翻页按钮点击「回到首页 / 末页」后，按钮变了，但加载圈（Spinner）却停留在错误位置按顺序显示
- **触发链路**：
  1. **按网格坐标绑定加载态**：[`chatStore.ts:1615`](file:///Volumes/Lenovo/code-dev/lattice-archive-v2/src/stores/chat/stores/chatStore.ts#L1615) 将按钮加载态以坐标 `${messageId}:${rowIdx}:${colIdx}` 存入 `pendingCallbacks`，且 [`MessageInlineKeyboard.vue:28`](file:///Volumes/Lenovo/code-dev/lattice-archive-v2/src/views/main/chats/conversation/MessageInlineKeyboard.vue#L28) 使用 `:key="colIdx"`。
  2. **`UpdateEditMessage` 早于 `GetBotCallbackAnswer` 返回（且许多 Bot 不调 `answerCallbackQuery`）**：
     - 当你在第 5 页点击 `(rowIdx=0, colIdx=2)` 的「回到首页」时，`pendingCallbacks["msgId:0:2"] = true`，并发起 `messages.GetBotCallbackAnswer`。
     - 机器人后台立刻调用 `editMessageText` 将消息和按钮改回第 1 页，Telegram 通过 WebSocket 瞬间推送 `UpdateEditMessage`。
     - 前端收到 `UpdateEditMessage` 后，消息的按钮数组立即变成第 1 页的布局（此时「回到首页」按钮已消失，`(0, 2)` 位置变成了「下一页」或「末页」）。
     - 但因为机器人没有调用 `answerCallbackQuery`，`GetBotCallbackAnswer` 请求在 Telegram 服务端一直挂起等待（长达 5~10 秒直至超时），`finally` 块迟迟不执行，`pendingCallbacks["msgId:0:2"]` 仍为 `true`。
     - 结果：旋转加载圈按 `(0, 2)` 坐标顺序“寄生”在了新页面的另一个按钮上！

### 3. 现象三：自动翻页往往只翻 1 页就停止了
- **触发链路（[`botHarvesterStore.ts:232-285`](file:///Volumes/Lenovo/code-dev/lattice-archive-v2/src/stores/chat/stores/botHarvesterStore.ts#L232-L285) 四处缺陷叠加）**：
  1. **未容错 `BOT_RESPONSE_TIMEOUT`（最直接死因）**：搜索机器人在收到翻页 Callback 后只调 `editMessageText` 更新消息，不调 `answerCallbackQuery`。Telegram 服务端在约 10 秒后对 `messages.GetBotCallbackAnswer` 返回 `RPCError 400: BOT_RESPONSE_TIMEOUT`。`startHarvestRange` 中的 `await chatDataSource.pressBotCallback(...)` 没有捕获该非致命异常，直接跳入外层 `catch (err)` 将任务标记为 `error` 终止！
  2. **缺乏 `UpdateEditMessage` 事件驱动等待**：点击按钮后没有监听该 `messageId` 的 `editMessage` 事件，而是盲目调 `getHistoryAround`，若机器人在 Callback 返回后数百毫秒才完成编辑，拉到的仍是旧页面。
  3. **循环页码硬编码从 `page = 1` 开始**：无视当前消息实际所处页码与用户设置的 `startPage`。
  4. **4 按钮布局识别不足**：`NEXT_BUTTON_REGEX` 对包含数字/箭头组合或「首页 / 上一页 / 下一页 / 尾页」4 按钮布局的匹配策略不够健壮。

### 4. 现象四：自动翻页未能正确绑定「我们发出的查询消息 ↔ 机器人回复的分页消息」
- **触发链路**：
  - [`BotHarvesterBanner.vue:40`](file:///Volumes/Lenovo/code-dev/lattice-archive-v2/src/views/main/chats/conversation/BotHarvesterBanner.vue#L40) 仅依赖 `props.message.replyToId` 查找用户发出的查询词。
  - 实际上大量 Telegram 搜索机器人在私聊中直接发送新消息而不带 `reply_to_message_id`；且受现象一影响，用户刚发出的消息甚至可能被冲掉，导致查询词退化为 `'bot-search'`，失去了「发出指令 ↔ 回复结果」的上下文因果关联。

### 5. 现象五：连接稳定性受影响，点击翻页或发消息偶发断连重连
- **触发链路**：
  1. **假性 `pts` Gap 引发同步风暴（Sync Storm）**：每发一条消息、机器人每回一条消息，都因现象一触发 `gap`，瞬间并发打出 `updates.GetDifference` + `messages.GetPinnedDialogs` + `messages.GetDialogs` + `messages.GetHistory` + `loadRemainingDialogs`。
  2. **连续未决的 `GetBotCallbackAnswer` 阻塞通道**：手动或自动翻页时，多个长达 10 秒才超时返回 `BOT_RESPONSE_TIMEOUT` 的请求叠加同步风暴，导致 GramJS 单连接 Ping/Pong 心跳超时，触发 `UpdateConnectionState.disconnected` 假性断连重连。
  3. **启动期温池并发争抢**：[`telegramStore.ts:335-351`](file:///Volumes/Lenovo/code-dev/lattice-archive-v2/src/stores/telegram/stores/telegramStore.ts#L335-L351) 在主账号刚恢复、正处于首屏高负载同步时，立即将所有备用账号的 `restoreWarmAccount` 塞入 Worker 串行队列 `commandQueue`，加剧了主连接抖动。

---

## 三、 架构治理原则：三层 + 双端实现域、SSOT 与统一居中网关

### 1. 严守「三层 + 双端 Worker 实现域」边界（不新增前端 `src/services/` 层）

全仓严格执行以下职责划分，**不新增平级的 `src/services/` 目录**，避免层级膨胀：

```mermaid
flowchart LR
    View["1. View 表现层\nsrc/views/**\n(零本地 ref/reactive\n零私有 store/types/utils)"]
    Store["2. Store 状态层 (SSOT)\nsrc/stores/<domain>/stores/\n(纯响应式视图状态、Getters\n禁止跨 Store 复制状态)"]
    Bridge["3. Data Source 薄桥接层\nsrc/stores/<domain>/data-sources/\n(极薄连接桥：转发调用与 DOM 句柄\n禁止重度业务逻辑与反向引 Store)"]
    LocalW["4A. Local Worker 实现域\nsrc/worker/local/\n(MTProto 统一网关、PTS 引擎、\nBot 自动翻页引擎、Session 解析)"]
    RemoteW["4B. Remote Worker 实现域\nsrc/worker/remote/\n(D1 鉴权、云同步、\n单行日志快照与 Agent 渐进查询)"]

    View <-->|"订阅状态 / 触发 Action"| Store
    Store <-->|"调用接口 / 接收事件"| Bridge
    Bridge <-->|"postMessage / BroadcastChannel"| LocalW
    Bridge <-->|"HTTP REST + X-Lattice-Debug"| RemoteW
```

#### 现有越界代码的归位清单：
1. **清理 `src/views/` 下的非视图文件**：
   - 将 `src/views/main/archive/store/tileStore.ts`、`archiveDomRegistry.ts`、`src/views/main/archive/types/tile.ts`、`src/views/main/archive/utils/layoutEngine.ts` 迁入 `src/stores/archive/` 对应目录，消除 `src/stores/` 反向 `import '@/views/...'` 的违规依赖。
2. **Data Source 瘦身为纯粹的「桥」**：
   - 将 [`sessionBatchImporter.ts`](file:///Volumes/Lenovo/code-dev/lattice-archive-v2/src/stores/archive/data-sources/sessionBatchImporter.ts) 中的 SQLite3 二进制页扫描、256B `auth_key` 提取与 `StringSession` 字节序编码下沉至 `src/worker/local/`；
   - 将 [`aggregateSearchDataSource.ts`](file:///Volumes/Lenovo/code-dev/lattice-archive-v2/src/stores/archive/data-sources/aggregateSearchDataSource.ts) 中直接 `useChatStore()` / `useSessionManagerStore()` 的耦合剥离，Data Source 只接收纯参数并桥接调用 `src/worker/local/`；
   - 将 [`botHarvesterStore.ts`](file:///Volumes/Lenovo/code-dev/lattice-archive-v2/src/stores/chat/stores/botHarvesterStore.ts) 中的翻页按钮解析、候选链接提取与自动翻页事件等待状态机下沉至 `src/worker/local/chat/`，Store 仅保留纯粹的响应式任务进度与候选列表状态。

---

### 2. 坚守 Pinia SSOT（唯一真相来源）铁律

**核心原则：任何一份业务数据在全仓只允许有 1 个权威真相来源（SSOT），如无必要绝不复制一份状态单独管理；其他模块一律通过 Getter 计算派生或通过事件订阅同步。**

| 状态域 | 唯一真相来源（SSOT） | 需要清理的冗余状态副本 |
| :--- | :--- | :--- |
| **账号列表、当前激活账号、连接状态、温池层级 (`P0/P1/P2`)** | `telegramStore`（由 `tg.worker` 驱动） | 移除 `chatStore` 中独立维护的 `connectionState` 副本（改为 Getter 直接读取 `telegramStore`）；移除 `sessionManagerStore` 中手动双写的账号连接态副本（改为 Getter 响应式组合 `telegramStore.accounts` 与配额元数据）。 |
| **MTProto `pts / qts / date / seq` 序列水位** | `src/worker/local/chat/` 内的 `engine.state` | 主线程 `chatStore.updatesState` 仅作为冷启动快照游标，无条件接受 Worker 广播的最新 `state`（移除 `if (this.syncPhase === 'live')` 的拒收条件）。 |
| **会话字典 (`dialogs`) 与消息窗口 (`windows`)** | `chatStore` | `botHarvester` 与 `aggregateSearch` 严禁绕过 `chatStore` 私自维护消息副本，统一读取或通过 `chatStore.applyUpdates` 唯一入口更新。 |

---

### 3. 敏感与不稳定业务的「统一居中管理总线（Unified Gateway）」

为了避免网络请求、`pts` 连续性推进、超时容错、配额扣减散落在几十个函数里各自为政，我们在双端桥接处设立两个集中式收口网关：

#### (1) 本地 Worker 侧：`mtprotoGateway`（位于 `src/worker/local/chat/mtprotoGateway.ts`）
所有主动发起的 GramJS `client.invoke(...)` 请求不再裸调，统一经由 `invokeWithGateway(engine, traceCtx, request)` 执行：
1. **统一 `pts` 状态机推进**：
   - 自动检测返回值类型：无论是 `Api.Updates`、`Api.UpdatesCombined`、`Api.UpdateShortSentMessage`（修复私聊发消息漏推进 `pts`）、还是 `Api.messages.AffectedMessages` / `Api.messages.AffectedHistory`（修复删除消息/历史漏推进 `pts`），统一调用 `advanceCommonPts(pts, ptsCount)` 推进 `engine.state.pts`！
2. **统一非致命异常归一化**：
   - 对 `messages.GetBotCallbackAnswer` 捕获 `BOT_RESPONSE_TIMEOUT`，自动转化为 `{ timeout: true }` 正常结构返回，绝不炸毁调用链；
   - 统一提取 `FLOOD_WAIT_X` 秒数并转换为结构化错误码与退避建议。
3. **统一实时事件唤醒钩子（Event Waiter）**：
   - 当收到 `UpdateEditMessage` 时，自动触发内部等待器（供自动翻页引擎毫秒级感知页面已翻页完成）并通知前端立即清除对应 `messageId` 的按钮旋转加载圈（Spinner）。
4. **统一 Trace Span 埋点**：
   - 自动记录每次 MTProto RPC 的方法名、耗时 `durMs`、前后 `pts` 变化与结果状态，当 `LOCAL` 调试标签开启时实时回传主线程。

#### (2) 远端 HTTP 侧：`remoteHttpBridge`（位于 `src/stores/_shared/remoteHttpBridge.ts`）
收口所有 `/api/auth/*`、`/api/admin/*`、`/api/tg/*`、`/api/explore/*`、`/api/debug/*` 的 `fetch` 调用：
1. 统一读取 `authSessionStorage` 注入 `Authorization: Bearer <token>`；
2. 当 `REMOTE` 调试标签开启时，自动注入 `X-Lattice-Debug: 1` 与 `X-Lattice-Trace-Id`，并自动从响应头 `X-Lattice-Debug-Trace` 解析服务端执行树推入前端调试终端；
3. 统一处理 HTTP 401 失效守卫与结构化中文错误解析。

---

## 四、 Cloudflare 生产环境可观测性求证与「零额外配额」设计

针对在 Cloudflare 生产环境（`https://lattice-v2.zhaowendao2005.workers.dev`）开启调试与回传日志的计费与配额问题，求证结论如下：

| 求证问题 | 权威结论与底层机制说明 |
| :--- | :--- |
| **(a) 远程 Worker 的日志信息（`console.log`）与后台的「可追踪事件（Observability Events）」是否等价？** | **完全等价，共用同一个配额池。** 在 `wrangler.jsonc` 开启 `observability` 后，每次请求本身算 1 个 Invocation 事件，且代码中**每调用 1 次 `console.log` / `console.error` 就会额外消耗 1 个可追踪事件配额**。 |
| **(b) 可追踪事件的配额与计费逻辑是什么？** | • **Free 免费计划**：每日包含 **200,000 条可追踪事件 / 天**（或 0.5 GB/天摄入量）。超出后当天自动停止采集云端日志（不扣费，UTC 00:00 重置）。<br>• **Paid 付费计划**：每月包含 **2,000 万条事件 / 月**（50 GB 摄入量），超出按 **$0.60 / 百万条事件**（或 $0.25/GB）计费。 |
| **(c) 将 Remote 调试日志回传到本地前端控制台，是否会产生多余计费（请求数/流量）？** | **采用「顺风车响应头夹带（Piggyback）」产生 0 额外请求、0 额外费用。** 开启 `REMOTE` 调试时，随原本就要发的业务请求附带 `X-Lattice-Debug: 1`，Remote Worker 在内存收集本请求内部步骤耗时，随响应头 `X-Lattice-Debug-Trace` 顺路带回前端。不增加任何请求次数，且 Cloudflare Workers 出站带宽（Egress）完全免费。 |
| **(d) 回传远端日志与上传 Gzip 日志快照，是否占用「可追踪事件」配额？** | **0 占用。** 因为内存收集与 HTTP 响应头回传不调用 `console.log`，不会被 Cloudflare 日志采集器计入 Observability Events 配额。 |

---

## 五、 开发者选项「三端无圆角终端 + 时间轴拖拽视口 + Agent 渐进式查询系统」详细设计

### 1. 前端设置页「高性能无圆角调试终端」设计（[`DeveloperSettingsView.vue`](file:///Volumes/Lenovo/code-dev/lattice-archive-v2/src/views/main/settings/subviews/DeveloperSettingsView.vue)）

```text
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│ CAPTURE: [ LOCAL ● ] [ REMOTE ● ] [ FRONTEND ○ ]   │ [ LIVE ● ] [ PUSH SNAPSHOT ]            │
│ FILTER:  [ grep: pts / messageId / traceId...    ] │ [ 🤖 AGENT SKILL ] [ COPY ] [ .LOG ]    │
├──────────────────────────────────────────────────────────────────────────────────────────────┤
│ TIMELINE [20:10:00.000 ────────────┼█████████████┼──────────────────────────── 20:15:30.420] │
│          (支持拖拽滑块快速平移观察时间窗、拖拽左右边缘缩放区间；红/黄刻度指示 ERROR/WARN)    │
├──────────────────────────────────────────────────────────────────────────────────────────────┤
│ ▼ [T:8f3a1c] [+0ms] (dur:192ms) [LOCAL:chat.send] sendMessage | peer=user-5512               │
│   ├─ [S:01] [+2ms] (dur:185ms) [LOCAL:tg.gateway] invoke | method=messages.SendMessage       │
│   ├─ [S:02] [+187ms] [LOCAL:chat.pts] advance_pts | UpdateShortSentMessage 100->101 -> APPLY │
│   └─ [S:03] [+190ms] [FRONTEND:chat.store] upsert_outbox | msgId=8801 continuous=true        │
│ ▶ [T:c41d09] [+410ms] (dur:14ms) [LOCAL:chat.updates] UpdateEditMessage | msgId=8802         │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

1. **三个无圆角独立采集标签（`rounded-none`）**：
   - `LOCAL` / `REMOTE` / `FRONTEND` 均采用 `rounded-none border border-border px-3 py-1 font-mono text-xs` 无圆角设计；
   - 点击即高亮激活（`bg-brand text-white border-brand`），代表打开该端日志回传与采集；支持任意多选组合。
2. **时间轴观察视口拖拽器（Timeline Viewport Scrubber）**：
   - 将整个采集缓冲区的起止时间（`minTime` ~ `maxTime`）映射为横向时间轴轨道，并在轨道上绘制日志密度柱与 `WARN` / `ERROR` 高亮锚点；
   - 用户可按住视口滑窗左右快速拖拽，实时过滤并定位到任意时间切片（`[viewStartTime, viewEndTime]`）；
   - 手动拖拽视口或向上滚动终端时，自动解除 `[ LIVE ]` 实时跟随锁定；再次点击 `[ LIVE ]` 立即吸附回最新实时流。
3. **防卡顿性能优化（Zero-Jank）**：
   - **RAF 批量入队**：高并发日志先入非响应式队列，通过 `requestAnimationFrame` 每帧批量合并入 Ring Buffer（容量上限 5,000 条）；
   - **定高虚拟列表切片**：终端行高固定为 `22px`，根据滚动高度 `scrollTop` 仅渲染可视区内的 ~35 行 DOM 节点，彻底杜绝万级日志卡顿；
   - **零本地 `ref`**：所有滚动容器句柄、时间轴指针拖拽状态均托管在 `debugLoggerDataSource` 与 `debugLoggerStore` 中。

---

### 2. 结构化 + Grep 友好 + 分级折叠树 + 时间轴日志标准格式

每条日志兼具 **单行 Grep 检索锚点** 与 **父子 Span 树状层级关系**：

```text
[LATTICE][T:8f3a1c][S:01.02][2026-11-01T20:12:05.120Z][+187ms][dur:1ms][INFO][LOCAL:chat.pts] advance_pts | account=718293 peer=user-5512 oldPts=100 newPts=101 ptsCount=1 verdict=apply
```
- **字段语义**：
  - `[LATTICE]`：全局固定标识；
  - `[T:8f3a1c]`：跨端贯穿同一次业务操作的根 Trace ID；
  - `[S:01.02]`：体现父子调用层级的 Span ID（`01` 为父节点，`01.02` 为第 2 个子节点）；
  - `[2026-11-01T20:12:05.120Z]`：绝对 ISO 时间戳；
  - `[+187ms]`：相对于根 Trace 起点（`T:8f3a1c`）的相对时间轴偏移；
  - `[dur:1ms]`：当前步骤自身耗时；
  - `[INFO]`：日志级别（`DEBUG` / `INFO` / `WARN` / `ERROR`）；
  - `[LOCAL:chat.pts]`：`端源:业务域`（端源为 `LOCAL` / `REMOTE` / `FRONTEND`）；
  - `advance_pts | key=value ...`：动作名与结构化键值对（自动脱敏 `session`、`token`、`password`、`apiHash`）。

---

### 3. 免 MCP 的「Agent 渐进式查日志系统 + 访问密钥管理」设计

为了避免配置传统 MCP 的繁琐流程，同时让 Agent 能直接在 Cloudflare 生产环境（`https://lattice-v2.zhaowendao2005.workers.dev`）自主、高效、低请求次数地查阅运行日志，我们设计如下闭环：

#### (1) 交互流程：Hover 提示按钮 + 一键复制「接口 + Skills + 密钥」
- 在设置页日志终端工具栏提供一个按钮 **`[ 🤖 AGENT SKILL ]`**。
- **Hover 交互**：鼠标悬停（Hover）在该按钮上时，弹出浮层提示：**「使用 Agent 来查阅运行日志（点击复制接口地址、渐进式查询 Skills 说明与访问密钥）」**。
- **点击行为**：点击后，若已将当前内存日志快照同步至云端（或点击时自动触发一次 `PUT /api/debug/snapshot` 单包 Gzip 同步），立即将一段**自包含的 Markdown 指引（含接口 URL、当前有效密钥 `lat_agk_...` 及四阶渐进式查询 Skills 文档）**复制到剪贴板。你只需粘贴发给 Agent，Agent 即可直接用 `curl` 或内置工具自主按需查询！

#### (2) 访问密钥（Agent Access Key）的创建、管理与生命周期
在「设置 → 开发者选项」下方提供 **「Agent 日志访问密钥管理」** 卡片：
- **创建密钥**：输入备注名（默认 `Agent 调试密钥`），选择生命周期档位：
  - `1 小时` / `24 小时`（默认推荐） / `7 天` / `30 天` / `永不过期`
- **安全存储（D1 `agent_debug_keys` 表）**：
  - 密钥格式：`lat_agk_<32位随机十六进制>`；
  - 远端 D1 数据库仅存储密钥的 **SHA-256 哈希摘要**（与会话 Token 安全级别一致）、前缀掩码 `key_prefix`、过期时间戳 `expires_at` 与最后使用时间 `last_used_at`；
  - 每次 Agent 调用查询接口时，必须在 Header 携带 `Authorization: Bearer lat_agk_...`（或 URL 参数 `?key=lat_agk_...`），服务端校验哈希匹配且未过期后，仅允许读取该密钥所属 `user_id` 的日志快照；
  - 支持在设置页随时一键吊销（删除）任意密钥。

#### (3) 类文件系统的「四阶渐进式查询接口」（`GET /api/debug/agent/query`）
为了让 Agent 像在系统文件管理器里翻阅目录、配合 `grep` 逐步缩小范围一样，在 **几次到十几次查询以内** 就能精准定位根因（且**绝不在服务端硬性限制 Agent 的查询次数**，Agent 想怎么查就怎么查），接口原生支持 **公共过滤参数** 与 **4 种渐进式探索模式**：

- **公共过滤参数（所有模式通用）**：
  - `from` & `to`：**时间区间过滤**（支持毫秒时间戳、ISO 时间字符串，或相对偏移如 `from=-5m`、`from=+1200ms`）；
  - `source`：按端源过滤（`local`、`remote`、`frontend`，支持逗号分隔）；
  - `domain`：按业务域目录前缀过滤（如 `chat.pts`、`tg.gateway`、`bot.harvester`）；
  - `level`：按级别过滤（如 `WARN,ERROR`）。

- **四阶渐进式查询模式（`mode`）**：

```mermaid
flowchart TD
    M1["第 1 步：全局概览与目录树\n?mode=overview (类似 ls -la /)\n返回总时间跨度、各 /source/domain 的日志数/警告数/错误数\n以及异常热点所在的时间戳与 traceId"]
    M2["第 2 步：按时间区间与域浏览时间轴索引\n?mode=timeline&domain=chat.pts&from=...&to=...\n(类似 ls /local/chat.pts)\n返回该时间窗内的根 Trace 摘要列表与耗时概览"]
    M3["第 3 步：结构化 Grep 检索\n?mode=grep&q=verdict=gap&from=...&to=...\n(类似 grep -rn)\n按正则/关键词/key=value 精准匹配日志行及其所属 traceId"]
    M4["第 4 步：展开指定 Trace 完整调用树\n?mode=trace&traceId=8f3a1c\n(类似 cat /traces/8f3a1c)\n输出该 Trace 下所有父子 Span 的完整分级树与 +Δms 时间轴"]

    M1 -->|"发现某域或某时间段有异常"| M2
    M1 -->|"直接搜特定关键词/错误码"| M3
    M2 -->|"锁定目标 traceId"| M4
    M3 -->|"拿到匹配行的 traceId"| M4
```

#### (4) 点击按钮复制到剪贴板的「Agent 渐进式查日志 Skill 模板」示例
当你点击该按钮时，剪贴板生成的内容如下：

````markdown
# Lattice Archive 运行日志渐进式检索 Skill

你可以通过以下只读 HTTP 接口直接渐进式查询当前系统的运行日志（涵盖 `local` Worker、`remote` Worker 与 `frontend` 状态流）。请像翻阅文件目录与使用 `grep` 一样，先看全局域概览，再按时间区间或关键词下钻到具体调用树。

## 1. 认证与基础端点
- **Endpoint**: `https://lattice-v2.zhaowendao2005.workers.dev/api/debug/agent/query`
- **Access Key**: `lat_agk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx` (有效期至: 2026-11-02 20:15:00)
- **Header**: `Authorization: Bearer lat_agk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`

## 2. 通用过滤参数（所有 mode 均支持）
- `from` / `to`: 时间区间（支持 Unix ms、ISO 时间或相对时间如 `-10m`、`-60s`）
- `source`: `local` | `remote` | `frontend`（可逗号分隔）
- `domain`: 业务域前缀（如 `chat.pts`、`tg.gateway`、`bot.harvester`、`chat.store`）
- `level`: `DEBUG` | `INFO` | `WARN` | `ERROR`

## 3. 推荐渐进式排查步骤（Progressive Drill-Down）
1. **第一步：查看全局域目录树与异常热点 (`mode=overview`)**
   ```bash
   curl -s -H "Authorization: Bearer <KEY>" "<ENDPOINT>?mode=overview"
   ```
2. **第二步：按感兴趣的时间区间与业务域查看时间轴索引 (`mode=timeline`)**
   ```bash
   curl -s -H "Authorization: Bearer <KEY>" "<ENDPOINT>?mode=timeline&source=local&domain=chat.pts&from=-10m&limit=50"
   ```
3. **第三步：使用 Grep 检索特定事件、消息 ID 或状态 (`mode=grep`)**
   ```bash
   curl -s -H "Authorization: Bearer <KEY>" "<ENDPOINT>?mode=grep&q=gap|BOT_RESPONSE_TIMEOUT|peer=user-"
   ```
4. **第四步：展开目标 Trace 的完整分级调用树与时间轴 (`mode=trace`)**
   ```bash
   curl -s -H "Authorization: Bearer <KEY>" "<ENDPOINT>?mode=trace&traceId=8f3a1c,c41d09"
   ```
````

---

## 六、 规范固化清单（`.rules/` 与 `AGENTS.md` 同步更新）

为确保后续所有迭代严格遵守本次确立的架构准则，将在 `.rules/state-management.md`、`.rules/frontend-architecture.md`、`.rules/remote-worker.md` 与 `AGENTS.md` 中写入以下硬性约束：

1. **三层 + 双端实现域铁律**：
   - `Store` 是 `View` 的响应式状态与唯一真相来源（SSOT）；
   - `Data Source` 仅作为 `Store` 与底层真相来源之间的**薄桥接层（Thin Bridge）**，严禁反向引用 Pinia Store，严禁在 Data Source 中编写重度业务解析或状态编排；
   - 具体的业务实现一律归入 `src/worker/local/` 与 `src/worker/remote/`；严禁在 `src/views/` 下创建私有的 `store/`、`types/`、`utils/`。
2. **SSOT 禁重铁律**：
   - 严禁在多个 Store 中复制同一份业务状态分别管理；跨模块状态共享一律通过 Pinia Getter 派生或事件总线订阅。
3. **敏感请求统一网关铁律**：
   - 本地 Worker 所有主动 `client.invoke` 必须经由 `mtprotoGateway` 统一推进 `pts`、归一化超时/限流错误并记录结构化 Trace Span；
   - 远端 HTTP 请求必须经由统一请求桥接器处理鉴权与顺风车调试头。
4. **结构化树状时间轴日志铁律**：
   - 所有跨边界关键操作必须接入统一结构化日志系统（具备 `[LATTICE][T:traceId][S:spanId][timestamp][+relMs][dur:ms][LEVEL][SOURCE:domain]` 格式），支持按时间区间与渐进式四阶模式（`overview` / `timeline` / `grep` / `trace`）检索，且严禁将任何密钥、密码、Session 字符串写入日志或快照。

---

## 七、 分阶段实施路线图

| 阶段 | 核心任务 | 产出与验证 |
| :--- | :--- | :--- |
| **Phase 1：本地 Worker 统一网关与聊天/翻页 5 大 Bug 根治** | 1. 新建 `src/worker/local/chat/mtprotoGateway.ts` 统一推进 `pts`（修复 `UpdateShortSentMessage` 与 `AffectedHistory` 漏更 `pts` 导致的吞消息与假性 Gap 风暴）；<br>2. 容错 `BOT_RESPONSE_TIMEOUT`，并在收到 `UpdateEditMessage` 时实时清除 `pendingCallbacks` 旋转加载圈；<br>3. `MessageInlineKeyboard.vue` 修正 `:key` 与按钮唯一标识绑定；<br>4. 重构 `botHarvester` 为 `UpdateEditMessage` 事件驱动翻页 + 自动回溯绑定「我方发出查询 ↔ 机器人回复」+ 4 按钮识别；<br>5. 错峰延迟 `warmUpStandbyAccounts` 提升连接稳定性。 | 发消息给机器人回复后不再吞消息；点击「回到首页/末页」加载圈不再错位残留；自动翻页连续稳定翻完多页且精准展示关联查询词。 |
| **Phase 2：三层架构归位与 SSOT 去重** | 1. 将 `src/views/main/archive/` 下的 `store/`、`types/`、`utils/` 迁入 `src/stores/archive/` 与 `src/worker/local/`；<br>2. 将 `sessionBatchImporter` 等重度逻辑下沉至 `src/worker/local/`，保持 `data-sources/` 纯薄桥接；<br>3. 清理 `chatStore` 与 `sessionManagerStore` 中的重复连接状态字段。 | `src/views/**` 100% 纯视图组件；Data Source 零反向 Store 依赖；SSOT 单一数据源。 |
| **Phase 3：远端 D1 迁移、单行 Gzip 日志快照与 Agent 渐进式查询 API** | 1. 新增 `0005_init_debug_agent_schema.sql`（`agent_debug_keys` + `user_debug_snapshots` 单行表）；<br>2. 实现 `/api/debug/keys`（含生命周期设置）、`PUT /api/debug/snapshot` 与 `GET /api/debug/agent/query`（支持 `overview` / `timeline` / `grep` / `trace` 四阶模式与 `from`/`to` 时间区间）；<br>3. 实现 `X-Lattice-Debug: 1` 顺风车响应头回传。 | 0 额外云端 Observability Event 配额消耗；Agent 凭密钥可在数次渐进查询内定位任意问题。 |
| **Phase 4：设置页「无圆角三端终端 + 时间轴视口拖拽 + 一键复制 Agent Skill」与规范固化** | 1. 重构 `DeveloperSettingsView.vue`：实现 `LOCAL` / `REMOTE` / `FRONTEND` 三个无圆角标签、定高虚拟列表终端、时间轴视口拖拽滑窗、`[ LIVE ]` 开关、Hover 提示的 `[ AGENT SKILL ]` 一键复制按钮与密钥管理面板；<br>2. 更新 `.rules/*` 与 `AGENTS.md`，执行 `pnpm build` 全量验证。 | 终端万级日志 60fps 零卡顿；Hover 显示提示、点击复制完整接口+Skills+密钥；`pnpm build` 零错误通过。 |
