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
     ```

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
