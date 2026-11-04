# 状态管理与数据流规范 (State Management & Data Layer Rules)

本规范规定了全仓的状态治理、Pinia 业务域划分以及 Mock 数据的组织与生命周期准则。

---

## 一、 视图层零 ref 铁律 (Zero Local Ref in Views)

1. **禁止在 View 中定义本地 `ref` / `reactive`**：
   * 业务页面与视图组件内**严禁散落声明本地响应式状态**（如 `const isOpen = ref(false)`、`const chatList = ref([])`）。
   * 视图组件仅作为纯表现层（Presentation Layer），其所有渲染数据和交互状态一律通过 Pinia Store 进行读取与派发。
2. **核心收益**：
   * 杜绝组件销毁重建时的状态丢失；
   * 消除父子/兄弟组件传参地狱与状态多源同步错乱；
   * 使得所有交互与网络状态具备全局可观察性与时间旅行调试能力。

---

## 二、 Pinia 业务域目录体系 (`src/stores`)

状态管理在 `src/stores/` 下必须按照**业务域（Business Domain）**划分独立目录。每个业务域内遵循严格的三层架构分工：

```text
src/stores/
├── app/                           # 应用全局环境域（平台类型、尺寸令牌、侧栏展开态、主题）
│   └── stores/appStore.ts          # 含 isSectionSwitching（分区切换缓冲遮罩，由 src/router/workspaceTransition.ts 驱动）
├── chat/                          # 核心业务域：Telegram 会话与消息（只读，已接线真实数据）
│   ├── types.ts                   # Worker DTO 再导出、消息窗口、冷启动快照、视图模型、媒体与播放器状态
│   ├── data-sources/
│   │   ├── chatMediaCache.ts     # AES-GCM 加密媒体缓存与生命周期
│   │   ├── chatMediaLoader.ts    # 图片/视频去重、优先级、并发与取消
│   │   ├── chatPreferences.ts    # 自动下载策略、播放器偏好持久化
│   │   ├── messageViewport.ts    # 消息流滚动容器句柄 + 预取（600px）、头像（240px）与自动播放（50% 可见）IntersectionObserver
│   │   ├── progressiveStream.ts  # 大视频渐进式播放桥接：注册 /sw.js、512 KiB 对齐分片、24 块内存 LRU、前 2 MiB 加密缓存
│   │   └── videoPlayback.ts      # HTMLVideoElement 槽位单例（viewer / gif / round）、全屏、画中画与编解码探测
│   └── stores/
│       ├── chatStore.ts          # 会话列表（活动/归档）、公开用户名查找、加入/退出会话、消息窗口、同步阶段、缓存调度
│       ├── chatMediaStore.ts     # 头像/缩略图/原图加载、统一查看器状态（旋转/缩放/胶片条）、自动下载策略
│       ├── chatVideoStore.ts     # 视频渐进流/完整下载、画质切换、查看器播放控制、GIF 与圆视频单实例播放
│       ├── chatFileStore.ts      # 非视频附件（文件 / 音频 / 语音）下载：字节进度、取消、完成后触发浏览器保存
│       └── chatModel.ts          # 纯函数：窗口合并、相册聚合、画质选择、格式化、快照裁剪
├── telegram/                      # Telegram 账号、连接与性能配置域
│   ├── data-sources/
│   │   ├── telegramBusClient.ts    # 主线程唯一 Telegram 业务总线入口（薄桥）
│   │   ├── mtprotoBridge.ts        # 主 / 从标签页 Worker 桥接与并发配置下发
│   │   ├── telegramPerformancePreferences.ts # 并发配额持久化与通知
│   │   └── telegramMonitorDataSource.ts # 运行监控订阅、帧缓冲与 Canvas 句柄
│   │   └── telegramMonitorDataSource.ts # 运行监控订阅租约、任务增量缓冲、环形时间序列、rAF 合并提交与 Canvas 句柄
│   └── stores/
│       ├── telegramStore.ts        # 账号、连接状态唯一来源
│       ├── telegramPerformanceStore.ts # 设置 → 性能与网络：模式、自定义草稿、校验与保存
│       └── telegramMonitorStore.ts # 设置 → 开发者选项 → Telegram 连接监控：账号、筛选、帧率、暂停、浅层帧快照
├── auth/                          # 登录与用户认证域
│   ├── data-sources/
│   │   ├── authSessionStorage.ts   # 会话持久化：token + user + expiresAt 读写
│   │   ├── authRemoteDataSource.ts # 远端聚合服务器 API 单例（register/login/connect/logout）
│   │   └── turnstileBridge.ts      # Turnstile SDK 加载、渲染、reset 与 widget 句柄
│   └── stores/
│       ├── authStore.ts            # 会话身份、表单草稿、请求态、错误态、Turnstile Token
│       └── wallpaperStore.ts       # 登录页壁纸轮替索引与自动播放
├── admin/                         # 管理员业务域
│   ├── types.ts                    # 管理用户与服务端分页契约
│   ├── data-sources/
│   │   └── adminUsersRemoteDataSource.ts # 管理用户 API 单例
│   └── stores/
│       └── adminUsersStore.ts      # 用户列表、搜索分页、弹窗、表单与删除目标
└── archive/                       # 收藏与归档域
    └── stores/archiveStore.ts
```

**注意**：主 Tab 与会话/设置子页的选择态**不在此目录**——它们是路由（见 `frontend-architecture.md` 第五节）。
`appStore` 内禁止再出现 `activeTab` / `activeSettingsTab` 之类的位置字段。

---

## 三、 三类状态分层定义与职责

### 1. Data Source 类 (薄桥接层 / Thin Bridge)
* **定位**：业务域内连接 Store (View 状态) 与具体实现域 (`src/worker/local/` & `src/worker/remote/`) 的**薄桥接器**，以及零 `ref` 视图所需的 DOM / 浏览器句柄托管器。
* **核心红线（禁止新增 `src/services/` 层，禁止承载重业务逻辑）**：
  * **严禁新建顶层 `src/services/` 目录**：所有具体业务实现、协议解析、加密加压、分页拆包、SQLite/GramJS 调度一律下沉到 `src/worker/local/`（本地 Worker 实现域）或 `src/worker/remote/`（远端 Cloudflare Worker 实现域）；
  * **Data Source 只做「薄桥（Thin Bridge）」**：仅负责把 Store 的意图转发给 `local` Worker（经 `mtprotoHub` / Worker 通信）或 `remote` Worker（经 `fetch('/api/...')`），以及托管浏览器端原生句柄（如 `HTMLVideoElement`、`IntersectionObserver`、Turnstile `widgetId`、终端滚动与时间轴滑轨 DOM 句柄）；
  * 任何超过简单参数组装的业务逻辑（如二进制/JSON 批解析、MTProto 差量状态机、Bot 按钮页码启发式解析）必须下沉至 `src/worker/local/` 或 `src/worker/remote/`。

### 2. Stores 类 (View 状态与唯一真相来源 SSOT)
* **定位**：纯粹负责该业务域内页面的响应式状态存储、计算属性（Getters）与交互动作（Actions）。
* **SSOT（Single Source of Truth，唯一真相来源）铁律**：
  * **严禁跨 Store 复制状态**：如果某个状态已归属某 Store（例如当前激活账号 `telegramStore.currentAccountId`、连接状态 `telegramStore.connectionStates`、会话列表 `chatStore.dialogs`），其他 Store 只能通过 Getter 或直接读取源 Store 引用，**严禁在另一处复制一份状态再靠 watch / 回调同步**；
  * 网络请求的加载态（如 `isSubmitting`）、错误文案（如 `authError`）与一次性校验令牌（如 `turnstileToken`）属于页面状态，必须落在 Store，视图层只读。

### 2.1 鉴权域的数据流（强制）

```text
View（零 ref）
  → authStore action（submitLogin / submitRegister / submitAdminLogin / logout）
    → authRemoteDataSource（唯一的远端 API 入口）
      → Remote Worker /api/auth/*
```

* **接线即删**：接通远端鉴权后，禁止保留 `DEFAULT_USER` 之类的静态身份/登录兜底；
* **DOM 句柄不进视图**：Turnstile 的脚本注入、`render`、`reset`、`remove` 与 widgetId 统一由 `turnstileBridge` 单例管理，视图只挂载固定容器；
* **失败可回滚**：登录/注册请求在 `finally` 中重置一次性 Turnstile 令牌；退出登录即使远端不可达也必须先清理本地会话。

### 2.2 管理用户域的数据流（强制）

```text
Admin View（零 ref）
  → adminUsersStore action（load / create / remove / applySearch）
    → adminUsersRemoteDataSource
      → Remote Worker /api/admin/users
```

* 搜索草稿、已生效搜索词、分页、排序、加载/错误态、新增/删除弹窗及删除目标全部归 Store；
* 管理员 Token 只从 `authStore` 获取，不在 `adminUsersStore` 复制或另行持久化；401 必须清理失效会话；
* 列表请求使用版本号丢弃过期响应；离开页面时使在途请求失效，并清理密码、删除目标和列表敏感状态；
* 删除成功以服务端结果为准，随后重新拉取当前有效页，禁止仅在前端移除一行作为成功依据。

### 2.3 聊天域的数据流（强制）

```text
Chats View（零 ref，路由参数 /workspace/chats/:chatKey 决定选中会话）
  → chatStore action（openChat / loadOlder / syncNow / handleFeedScroll）
    → chat 域 Data Source（薄桥接）→ telegramBusClient
      → mtprotoBridge → 本地 tg.worker
        → BusRouter → ChatReadBus / ChatCommandBus / 其他对应总线
          → RequestScheduler → TransportKernel → Telegram DC
  ← Worker 广播 chatUpdates → 各标签页 chatStore.applyUpdates
```

* **内容不出设备**：会话、消息、access_hash 只在本地 Worker / 内存 / 加密 IndexedDB 中流转，禁止发往 Lattice 远端或 D1；
* **账户与连接只认 telegramStore**：`currentAccountId` / `connectionStates` 是唯一来源，chatStore 只订阅；工作区引导由 `AppLayout` 以当前 Lattice 用户调用 `chatStore.initialize(userId)`，换人登录必须清空上一位用户的内存态；
* **缓存 ≠ 已同步**：`syncPhase` 必须区分 `cache`（仅本地快照）与 `live`（已补差并刷新首页），UI 不得把缓存命中显示为已同步；
* **窗口连续性**：消息窗口是以最新消息为右端的连续区间；`continuous=false` 的窗口禁止插入实时消息，打开时以服务器最新页校准；
* **代次丢弃**：所有异步响应按账户代次与窗口 `epoch` 校验，过期结果直接丢弃，不得串到其他会话；
* **消息只读与显式会话管理**：不发送消息、不调用已读 RPC，后台预载不得改变 Telegram 服务端状态；仅用户主动触发的归档/取消归档（`folders.EditPeerFolders`）、公开 `@username` 查找（`contacts.ResolveUsername`）、加入公开频道/群组（`channels.JoinChannel`，`INVITE_REQUEST_SENT` 必须标记为 `pending` 而非已加入）与二次确认退出（`channels.LeaveChannel` / `messages.DeleteChatUser`，创建者受角色保护拒绝直接退出，且仅在 RPC 成功后清理本地状态）允许变更会话列表状态；
* **媒体与头像分级加载**：消息与会话 DTO 携带照片/视频定位信息、头像信息（`TgAvatarInfo`）与内联模糊缩略图；头像由 `v-avatar-visible` 指令按视口可见性请求（低优先级 `PRIORITY_AVATAR = 3` + Worker `RequestScheduler` 的 `avatar` 子池）；预览图与视频封面由 `v-media-visible` 指令按自动下载策略请求；查看器视频优先走 `progressiveStream`（Service Worker `/sw.js` 拦截 Range 请求 → 512 KiB 对齐分片 `getDocumentPart` → `206 Partial Content`），不支持或解码报错时自动降级为完整 Blob 下载，关闭查看器、翻页或切换会话时立即通过 `AbortSignal` → `chatCancel` 中止在途分片；GIF 与圆形视频由 `v-media-playing` 指令在 ≥ 50% 可见且允许自动播放（≤ 10 MB）时静音循环，点击圆形视频切换单实例有声播放；占位尺寸在下载前锁定，媒体加载不得改变气泡高度；
* **媒体句柄与缓存**：Object URL 只由 `chatMediaLoader` 创建与回收（图片 400 条 LRU，视频 256 MB 字节预算 LRU 且活跃播放槽位 `pin` 保护，切换账户时全部 revoke），`HTMLVideoElement` 与全屏容器句柄只由 `videoPlayback` 单例持有，Store 中只存 URL 字符串与可序列化播放状态；持久缓存（含渐进式视频前 2 MiB 分片）只走 `chatMediaCache`（设备密钥加密的 Cache Storage，按 Lattice 用户 / Telegram 账户隔离，单条 ≤ 20 MiB，授权失效时整体清除），禁止写入未加密的媒体字节；
* **MTProto 更新状态与 Bot 回调收口铁律**：
  - 所有会推进账号 `pts` 的 RPC 结果必须由 `src/worker/local/telegram/runtime/updateEngine.ts` / `transportKernel.ts` 的 `advancePtsFromRpcResult` 统一推进；禁止业务总线各自维护 pts 或绕过更新状态机。
  - `BOT_RESPONSE_TIMEOUT` 是应用层业务状态（机器人在静默改写消息后未显式调用 `answerCallbackQuery`），**严禁将其归入 `tg.worker.ts` 的 `isTransient` / `isTimeout` 连接重连条件**，且在收到 `UpdateEditMessage` 时必须立即清理该消息名下的全部 `pendingCallbacks` 加载圈；
  - 多账号后台预热（`warmAllLocalAccounts`）必须在当前主账号完成首屏同步后延迟串行启动，禁止与前台首屏同步并发争抢 WebSocket 与 IndexedDB 锁。

### 2.4 Telegram 并发配额（强制）

完整准则、总线职责矩阵和新增 bus/op 准入清单以 [telegram-bus-and-concurrency.md](telegram-bus-and-concurrency.md) 为唯一规范来源；本节只保留状态管理的数据流提示。

### 2.5 Telegram 运行监控（强制）

* **有订阅才推送**：Worker `BusMonitor` 只在收到 `monitorSubscribe` 后按帧率组帧，订阅带 15 秒租约（主线程每 5 秒续约）；离开监控页、KeepAlive 隐藏、页面不可见、点击暂停都必须退订；
* **高频数据不进深层响应式**：任务表用普通 `Map` 增量维护，时间序列写定长 `Float64Array`，每个 `requestAnimationFrame` 最多以 `shallowRef` 整体替换一次快照；Canvas 曲线由 Data Source 直接重绘，数据不进 Store；
* **定长**：活跃任务每帧最多 200 个、增量帧最多 60 个变化、最近任务 100 条、事件 200 条、曲线 1200 点；
* **隐私**：帧与导出快照只含计数、子池、操作名与错误分桶，不含消息正文、会话标题或文件名；
* **SSOT**：账号显示名只读 `telegramStore`，并发模式只读 `telegramPerformanceStore`，监控 Store 不复制。

### 3. Mock 类 (模拟数据规范)
* **定位**：服务于页面前端独立开发与渲染的原型数据。
* **书写准则**：
  1. **成组业务内聚**：同一组业务的 Mock 数据必须收敛在同一个文件中，禁止碎片化散落。
  2. **标准化注释要求**：每个 Mock 对象必须清晰标注业务归属、字段含义与拟真说明。
  3. **接线即删铁律**：**一旦该块业务通过 Data Source 接通真实服务，必须立即物理删除对应的 Mock 文件与引用**，禁止残留无用的 Mock 垫层。

---

## 四、 零 ref 铁律的补充说明（路由化之后）

**"这个状态该进路由吗"与"这个状态能放在组件里吗"是两个独立问题。**

* 路由只决定状态的**归属层级**（URL vs store），从不豁免视图层的零 ref 约束；
* 反例：登录页的「显示密码」开关、注册表单草稿——看似一次性，但放入 store 后
  才能在 登录 ↔ 注册 往返时不丢失已填内容；放组件内 ref 则随卸载清零。

---

## 五、 会话持久化的边界

* 会话的**内存态**在 `authStore`（`user` / `sessionToken` / `sessionExpiresAt` / `isConnectedToServer`），
  **落盘**只在 Data Source 层（`auth/data-sources/authSessionStorage.ts`）完成，Store 不直接操作 `localStorage`；
* 持久化结构必须是 `{ token, user, expiresAt }`，缺失 token 或已过期一律视为未登录；
* 勾选「保持登录」写 `localStorage`（服务端 30 天有效），未勾选写 `sessionStorage`（关闭即失效），
  使该复选框具备真实语义；
* **有效性以远端为准**：应用冷启动 / 进入受保护路由前，由路由守卫调用
  `initializeSessionConnection()` 向 `/api/auth/session/connect` 校验 Token；失败时清理本地会话并打回登录页；
* 读取失败（隐私模式 / 存储被禁用 / 内容损坏）一律**静默降级为未登录**，不得阻断应用启动。

---

## 六、 结构化分级树状时间轴日志与调试终端规范 (Structured Tree-Timeline Logging)

1. **三端日志采集开关**：
   * 开发者设置页提供三个**无圆角标签按钮（`rounded-none`）**：`LOCAL`、`REMOTE`、`FRONTEND`；点击即高亮并开启对应端的采集，支持多选。
2. **统一 Grep 友好树状时间轴格式**：
   * 所有进入 `debugLoggerStore` 的日志条目（`LatticeLogEntry`）导出或展示时，必须遵循统一行格式：
     `[LATTICE][T:<traceId>][S:<spanId>][<ISO8601>][+<relMs>ms][dur:<durMs>ms][<LEVEL>][<SOURCE>:<domain>] <action> | key=val ...`
   * 新增敏感业务（MTProto RPC、PTS 差量、机器人翻页、云端同步、鉴权）必须通过 `localSpans` / `debugLoggerDataSource` 记录结构化 Span，禁止裸写散乱的 `console.log`。
3. **终端性能与零 `ref` 约束**：
   * 调试终端采用环形缓冲区（Ring Buffer，上限 5,000 条）+ `requestAnimationFrame`（16ms 批合并）写入 Pinia Store，防止高频消息阻塞渲染；
   * 终端视口使用固定行高（`ROW_HEIGHT = 24px`）虚拟列表，DOM 句柄与时间轴拖拽滑轨事件统一托管在 `debugLoggerDataSource`，视图组件严格保持零 `ref` / `reactive`。
4. **云端日志快照状态归 Store**：
   * 云端记录开关按当前 `user.id` 隔离持久化；快照元数据列表、加载态、错误态、删除目标与删除请求态全部归 `debugLoggerStore`，视图只读；
   * `debugLoggerDataSource` 只做 `/api/debug/snapshots` 的薄桥接（压缩、分片、HTTP），不得复制 Store 状态或编排 UI；
   * 快照元数据接口不得返回压缩正文；删除必须以当前会话账号与 `snapshotId` 双重限定。
