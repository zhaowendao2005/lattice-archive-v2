# Telegram 聊天内容实现调研与分阶段蓝图

> 本文整理 Telegram Web Z 参考项目中聊天列表、消息流、冷启动、连接与更新同步、媒体缩略图/播放、归档和加入/退出会话的实现观察，并给出适用于 Lattice Archive 的分阶段交付建议。
>
> **调研范围**：本地参考项目 `/Volumes/Lenovo/参考项目/Telegram-web-z-master`，`package.json` 版本 `12.0.47`。主要依据其 TypeScript 源码；本文描述的是该仓库当前实现，不保证等同于所有 Telegram 官方客户端、官方协议规范或未来版本。本文仅为研究文档，不代表已经实现任何功能。

---

## 1. 总体结论

Telegram Web Z 并不是把聊天数据简单地一次性全部拉回页面。它将系统拆成几个互相配合的环节：

1. **MTProto 连接与授权**：GramJS 在 Web Worker 中管理连接、auth key、RPC 和 Telegram updates。
2. **聊天列表同步**：`messages.GetDialogs` 分页加载活动/归档列表；置顶等列表信息有独立请求。
3. **消息流窗口**：以当前视口、已读位置或目标消息为锚点分页，消息数据按 chat/thread 合并，旧请求可以取消。
4. **本地冷启动缓存**：IndexedDB 保存有限的状态快照，让页面先展示；之后由服务器同步校准。缓存不是完整聊天历史。
5. **媒体管线**：消息元数据、缩略图、完整媒体、流式播放和下载分别处理；资源按需取回并通过内存、Cache Storage 和 Service Worker 管理。
6. **Telegram 服务端状态变更**：归档、加入和退出都调用 Telegram API；本地界面需要结合 RPC 返回和 updates 更新，不能只改本地列表。

对 Lattice 的建议：先完成稳定的只读会话列表和消息流，再做冷启动和实时更新；媒体先完成普通图片/视频的占位与按需加载，再完善播放器和分段流式。加入/退出等成员操作应在同步框架稳定后实现。

---

## 2. 参考实现的核心结构

### 2.1 Telegram 请求路径

参考项目的请求大致经过：

```text
界面/全局 Action
  → GramJS Worker Connector
    → Worker 内 methods/client.ts
      → TelegramClient.invoke / downloadMedia
        → Telegram DC
  ← Worker 返回响应及 update
  → API builders 转成界面可用类型
  → reducers 合并到全局状态
```

消息中的 Telegram `Document`、`Photo` 等对象由 API builder 转成应用侧类型。客户端维护 `localDb`，将 Telegram 文件实体与构造出的媒体标识对应起来；下载请求不应把 Telegram auth key 或文件内容交给应用远端数据库。

### 2.2 与 Lattice 现有架构的衔接

本项目已具备设备本地 Telegram 登录、MTProto Worker 通信和本地 session vault；目前聊天 Store 仍使用 mock 数据。后续接入时建议：

- GramJS、auth key、Telegram RPC 和 Telegram 文件下载留在**设备本地 Worker**。
- Pinia Store 持有页面可观察状态；Data Source 负责 Worker 桥接、缓存及其他外部句柄；视图保持纯表现层。
- Cloudflare Worker / D1 继续承载 Lattice 账户绑定等元数据，不转发或存放 Telegram 聊天内容、媒体及 auth key。
- 每台设备维持独立 Telegram 授权；不同设备不能共用同一 auth key。

---

## 3. 聊天列表加载

### 3.1 首屏与分页

参考实现通过 `messages.GetDialogs` 获取会话。当前代码的列表 API 批大小是 100 条。分页游标由下一条会话的 top message ID、peer 和日期组成；不能仅凭数组下标继续翻页。

置顶对话可通过单独的 `messages.GetPinnedDialogs` 获取。首批普通列表请求会排除置顶项，再把置顶与普通列表合并，避免重复或排序错乱。活动列表和归档列表均按服务器的 folder 状态获取。

解析对话结果时，还会同时合并：

- peer/chat/user 实体；
- 最后一条消息和 top message ID；
- 草稿、已读状态和 thread 信息；
- 通知设置、置顶状态等列表辅助信息。

因此，“会话列表”不是只下载 `Dialog` 数组；它是消息、peer 和本地索引的一次组合更新。

### 3.2 活动列表与归档列表的同步次序

观察到的首轮同步大意为：

1. 加载活动会话列表的第一页。
2. 第一批到达后，优先同步当前各 tab 打开的聊天消息。
3. 标记初始同步完成并让 UI 可交互。
4. 继续加载其余活动列表，并启动归档列表加载。
5. 逐个预加载最多 20 个候选聊天的消息，每次之间等待 100 ms。

这使首屏不必等到活动列表、归档列表和所有预载聊天全部完成。实际实现中还应避免无限分页；参考实现对完整加载循环有保护上限。

### 3.3 切换聊天和取消请求

打开新聊天时，客户端检查当前聊天/线程请求是否还被任何 tab 使用；不再需要的请求会通过 `ChatAbortController` 取消。这样慢网络下旧聊天的响应不应覆盖新聊天。

建议 Lattice 的首版至少具备：

- chat/thread 级缓存隔离；
- 切换会话时取消或忽略旧请求；
- 请求结果按消息 ID 去重合并；
- 以当前会话 ID 和请求代次校验响应，不让过期响应污染 UI。

---

## 4. 聊天流与消息分页

### 4.1 以视口为中心加载

参考实现维护已列出的消息 ID、当前视口消息 ID、线程 ID、last viewport 和已读位置等状态。打开聊天时优先以如下信息确定起始位置：

- 被路由/深链指定的消息或聚焦消息；
- 上次恢复的视口锚点；
- 最后已读 inbox message；
- 若无锚点则取聊天最新消息附近。

当前参考配置的消息请求批量是大屏 60、小屏 40。加载方向分为 around、backwards、forwards：around 首次定位消息附近；backwards 向更早历史加载；forwards 向更新消息加载。请求使用消息 ID 与 `addOffset` 定位，而不是下载全量消息再在前端切片。

### 4.2 缓存命中与服务器补页

每次触发视口加载时，先尝试从内存状态里取可用消息窗口：

- 本地已有足够的消息则直接切换 viewport；
- 缓存只有部分窗口时先展示本地部分，再请求缺失页；
- 向上翻页时用当前视口最早 ID 作为 offset；向下翻页时用最晚 ID；
- 避免以临时本地消息 ID 请求服务器；
- 对线程起始消息、相册组消息和 outlying list 作专门处理。

这能降低往返延迟，也能避免滚动时整个聊天重新加载。

### 4.3 UI/滚动约束

消息流是虚拟化/窗口化的，不应把所有历史消息 DOM 一次性渲染。每次追加顶部历史时必须保存并恢复可见锚点，避免页面跳动；快速切换聊天和回复定位也需使用同一套锚点/消息定位机制。

已读标记和已读 RPC 应与用户真正浏览视口联动，不能因为后台预载某条消息就误标已读。

---

## 5. 冷启动、本地缓存与恢复

### 5.1 缓存策略

参考实现通过 IndexedDB 存储经过裁剪的全局状态。缓存的目标是启动提速而非构建完整离线副本：

- 保存当前打开聊天和各线程最后一次视口涉及的消息 ID；
- 保存当前聊天最后消息、部分 thread/topic 末条消息和必要 peer/chat 数据；
- 缓存聊天条目有数量上限（该仓库配置：聊天信息最多 200 条、归档聊天信息上限 10 条、用户信息上限 500 条）；
- 缓存消息会移除本地 Blob URL、临时上传状态等不能跨启动复用的字段；
- 周期性节流写入，并在页面失焦、关闭前和空闲时保存；
- 应用锁启用时，完整敏感快照进入加密 vault，明文缓存只保留屏幕锁所需的裁剪状态。

### 5.2 启动时序

```text
读取本地快照 → 尽早展示上次界面
                    ↓
          连接 Telegram / 恢复授权
                    ↓
   拉取活动 dialogs、当前聊天消息与 updates 差异
                    ↓
  合并并校准列表/消息，恢复或修正滚动锚点
                    ↓
        后续加载归档及其他低优先级数据
```

冷启动时应区分“本地缓存已显示”和“服务器同步完成”，不能将缓存命中误报为在线数据已刷新。对于离线期间的新增/删除/编辑消息，依靠 updates / difference 合并，不应该每次重连都全量重拉历史。

---

## 6. 握手时序、保活和频次控制

### 6.1 初始连接

参考实现的主连接流程：

1. 从本机 session 加载 auth key 和 DC 信息。
2. 建立主 MTProto 连接。
3. 发送 `InvokeWithLayer(InitConnection(help.getConfig))`，携带应用 ID、设备信息、系统/应用版本、语言等初始化参数。
4. 客户端认证/连接就绪后初始化 update manager，获取当前用户信息，并触发同步。
5. 预借文件 DC sender，减少首次媒体请求时的建连延迟。

`InitConnection`、会话认证和业务同步是不同阶段；不能把“WebSocket 已打开”视作 Telegram 授权和聊天同步都完成。

### 6.2 参考源码中的频次和容错参数

以下是该仓库的具体实现参数，不应视为官方固定要求：

- MTProto 主连接每 3 秒发送一次 `PingDelayDisconnect`；常规超时 5 秒，最多重试 3 次。
- 从后台恢复时做较快的 wake-up 检查；失败则触发 sender reconnect。
- 默认 RPC 重试 5 次、连接重试无限、常规重试延迟 1 秒，主连接重试延迟 10 秒；网络连接可按条件切换 HTTP fallback。
- 若连续 30 分钟没有内容相关请求，会触发一次 updates 请求，维持 Telegram 更新下发。
- Worker 与主 UI 之间还有独立 ping/健康检查，不能与 MTProto 服务端 ping 混为一谈。
- UI 层初始同步另设 30 秒恢复超时，异常时主动 reconnect；这也不是 MTProto ping。
- 更新管理器处理 common pts/seq gap 和 channel difference；短轮询、gap 恢复和当前打开 channel 的更新有各自调度。

### 6.3 对 Lattice 的建议

实现时应把请求归入独立队列或优先级：

1. **连接/授权/更新差异**：高优先级，单实例负责主连接。
2. **首屏列表与当前聊天首批消息**：高优先级，限制并发，避免额外资料请求抢占。
3. **用户滚动触发的历史分页**：中优先级，可按 chat/thread 取消。
4. **缩略图/视频分段/背景预载**：低优先级，受网络与可见性限制。

不要把参考实现的 3 秒 ping 直接当成必须复刻的标准，也不要每个页面组件各建一条 MTProto 连接。连接控制应在单一 Worker/连接管理器完成，页面通过消息桥接。

---

## 7. 缩略图和多媒体下载管线

### 7.1 缩略图优先

照片、视频和带预览的文档使用不同的媒体 ID/尺寸标记。图片 builder 会把 Telegram 缩略图、stripped thumb 或 photo path 转为适合展示的图像数据；消息可以先用小图或模糊 canvas，再逐步显示预览/完整内容。

视频至少有以下潜在预览来源：

- Telegram 文档中的普通 thumb；
- Telegram video thumb/preview；
- `?size=x`、`?size=v` 等预览尺寸请求；
- storyboard（时间轴缩略图 sprite + map），用于播放器 seek preview。

缩略图和完整文件应是不同资源请求。不能为了获取低分辨率占位而直接下载大视频。

### 7.2 自动加载与可见性

参考实现分别判断媒体自动下载和自动播放：

- 自动加载设置按照片、视频、文件，以及联系人/私聊/群组/频道等场景划分；
- 媒体进入观察区域后才启动完整资源请求；
- autoplay 由性能设置决定，普通视频、GIF 和 round video 的设置分开；
- 超出播放可见范围、页面转后台或被高优先级媒体抢占时会暂停。

### 7.3 缓存、并发与重试

统一媒体 loader 具备：

- 内存缓存和相同资源请求去重；
- Cache Storage 持久缓存，按最近访问时间清理；参考代码的常规媒体 TTL 是 5 天；
- 普通 Blob 资源超过 512 KiB 时不进入一般完整媒体缓存；
- 失败指数退避，约 250 ms、500 ms、1 s、2 s、4 s，最多 5 次；
- 可取消的进度 callback；
- OGG 在浏览器 Opus 支持不足时转成 WAV；
- Telegram `FILE_REFERENCE` 过期时尝试刷新 file reference 再下载。

这些策略与消息列表加载解耦，媒体预载不能导致消息历史请求被无限挤压。

---

## 8. 视频播放、seek 与文件类型策略

### 8.1 文件分类和 Telegram 元数据

参考代码将视频类媒体主要解析为 `ApiVideo`，其中包含 document ID、MIME、文件大小、时长、宽高、`supportsStreaming`、`isRound`、`isGif`、`noSound`、thumb 和 storyboard 等。普通附件如果 MIME/属性符合条件，也会标记 `innerMediaType: video`，从附件视图进入播放器。

参考项目识别的普通视频内容类型包括 `video/mp4`、`video/quicktime`；WebM 是否参与处理受浏览器支持情况影响。视频类型判定需同时考虑 Telegram attributes、MIME、浏览器 codec 支持和播放器错误事件。

### 8.2 聊天内 inline 视频

普通视频在聊天气泡中的基本策略：

- 默认显示缩略图和时长；
- 根据 autoplay 与 auto-load 设置及 IntersectionObserver 状态决定是否取完整文件和播放；
- inline 通常静音、循环、`playsInline`；
- 加载中显示传输进度和取消/下载状态；
- 视频播放失败时呈现错误标记，完整播放器还会给出不支持提示；
- 用户点击后按消息行为进入媒体查看器或触发对应媒体操作。

GIF 使用自动播放 GIF 设置，静音循环；普通视频 autoplay 使用另一设置。播放时机遵守可见性，动画重负载、页面后台和优先播放状态也会令部分视频暂停。

### 8.3 完整视频播放器交互

完整查看器中的自定义控制包括：

- 播放/暂停、当前时间/总时长、缓冲区间和加载指示；
- 进度条点击/拖动 seek；可用 storyboard 时显示时间点预览帧；
- 播放倍速 `0.5× / 1× / 1.5× / 2×`；
- 音量、静音、全屏，以及设备/浏览器支持时的 PiP；
- 全屏时空格/Enter 播放暂停、左右键以 5 秒步长 seek；
- 触屏控制条播放后约 3 秒自动隐藏；iOS 有 autoplay 与用户交互限制的特殊处理。

参考代码没有发现常规双击快进/快退 10 秒行为。若 Lattice 要提供这种交互，应视为产品设计新增，而不是声称复刻了参考行为。

### 8.4 短视频、GIF、圆形视频

- GIF 强制循环、静音，并隐藏一般播放器控制。
- 普通视频时长不超过 30 秒时，媒体查看器也会循环；更长视频结束后停止并显示控制条。
- 播放进度保存仅用于满足时长条件的普通消息视频；相册组消息被排除，接近视频结束时删除保存位置。
- Round video 是另一类体验：圆形裁切、静音循环预览；用户激活后从头播放、显示圆形进度，不提供普通 seek 控件；播放另一个 round video/音频时停止上一个。

### 8.5 大文件的分段流式读取

普通 progressive 线路的简化过程：

```text
HTMLVideoElement 请求 Range
 → Service Worker 拦截自定义 progressive URL
 → 发消息给同一账号对应的页面 Worker
 → Worker 调 GramJS 下载所需字节区间
 → Service Worker 返回 206 Partial Content
 → 浏览器继续解码/播放或在 seek 时请求另一段
```

参考实现 Service Worker 每次最多取约 0.5 MiB，单片最多等待 60 秒；满足条件的分片只缓存文件开始部分约 2 MiB。Safari story 另有 `MediaSource`/`SourceBuffer` 追加分片路径，不能把两种路径混成一个实现描述。

能力检测失败或格式不支持时，需转完整 Blob 或报告不支持。参考 `getMediaFormat()` 会在浏览器支持渐进式播放时对视频的 full/inline 请求选择 Progressive；该分支并未用 `supportsStreaming` 属性作条件。对 Lattice 更稳妥的实现应把 Telegram 元数据、浏览器 `canPlayType`/MSE 能力、文件大小和实际失败回退分开评估，避免只凭一个标志决定是否流播。

---

## 9. 归档、加入和退出会话

### 9.1 Telegram 归档文件夹

本文所说归档是 Telegram 的归档对话列表，不是把消息导出到 Lattice 私有归档。

参考实现通过 `folders.EditPeerFolders` 把 peer 加入或移出归档 folder；活动和归档列表使用 `messages.GetDialogs` 的不同 folder 参数读取。最终列表状态通过 API 返回和 Telegram updates/difference 汇合，不能只在前端从数组删掉会话。

归档操作后需要处理：

- 会话从活动列表移到归档列表，或反向移动；
- 置顶状态/列表顺序；
- 当前打开聊天不应因归档而丢失消息视图；
- 其他设备的变更通过 updates 同步；
- 冷缓存中的活动/归档列表应在服务器重新校准。

### 9.2 加入

加入公开频道/群组通过相应 Telegram API（如 `channels.JoinChannel`）完成。返回状态可能是直接加入、提交加入申请或进入 WebView 流程。应等待 Telegram 返回结果/updates 来确认加入状态；提交申请不能当作已加入。

通过邀请链接加入还有独立流程，可能需要解析/检查 invite、预览参与者、选择账号或确认后再加入。建议先只做公开频道/群组的基础加入，再单独扩展邀请链接流程。

### 9.3 退出/移除

退出不是本地删除聊天：

- 频道退出通过 `channels.LeaveChannel`；
- 基础群和移除成员可能走不同 RPC；
- 离开群主身份对应的群时，可能要先提示转让所有权或验证 2FA；
- API 成功后才做相应本地清理，并在当前正打开该聊天时退出聊天视图；
- 删除聊天历史、退出群组和从列表隐藏是不同操作，不能混为一个按钮语义。

---

## 10. 分阶段实施蓝图

每阶段都要能单独部署/测试，且给用户留下可手动在线回归的稳定版本。阶段不要求一次性完成全部 Telegram Web 功能。

| 阶段 | 完整功能包 | 手动在线回归重点 |
|---|---|---|
| **1. 连接健康与只读会话列表** | 单 Worker 连接状态、session 恢复、活动 dialogs、置顶和最新消息摘要；列表分页。 | 重载后能恢复授权；活动列表顺序、置顶、最后消息合理；断网恢复后连接状态正常；RPC 不重复泛滥。 |
| **2. 只读聊天流** | 打开会话、最近消息、向上历史分页、视口锚点、切换会话取消旧请求、基础文本/系统消息。 | 切换多个会话及快速返回；连续加载历史无重复/缺页；慢响应不串到其他聊天；滚动位置稳定。 |
| **3. 冷启动与 updates 同步** | 裁剪后的 IndexedDB 消息/列表缓存、先展示再刷新、updates/difference 补差、在线状态区分。 | 关闭重开能先恢复上次界面；服务器刷新后列表正确；离线期间另一端发消息后重新上线能补齐。 |
| **4. 普通图片及缩略图** | Telegram thumb、小图/模糊占位、可见性和自动下载策略、完整图片、Cache Storage。 | 缩略图先出现；滚动大列表不全部下载原图；手动打开图片正确；缓存命中和失败提示正常。 |
| **5. 普通视频基础播放** | 视频类型/附件识别、缩略图、点击播放、完整 Blob 播放、暂停/结束/不支持状态；先不做复杂 streaming。 | MP4/可支持格式能播放；附件视频和消息视频区分正确；不兼容文件能说明情况；切换聊天不遗留错误播放。 |
| **6. 播放控制与特殊视频类型** | seek、缓冲 UI、倍速、全屏、键盘快进/快退、GIF 和圆形视频专项交互。 | seek、倍速和全屏有效；GIF 静音循环；圆形视频单实例播放并正确显示进度；触屏控制条正常。 |
| **7. 大视频渐进式播放** | Range + Service Worker、分块下载、请求取消、前段缓存、重试和 file reference 修复；浏览器回退。 | 大文件能较早开始播放；seek 后请求目标区间；弱网暂停/恢复和失败行为可预期；内存使用稳定。 |
| **8. Telegram 归档** | 活动/归档列表、服务端归档/取消归档、分页与 updates 合并、当前聊天保护。 | 归档操作跨端一致；从归档恢复；归档当前打开聊天时视图不丢；刷新后状态一致。 |
| **9. 加入/退出会话** | 公开频道/群组加入、加入申请、退出、基础错误和角色保护；之后再做邀请链接/转让所有权复杂流程。 | 申请态不误报加入；成功加入后列表/权限正确；退出后当前视图和列表一致；取消/失败不会错误清理本地会话。 |

### 阶段依赖建议

```text
1 会话列表
  → 2 聊天流
    → 3 冷启动/updates
      → 4 图片
      → 5 视频基础播放 → 6 控制/特殊类型 → 7 大文件流式
    → 8 归档
    → 9 加入/退出
```

阶段 1–3 是聊天内容可信度的基础。优先把会话列表、历史分页、updates 合并与冷启动做好，再进入媒体；视频先用完整 Blob 验证类型和交互，最后增加 Range/Service Worker，减少同时排查 UI、codec、HTTP Range 和 Worker 桥接问题的成本。

---

## 11. 建议的工程边界与回归原则

### 11.1 分层

适配现有 Pinia 三层架构时，建议按领域划分：

- `chat/data-sources`：本机 Telegram Worker bridge、IndexedDB 缓存、媒体/文件资源句柄；
- `chat/stores`：会话列表、当前 chat/thread、消息页、分页游标、连接/同步状态、请求态；
- `views`：读取 Store 并渲染，不直接 `fetch`，不声明本地 `ref`/`reactive`；
- 远端 Worker：只处理 Lattice 账户认证和 Telegram 绑定/设备元数据。

MTProto 客户端、abort controller、MediaSource、Object URL、HTML media element 等不可序列化句柄，不应直接塞入 Pinia 持久状态。

### 11.2 每阶段都手动验证的基础清单

- 同一 auth key 只有一个主连接所有者，防止多 tab 并发连接。
- Worker 断开/重连会恢复 updates，不重复重建全量历史。
- 快速切换会话/线程时，旧响应不能污染当前状态。
- 消息 ID 和 media file ID 不以 JS 不安全整数精度丢失；Telegram 64-bit ID 需要字符串或 bigint 安全处理。
- 文件下载不进入 D1；浏览器缓存仅保存在设备本地并遵守明确的清理/锁定策略。
- 大列表滚动、弱网、后台恢复、切换账号、重新登录和 session 失效都应做真实在线回归。

---

## 12. 参考源码索引

路径均相对于 `/Volumes/Lenovo/参考项目/Telegram-web-z-master`：

| 主题 | 主要文件 |
|---|---|
| Worker 内 TelegramClient / 初始化与 keepalive | `src/api/gramjs/methods/client.ts`、`src/lib/gramjs/client/TelegramClient.ts`、`src/api/gramjs/worker/` |
| Updates / Difference / channel scheduler | `src/api/gramjs/updates/updateManager.ts`、`src/global/actions/api/sync.ts` |
| 会话列表同步和分页 | `src/global/actions/api/chats.ts`、`src/api/gramjs/methods/chats.ts` |
| 消息视口与历史分页 | `src/global/actions/api/messages.ts`、`src/components/middle/MessageList.tsx` |
| 冷启动缓存与裁剪 | `src/global/cache.ts`、`src/util/browser/idb.ts` |
| 媒体标识、尺寸与格式策略 | `src/global/helpers/messageMedia.ts`、`src/api/gramjs/apiBuilders/media.ts` |
| Cache Storage 与媒体下载重试 | `src/util/mediaLoader.ts`、`src/util/cacheApi.ts`、`src/api/gramjs/methods/media.ts` |
| Range / Service Worker | `src/serviceWorker/progressive.ts`、`src/util/progressiveLoader.ts` |
| 聊天内视频 / 圆形视频 | `src/components/middle/message/Video.tsx`、`RoundVideo.tsx`、`OptimizedVideo.tsx` |
| 完整视频播放器 / seek | `src/components/mediaViewer/VideoPlayer.tsx`、`VideoPlayerControls.tsx`、`SeekLine.tsx` |
| Safari story MSE 流 | `src/hooks/useStreaming.ts`、`src/components/story/Story.tsx` |
| 归档、加入和退出 | `src/global/actions/api/chats.ts`、`src/api/gramjs/methods/chats.ts`、`src/global/actions/apiUpdaters/chats.ts` |

---

## 13. 调研范围限制

- 本文通过阅读用户提供的本地参考仓库源码得出，不是对 Telegram 后端私有实现的观察。
- 参考仓库存在特定版本、浏览器检测、用户设置和 feature flag 分支；配置值只能说明该版本的选择，不能当作 Telegram 协议硬性要求。
- 后续落地前，应结合当前安装的 GramJS 版本、目标 Web/Electron/iOS 浏览器能力和正式 API schema，再验证所需方法、文件引用恢复、Range 行为和更新处理。
- 如果目标是完整归档/导出消息，而非 Telegram 的“归档聊天”文件夹，需另行定义本地归档的存储、搜索、附件保留和删除语义；那与本文第 9 节的 Telegram folder 不同。
