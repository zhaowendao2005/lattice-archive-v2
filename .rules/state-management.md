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
│   └── stores/appStore.ts
├── chat/                          # 核心业务域：Telegram 会话与消息（只读，已接线真实数据）
│   ├── types.ts                   # Worker DTO 再导出、消息窗口、冷启动快照、视图模型、媒体与播放器状态
│   ├── data-sources/
│   │   ├── chatDataSource.ts     # 经 MTProto Bridge 调本地 Worker：会话分页 / 历史分页 / 补差 / 媒体下载与取消
│   │   ├── chatCacheStore.ts     # 冷启动快照：设备密钥 AES-GCM 加密后写 IndexedDB，按「Lattice 用户:TG 账户」隔离
│   │   ├── chatMediaCache.ts     # 媒体持久缓存：AES-GCM 加密 Cache Storage（单条 ≤ 20 MiB）
│   │   ├── chatMediaLoader.ts    # 双车道下载器：图片（并发 3 / 400 条 LRU）+ 视频（并发 2 / 256 MB LRU + pin + abort）
│   │   ├── chatPreferences.ts    # 自动下载策略、GIF/圆视频自动播放开关、播放器音量与倍速持久化
│   │   ├── messageViewport.ts    # 消息流滚动容器句柄 + 预取（600px）与自动播放（50% 可见）IntersectionObserver
│   │   └── videoPlayback.ts      # HTMLVideoElement 槽位单例（viewer / gif / round）、全屏、画中画与编解码探测
│   └── stores/
│       ├── chatStore.ts          # 会话列表、消息窗口、同步阶段、缓存调度
│       ├── chatMediaStore.ts     # 缩略图/原图加载、统一查看器状态（旋转/缩放/胶片条）、自动下载策略
│       ├── chatVideoStore.ts     # 视频下载进度/取消、画质切换、查看器播放控制、GIF 与圆视频单实例播放
│       └── chatModel.ts          # 纯函数：窗口合并、相册聚合、画质选择、格式化、快照裁剪
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

### 1. Data Source 类 (数据源接线器)
* **定位**：业务域内唯一的**全局单例连接器**。
* **职责**：
  * 对接底层真实的 SQLite 数据库、Capacitor 原生插件、WebSocket/网络服务或 IPC 进程；
  * 封装原始数据的读写、同步与异常捕获；
  * 驱动 Stores 层的响应式刷新，解耦底层协议与上层渲染。

### 2. Stores 类 (页面状态存储器)
* **定位**：纯粹负责该业务域内页面的响应式状态存储、计算属性（Getters）与交互动作（Actions）。
* **职责**：
  * 暴露给 `views/` 组件订阅；
  * 聚合管理选中态、搜索关键词、分页游标、界面激活状态等；
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
    → chatDataSource → mtprotoHub.bridge()（主标签页直连，从标签页经 BroadcastChannel 代理）
      → 本地 tg.worker（GramJS，单连接）→ Telegram DC
  ← Worker 广播 chatUpdates → 各标签页 chatStore.applyUpdates
```

* **内容不出设备**：会话、消息、access_hash 只在本地 Worker / 内存 / 加密 IndexedDB 中流转，禁止发往 Lattice 远端或 D1；
* **账户与连接只认 telegramStore**：`currentAccountId` / `connectionStates` 是唯一来源，chatStore 只订阅；工作区引导由 `AppLayout` 以当前 Lattice 用户调用 `chatStore.initialize(userId)`，换人登录必须清空上一位用户的内存态；
* **缓存 ≠ 已同步**：`syncPhase` 必须区分 `cache`（仅本地快照）与 `live`（已补差并刷新首页），UI 不得把缓存命中显示为已同步；
* **窗口连续性**：消息窗口是以最新消息为右端的连续区间；`continuous=false` 的窗口禁止插入实时消息，打开时以服务器最新页校准；
* **代次丢弃**：所有异步响应按账户代次与窗口 `epoch` 校验，过期结果直接丢弃，不得串到其他会话；
* **只读**：当前阶段不发送消息、不调用已读 RPC，后台预载不得改变 Telegram 服务端状态。
* **媒体分级加载**：消息 DTO 只携带照片/视频定位信息、宽高、时长、多档画质列表与内联模糊缩略图；预览图与视频封面由 `v-media-visible` 指令 → `messageViewport` 可见性回调 → `chatMediaStore` 按自动下载策略请求；普通视频不在消息流内自动下载完整文件，只在查看器中按所选画质下载，关闭查看器、翻页或切换会话时立即通过 `AbortSignal` → `chatCancel` 中止在途分片；GIF 与圆形视频由 `v-media-playing` 指令在 ≥ 50% 可见且允许自动播放（≤ 10 MB）时静音循环，点击圆形视频切换单实例有声播放；占位尺寸在下载前锁定，媒体加载不得改变气泡高度；
* **媒体句柄与缓存**：Object URL 只由 `chatMediaLoader` 创建与回收（图片 400 条 LRU，视频 256 MB 字节預算 LRU 且活跃播放槽位 `pin` 保护，切换账户时全部 revoke），`HTMLVideoElement` 与全屏容器句柄只由 `videoPlayback` 单例持有，Store 中只存 URL 字符串与可序列化播放状态；持久缓存只走 `chatMediaCache`（设备密钥加密的 Cache Storage，按 Lattice 用户 / Telegram 账户隔离，单条 ≤ 20 MiB，授权失效时整体清除），禁止写入未加密的媒体字节。

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
