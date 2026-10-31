# 设计系统与跨平台令牌规范 (Design System & Cross-Platform Tokens)

本规范定义项目的视觉语言 **瑞士科技蔚蓝（Swiss Tech Blue）**：清爽微冷底色、纯白内容面板、深邃科技蓝主操作与我方气泡、通透蔚蓝品牌强调色，并包含多端（iOS / iPadOS / Windows）尺寸适配要求。所有取值以 `src/style.css` 为唯一事实来源。

---

## 一、 色板系统规范

整体原则：通透理性的现代科技感，强调色严格基于蓝阶梯。明暗两套取值由 `prefers-color-scheme` 自动切换。

| 色彩角色 | CSS 变量 / 原子类 | 亮色取值 | 用途 |
| :--- | :--- | :--- | :--- |
| **Canvas** | `--background` / `bg-background` | `oklch(0.975 0.006 240)` | 应用底层冷灰蓝画布，侧栏坐落其上 |
| **Panel** | `--card` / `bg-card` | `oklch(1 0 0)` | 浮于画布上的纯白内容面板、弹窗、输入壳 |
| **Muted** | `--muted` / `bg-muted` | `oklch(0.96 0.008 240)` | 对方气泡、搜索框底色、分段控件滑轨 |
| **Hover / Active** | `--accent` / `bg-accent` | `oklch(0.935 0.02 240)` | 会话项与导航菜单的悬停/激活底色 |
| **Hairline** | `--border` / `border-border` | `oklch(0.90 0.01 240)` | 1px 细线，清爽微蓝灰轮廓 |
| **Text Primary** | `--foreground` | `oklch(0.20 0.02 245)` | 深邃墨蓝黑正文与标题 |
| **Text Muted** | `--muted-foreground` | `oklch(0.52 0.03 245)` | 次要说明、时间戳、占位提示 |
| **Primary** | `--primary` / `bg-primary` | `oklch(0.48 0.19 250)` | 深邃科技蓝（主按钮、我方发送消息气泡） |
| **Brand** | `--brand` / `bg-brand` `text-brand` | `oklch(0.55 0.20 248)` | 蔚蓝强调（未读 Badge、焦点环、开关激活） |
| **Brand Soft** | `--brand-soft` / `bg-brand-soft` | `oklch(0.94 0.035 245)` | 浅冰蓝底（用户头像背景） |

### 沉浸媒体查看器专属令牌（Media Viewer Dark Surface）

照片/视频查看器、视频瓦片角标与播放器控制栏无论系统处于亮色或暗色模式，始终使用深色观影语义令牌（定义于 `src/style.css`）：

| 色彩角色 | CSS 变量 / 原子类 | 用途 |
| :--- | :--- | :--- |
| **Media Backdrop** | `--media-backdrop` / `bg-media-backdrop` | 沉浸查看器全屏遮罩底色 |
| **Media Scrim** | `--media-scrim` / `bg-media-scrim` | 播放器顶部/底部渐变遮罩、视频瓦片胶囊半透明黑底 |
| **Media Surface** | `--media-surface` / `bg-media-surface` | 倍速、画质、音量等浮层菜单背景 |
| **Media Control** | `--media-control` / `bg-media-control` | 中央大播放圆形按钮与控制栏按钮悬停底色 |
| **Media Foreground** | `--media-foreground` / `text-media-foreground` | 播放器白色图标、时间码、说明文字 |
| **Media Muted** | `--media-muted` / `text-media-muted` | 次要计数、来源时间与副文案 |
| **Media Track / Buffered** | `--media-track` / `--media-buffered` | 进度条底轨与已缓冲进度条 |

**铁律**：视图中只允许使用上表的语义原子类，**严禁直接写 `slate-*`、`sky-*` 等调色板色或十六进制色值**，否则暗色模式与后续换肤都会失效。

### 字体与字号

* 字体使用系统字体栈（`--font-sans` / `--font-mono`），不加载远程字体，保证离线客户端可用。
* 字号阶梯：页面标题 `text-xl` (20) / 区块标题 `text-base` (16) / 正文 `text-sm` (14) / 次要 `text-[13px]` / 辅助 `text-xs` (12) / 极限 `text-[11px]`。**禁止小于 11px**。
* 字重只用 `font-medium` 与 `font-semibold`；不使用全大写英文标签与等宽字体做装饰，界面文案统一为中文。
* 阴影仅用于弹窗（`shadow-xl`）与内容面板（`shadow-xs`），其余层级一律靠底色与发丝线区分。

---

## 二、 圆角体系

| UI 层级 | 圆角值 | 适用组件 |
| :--- | :--- | :--- |
| **微型部件 (`sm`)** | `6px` | 极小标签、徽标内嵌角、辅助图标按钮 |
| **交互控件 (`md`)** | `8px` | 标准按钮、下拉选项、侧栏菜单项 |
| **输入与卡片 (`lg`)** | `12px` | 搜索输入框、消息输入框外壳、设置卡片、会话列表悬浮项 |
| **顶层容器 (`xl`)** | `16px` | 模态弹窗（Modal）、独立浮层面板 |
| **流线气泡 (`bubble`)** | `16px` | 对话气泡（`.radius-bubble-peer` 左上贴角；`.radius-bubble-self` 右上贴角） |
| **状态胶囊 (`pill`)** | `9999px` | 用户头像（圆形）、未读计数 Badge、在线状态圆点 |

---

## 三、 登录页专属版式规范（Photo-Backed Auth Surface）

登录 / 注册 / 管理员登录共用同一套版式，属于本设计系统的**唯一例外**：
它允许图片作背景，但图片与表单必须物理隔开，不得把表单压在照片上。

| 要素 | 规范 |
| :--- | :--- |
| **分栏** | `>=1024px` 左右分栏，图片占 54%；`<1024px` 纵向堆叠（图片收为顶部图带） |
| **分界线** | 桌面竖线 / 窄屏横线，1px `--border`，叠一段 `--brand` 渐变高光，避免死板灰线 |
| **表单面板** | 纯色 `bg-card`，**不透明、不禁毛玻璃**（玻璃只用于图片侧） |
| **壁纸裁切** | 必须按用途分套出图：`panel-*`（4:5 竖，桌面）、`band-*`（~1.45:1 横，窄屏）、`thumb-*`（指示点） |
| **主体保护** | 每张图必须标定 `object-position`，确保 cover 裁切下不切掉塔尖 / 灭点 |
| **人机验证** | Turnstile 只用一个无装饰挂载容器（`flex min-h-[65px] items-center justify-center`），**不要**再加边框/底色/内边距，避免与 SDK 自带卡片形成双框；错误提示用 `bg-destructive/10 text-destructive border-destructive/20` |
| **蒙版** | 双层：底部渐浓保文案可读 + 基础压暗；强度按图像明暗逐张调校（亮部天光需更深） |
| **轮替** | 交叉淡入 1400ms + 缓慢推近（Ken Burns）；进度条用**纯 CSS 动画**，禁用 60fps JS 状态 |
| **矮屏退化** | `max-height:560px` 时图带压到 64px、隐藏页脚与副标题，优先保证首个输入框与提交按钮可见 |
| **主行动点** | **不得用 `disabled` 把主按钮置灰**（会发灰且无法告知失败原因），改为始终可点 + 提交时聚焦首个缺失字段 |

**表单居中铁律**：滚动容器内用 `my-auto` 外边距实现「有余量才居中」，
**禁用 `justify-center`**——内容高于容器时它会把顶部推出滚动区且无法回滚。

---

## 四、 跨平台尺寸令牌 (Platform Sizing Tokens)

根据运行时注入的 `data-platform` 属性，系统自动切换对应平台的尺度规范：

| 平台环境 | 属性标识 | 最小命中区 (`--hit-target`) | 控件标准高度 (`--control-h`) | 边距基准 |
| :--- | :--- | :--- | :--- | :--- |
| **Apple iOS** | `data-platform="ios"` | **44 × 44 pt** | 44px | 16px (Safe Area Inset) |
| **Apple iPadOS** | `data-platform="ipados"` | **44 pt** (触控板指针优化) | 40px | 20px |
| **Windows Standard** | `data-platform="windows-standard"` | **40 × 40 epx** | 40px | 16px |
| **Windows Compact** | `data-platform="windows-compact"` | **32 × 32 epx** | 32px (高密度) | 12px |

---

## 五、 WebKit 客户端原生化交互治理 (Ban 缩放手势)

为使 Web / Hybrid 前端彻底摆脱“网页感”，达到原生 Desktop / Native App 的干脆利落质感，全仓实行以下技术防护：

1. **视口锁定**：
   `<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">`
2. **CSS 交互声明**：
   * `touch-action: manipulation;`：对 `*` 全局生效，彻底消灭 300ms 双击判定延迟和双击放大行为。
   * `-webkit-tap-highlight-color: transparent;`：禁用移动端点击时闪烁的灰色高亮框。
   * `-webkit-touch-callout: none;` 及全局 `user-select: none;`：禁止划词和长按呼出 Safari 原生菜单（仅在 `.selectable-text` 及表单中放行）。
   * 表单 `<input>` 移动端字号锁定 $\ge 16\text{px}$，避免 iOS 获焦自动推近放大视口。该规则写在 base 层，**表单控件上不要再写 `text-sm` / `text-xs` 覆盖它**。
3. **事件级防御（JS 入口注入）**：
   * 拦截 iOS WebKit 多指手势：`gesturestart`, `gesturechange`, `gestureend` 监听并执行 `e.preventDefault()`。
   * 拦截极速双击：监听 `touchend` 间隔小于 300ms 时阻止默认动作。

---

## 六、管理表格与弹窗

* 管理表格使用 VXE-Table，但颜色不得沿用库内硬编码色值；通过 CSS 变量映射到 `--card`、`--foreground`、`--muted`、`--border`、`--accent`、`--brand` 等语义令牌，覆盖表头、斑马纹、悬停及固定列。
* 表格工具栏、分页和表格本体保持扁平结构；固定操作列在窄屏保留，其余列由表格自身横向滚动，不得撑宽页面。
* 表格加载、空态与错误提示均有明确中文文案；错误提示使用 `bg-destructive/10 text-destructive border-destructive/20`。
* 弹窗使用 `rounded-xl border-border bg-card shadow-xl`，遮罩使用 `bg-background/80 backdrop-blur-sm`，不得在暗色模式使用会发白的 `bg-foreground` 遮罩。
* 删除按钮使用 `text-destructive`；确认弹窗必须点名目标邮箱并说明远端会话同时失效。
