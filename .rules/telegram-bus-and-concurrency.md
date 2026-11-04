# Telegram Bus 与并发架构规则

本文是 Telegram / GramJS 数据面的强制规则。设计背景见 [`docs/research/gramjs-business-bus-rearchitecture.md`](../docs/research/gramjs-business-bus-rearchitecture.md)；若两者冲突，以本规则和可执行架构门禁为准。

## 唯一调用链

```text
View（零 ref）
  → 业务 Store（SSOT）
    → 业务 Data Source（薄桥）
      → telegramBusClient
        → mtprotoBridge / tg.worker
          → BusRouter
            → 一条业务总线
              → RequestScheduler
                → TransportKernel
                  → 唯一 TelegramClient / GramJS
```

业务层不得跳层。视图不得调用总线、MTProto Bridge 或 `fetch` Telegram API；Store 不得导入 GramJS；Data Source 只组装参数、生命周期句柄和桥接调用，不得实现 RPC 或并发池。

## 业务总线职责

| 总线 | 负责 | 不负责 |
| --- | --- | --- |
| `account` / AccountSessionBus | 账号登录、会话恢复、账号健康与会话槽位 | Chat 内容、媒体展示 |
| `chatRead` / ChatReadBus | Dialog、历史、补差、PTS 与实时更新 | Search、写操作 |
| `search` / SearchBus | Telegram 消息检索、游标与过滤 | 封面下载 |
| `cover` / CoverBus | 头像、照片缩略图、文档/视频封面 | 完整媒体与播放 |
| `mediaAsset` / MediaAssetBus | 完整媒体文件下载与取消 | Range 流播放 |
| `stream` / StreamBus | 对齐分片、Range、seek、流取消 | 封面与完整文件策略 |
| `chatCommand` / ChatCommandBus | 用户显式触发的会话读写命令 | Bot 按钮交互 |
| `bot` / BotInteractionBus | Bot 启动、Callback、分页与候选解析 | 普通 Chat 命令 |
| `vault` / VaultTransferBus | 保险库转存、受限媒体克隆、信标同步 | 普通媒体查看 |

共享内核只有 `TransportKernel`、`RequestScheduler`、`EntityReferenceStore`、`TelemetryKernel`。总线之间不得直接调用对方实现；共用能力应下沉共享内核或由上游 Store 顺序编排。

## 新增操作准入

新增 bus/op 必须同一变更中完成：

1. `contracts/buses.ts` 输入/输出 DTO 与错误语义。
2. `runtime/busRouter.ts` 完整路由，并指定调度 lane、优先级、RPC method。
3. `telegramBusClient.ts` 类型安全的薄桥方法。
4. `contracts/monitor.ts` 子池/总线覆盖与可观测字段。
5. 业务测试、取消/账号切换边界测试和架构契约测试。
6. 本规则与 research 实施记录按需更新。

禁止增加方法字符串 if-chain、第二套 worker dispatcher 或兼容旧协议的旁路。

## Request 上下文与生命周期

所有 bus request 都由 `telegramBusClient` 生成唯一 requestId / traceId，并带 accountId、bus/op、source、priority；可取消操作必须带 AbortSignal。不得跨账号复用 peer、实体引用、媒体缓存或 in-flight 结果。账号切换、运行时销毁、查看器关闭和任务取消必须使旧请求失效，过期响应不得回写新账号状态。

Worker 只向主线程回传 DTO 与可转移字节，不回传 GramJS 异常对象。错误必须通过统一领域错误分桶；请求需经过 `bus.request` 结构化 Span。日志与监控帧不得包含消息正文、会话标题、文件名、访问令牌、access_hash 或文件引用明文。

## 并发预算

- 所有并发数字的唯一来源是 `src/worker/local/telegram/contracts/concurrency.ts`。禁止业务总线、Store、Data Source、视图各自定义并发池或硬编码并发。
- 用户配置是上限；`RequestScheduler` 的运行时有效值可以因 FloodWait、网络超时和账号状态下降并逐步恢复，但不得超过或回写用户配置。
- 自定义并发**没有固定数值上限**，只有最小值（`TELEGRAM_CONCURRENCY_MINIMUMS`）与层级依赖（`TELEGRAM_CONCURRENCY_PARENT`）：非媒体子池 ≤ `nonMediaRpc`，媒体子池（封面 / 头像 / 文件分片 / 流分片）≤ `mediaRpc`，`searchCoverReserved` ≤ `cover`，`totalActiveTasks` ≥ max(`nonMediaRpc`, `mediaRpc`)；`fullMedia` 无上级。新增并发字段必须同时声明最小值与所属上级，并同步设置页依赖说明（`ConcurrencyCustomForm.vue`）。
- 账号只有一个活跃 `TelegramClient` 和一个账号级 scheduler。不得复制 session/连接来扩容。
- 所有 lane/subpool 同时受所属组预算与账号总预算约束；搜索封面保留槽位必须保留。
- 批量 RPC 必须进入有界队列并受 scheduler 控制；禁止对 Telegram RPC 使用无界 `Promise.all`。
- FloodWait 必须熔断对应 bucket 并尊重 retryAfter；取消必须可从队列移除；账号停用需拒绝新任务并取消等待任务。

## GramJS 与实体引用边界

- `TelegramClient` 实例只由 Telegram runtime / transport 创建并持有；不得从 Store、View、通用 Data Source 暴露。
- `Api.*`、`client.invoke()`、`downloadFile()`、`iterDownload()` 只允许存在于 `src/worker/local/telegram/` 总线实现或共享内核。
- peer/access_hash/file_reference 等临时授权定位信息只在本地 Worker、必要的本机资源 manifest 和加密存储中流转；禁止发往 Lattice 远端 D1。
- 新的解析器是纯 DTO/纯函数，不执行 RPC；必须放在 Worker 域对应 bus/parser，不得反向引用 `@/stores/**`。

## 检查清单

改动 Telegram bus / scheduler / 媒体流时：

- [ ] `pnpm arch:check`
- [ ] `pnpm test:bus`
- [ ] `pnpm test:scheduler`
- [ ] `pnpm build`
- [ ] 真实账号验证账号切换、取消、FloodWait 与主要业务路径

架构门禁是规范的一部分：任何规则若无法被机器检查，必须明确记录为什么需要人工验收以及责任范围。
