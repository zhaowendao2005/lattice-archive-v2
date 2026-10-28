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
├── chat/                          # 核心业务域：聊天与消息
│   ├── data-sources/
│   │   └── chatDataSource.ts     # (a) Data Source 类：全局单例接线器
│   ├── stores/
│   │   └── chatStore.ts          # (b) Stores 类：纯粹的响应式页面状态
│   └── mocks/
│       └── chatMock.ts           # (c) Mock 类：成组业务模拟数据
├── auth/                          # 登录与用户认证域
│   ├── data-sources/
│   │   └── authSessionStorage.ts # 会话持久化：localStorage / sessionStorage 读写
│   └── stores/
│       ├── authStore.ts          # 会话身份、表单草稿、账户菜单
│       └── wallpaperStore.ts     # 登录页壁纸轮替索引与自动播放
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
  * 聚合管理选中态、搜索关键词、分页游标、界面激活状态等。

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

* 会话身份的**内存态**在 `authStore.user`，**落盘**只在 Data Source 层
  （`auth/data-sources/authSessionStorage.ts`）完成，Store 不直接操作 `localStorage`；
* 勾选「保持登录」写 `localStorage`（30 天有效），未勾选写 `sessionStorage`（关闭即失效），
  使该复选框具备真实语义；
* 读取失败（隐私模式 / 存储被禁用 / 内容损坏）一律**静默降级为未登录**，不得阻断应用启动。
