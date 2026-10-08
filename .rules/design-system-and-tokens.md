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

## 三、 跨平台尺寸令牌 (Platform Sizing Tokens)

根据运行时注入的 `data-platform` 属性，系统自动切换对应平台的尺度规范：

| 平台环境 | 属性标识 | 最小命中区 (`--hit-target`) | 控件标准高度 (`--control-h`) | 边距基准 |
| :--- | :--- | :--- | :--- | :--- |
| **Apple iOS** | `data-platform="ios"` | **44 × 44 pt** | 44px | 16px (Safe Area Inset) |
| **Apple iPadOS** | `data-platform="ipados"` | **44 pt** (触控板指针优化) | 40px | 20px |
| **Windows Standard** | `data-platform="windows-standard"` | **40 × 40 epx** | 40px | 16px |
| **Windows Compact** | `data-platform="windows-compact"` | **32 × 32 epx** | 32px (高密度) | 12px |

---

## 四、 WebKit 客户端原生化交互治理 (Ban 缩放手势)

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
