# 前端架构与目录规范 (Frontend Architecture Rules)

本规范是项目前端开发（Vue 3 + Tailwind CSS + Pinia + Vite）的强制性架构准则，所有页面、组件、样式及 DOM 结构的编写均须严格遵守。

---

## 一、 页面目录规范 (`src/views`)

1. **业务容器定位**：
   * 所有正式页面与业务级子模块**一律存放在 `src/views/` 目录下**。
   * 鼓励根据业务逻辑进行**多层级深度目录划分（无限递进）**，严禁将多层嵌套逻辑平铺在单个目录下。

2. **逻辑同级划分原则**：
   * **仅有逻辑上属于同级关系的模块，才允许放置在同一目录下**。
   * 非同级、包含或平行分工的模块，必须拆分子目录。
   * **典型分栏范式**：若一个页面在视觉与逻辑上由「左侧会话栏」与「右侧聊天窗」构成，必须建立两套独立子目录：
     ```text
     src/views/main/chats/
     ├── session-list/              # 左栏目录：各自组织会话检索、条目与过滤器
     │   ├── SessionSearch.vue
     │   ├── SessionItem.vue
     │   └── SessionListContainer.vue
     ├── conversation/              # 右栏目录：各自组织消息头、消息泡、输入框
     │   ├── ConversationHeader.vue
     │   ├── MessageFeed.vue
     │   ├── MessageBubble.vue
     │   ├── MessageInput.vue
     │   └── ConversationContainer.vue
     └── ChatsView.vue              # 顶层同级聚合容器

     src/views/main/settings/       # 设置页双栏分治范式
     ├── nav/
     │   └── SettingsNav.vue        # 设置左侧子导航栏
     ├── subviews/                  # 一个子页对应一个独立 Vue 组件
     │   ├── PlatformSettingsView.vue
     │   ├── AppearanceSettingsView.vue
     │   ├── GeneralSettingsView.vue
     │   ├── DeveloperSettingsView.vue
     │   └── StorageSettingsView.vue
     └── SettingsView.vue           # 顶层分栏容器

     src/views/auth/                # 鉴权域：登录与注册
     ├── components/                # 该域专属的版式部件，不进 src/components
     │   ├── AuthWallpaperPanel.vue  # 左栏：壁纸轮替与蒙版
     │   └── AuthFormShell.vue       # 右栏：品牌头 / 表单 / 页脚骨架
     ├── login/
     │   └── LoginView.vue           # 用户登录子页
     ├── register/
     │   └── RegisterView.vue        # 用户注册子页
     └── AuthLayout.vue              # 左右分栏 + 分界线的顶层容器
     ```

3. **顶层域平级原则**：
   * 全仓仅允许三个顶层业务域，彼此**平级、互不嵌套**：
     | 域名 | 路径前缀 | 职责 |
     | :--- | :--- | :--- |
     | 鉴权域 | `/auth` | 用户登录、用户注册 |
     | 管理域 | `/admin` | 管理员登录、管理员控制台 |
     | 工作区 | `/workspace` | 会话、归档、设置及其全部子页 |
   * 管理员登录页**必须**独立于管理域外壳之外，否则「守卫发现非管理员 → 打回管理员登录页」会打到自己身上，形成自环。

3. **单文件精炼原则**：
   * **每个 `.vue` 单文件必须保持精炼，严禁编写臃肿庞大的文件**。
   * 单文件行数建议控制在 80~150 行以内，超过即应按逻辑进行就近拆分子组件。

---

## 二、 公共组件目录规范 (`src/components`)

1. **唯一职责**：
   * `src/components/` 仅用于存放**真正全系统跨域通用的无业务基础组件**（例如：统一圆角/方角标准按钮、基础输入框、通用滚动条、图标容器等）。
2. **禁止业务污染**：
   * 凡是仅服务于某一特定业务页面、不会被跨域复用的组件，**严禁放入 `src/components/`**，必须就近放置在对应 `src/views/**` 目录下。

---

## 三、 样式与模板书写规范

1. **Tailwind CSS 标签直写模式**：
   * 一律采用在 HTML / Template 标签内编写 Tailwind CSS 原子类的模式。
   * **严禁堆叠大段自定义 `<style>` 样式块**；仅允许在极少必要场景下书写 CSS 变量映射。
2. **精简 DOM 与 CSS 层级**：
   * 杜绝无意义的 `div` 包装地狱（Div Soup），减少嵌套深度。
   * 杜绝复杂且难以维护的级联选择器，保持样式扁平化。

---

## 四、 DOM 结构稳定性铁律（左侧栏及动态容器）

1. **无突变折叠规范**：
   * 侧边栏、工具栏在展开与折叠时，**DOM Tree 结构必须保持 100% 绝对一致**。
   * **严禁采用 `v-if` 在展开时插入文本节点/标题、在折叠时将其销毁**。这种做法会导致 DOM 树发生突变，破坏浏览器重排缓存并引起 Flex 布局抖动。
2. **实现技术要求**：
   * 折叠时的视觉变化必须通过纯 CSS 类名控制（利用 `width`、`max-width`、`opacity`、`overflow: hidden` 与 `transform`），DOM 节点始终驻留树中。
   * 禁止使用耗性能的复杂 JS 动画库，采用流畅丝滑的 CSS 硬件加速过渡（150ms~200ms）。

---

## 五、 路由与全局状态的边界（判定铁律）

新增任何页面级状态前，先回答一个问题：**这份状态是否描述"我在哪里"？**

### 1. 必须走路由（`src/router/index.ts`）

同时满足以下任一条件，即入路由表：

* **可深链**：需要被外部直接打开（如推送、深度链接、`openUrl`）；
* **可刷新还原**：用户刷新或重开客户端后应回到同一位置；
* **参与历史栈**：需要系统返回键 / 浏览器后退 / iPad 侧滑手势生效；
* **有独立 URL 语义**：值得出现在地址栏、可被复制分享。

判据一句话：**能被"粘贴给别人"的层级，才是路由。**

### 2. 必须走 Pinia（对应业务域 store）

* **覆盖层**：模态弹窗、抽屉、右键菜单、Upward 菜单（如侧栏账户菜单）；
* **瞬时交互态**：侧栏 / 会话栏折叠、当前选中项、搜索关键词、拖拽中间态；
* **跨路由必须延续的态**：例如登录页壁纸轮替索引——登录 ↔ 注册 跳转时若放组件内 ref 会闪回第一张。

判据一句话：**弹出来盖住页面的东西不是"位置"，是 UI 态。**

### 3. 视图层仍然零本地 ref

路由化**不代表**可以把状态塞回组件：视图组件依旧不得声明本地 `ref` / `reactive`，
即使是「显示密码」「表单草稿」这类看起来一次性的状态，也必须落到对应 store
（原因：草稿入 store 才能在登录 ↔ 注册 之间往返时不丢失）。

### 4. 路由守卫

* 会话身份一律取自 `authStore`，不得在路由表里另起一份登录标志；
* 用 `meta.requiresAuth` / `meta.requiresAdmin` 声明式标注，统一在 `beforeEach` 中裁决；
* 管理域与工作区**共用同一套判定来源**，但角色互不通用：普通用户不得凭既有会话进入控制台。
