# 架构规则固化 + Telegram 媒体磁贴 + 会话管理中心扩展计划

## 0. 语音输入整理

| 你的原话 | 整理后的需求 |
| --- | --- |
| 新构建的一套总线系统以及并发，希望规则永远跟随架构走 | 把 9 条 Telegram 业务总线、RequestScheduler 并发预算、取消/优先级/错误分桶写成强制规则，并做成可执行门禁，而不只是 research 文档 |
| 拖进去现在已经有了 | 聚合搜索 → 磁贴的拖拽导入链路保留，不改；Explore 树与磁贴板是同一套拓扑，不设计两套落点语义 |
| 视频或图片磁贴默认点击改成“打开” | 方案 B：不跳转 Chats，在工作区常驻的媒体查看器中直接打开；视频复用聊天域的流媒体链路 |
| 现有逻辑改为“右键详情” | 原来的文件详情弹窗移到右键菜单的“详情”，左键不再默认打开详情 |
| 类型统一叫“telegram媒体链接” | 磁贴展示类型统一为“Telegram 媒体链接”，但底层仍保留 image/video 以复用视觉与播放器 |
| 会话管理中心允许多选 + 封面刷新 | 会话管理中心刷新选中会话的封面；同一会话已录入磁贴时，所有对应磁贴引用一起刷新，且同一规范资源只请求一次 |
| 临时会话凭据时页面没办法选择、多选以及拖动 | 临时会话凭据池新增单选、Shift 连选、全选/清空，以及将一个或多个凭据拖入 Explore 拓扑 |
| 一个图片、一个视频或任何对象被拖成多个磁贴 | 采用“规范资源 Asset + 多个磁贴实例引用”：不复制媒体/文件数据；每个磁贴只保存位置、尺寸和可选展示覆盖 |
| 允许把它拖到“词典系统” | 按语音误差整理为拖到 Explore 树/磁贴系统；二者共享同一拓扑和同一持久化入口 |

> 以下方案已采用你刚才确认的决策：媒体左键使用“不跳页直接打开”方案；封面刷新发生在会话管理中心，并联动全部引用；临时会话凭据池也必须支持多选和拖拽；Explore 树与磁贴系统等价。唯一需要迁移设计的是“同一对象多个磁贴”的规范化持久化模型。

---

## 1. Context

### 1.1 规则现状

`docs/research/gramjs-business-bus-rearchitecture.md` 已经定义 9 条总线、4 个共享内核、并发预设和 RequestScheduler，但它是 research 文档，不是强制规范：

- `.rules/state-management.md` 已写了并发单一来源，但聊天数据流仍引用已删除的 `chatDataSource`，与当前 `TelegramBusClient → BusRouter` 不一致；
- `.rules/` 没有一份文档完整列出 9 条总线的职责边界、禁止跨总线调用、上下文必填字段、取消/优先级/错误分桶；
- `scripts/check-architecture.mjs` 已有 GramJS 边界、RPC 边界、硬编码并发、旧协议等规则，但缺少：
  - 视图层禁止直接使用 `telegramBusClient` / `mtprotoBridge`；
  - `contracts/buses.ts`、`runtime/busRouter.ts`、`telegramBusClient` 三者总线/操作集合一致性；
  - 禁止 Worker 总线反向引用主线程 Store；
  - 禁止在 runtime/transport 之外 `new TelegramClient`；
  - 新增总线却漏接 BusRouter / 监控子池的检测。
- 目前没有针对总线契约的独立测试；只有 `test:scheduler` 与 `test:session-parser`。

### 1.2 磁贴与资源现状

- 聚合搜索视频/图片结果拖入磁贴时，`tileStore.importSearchResultsToTopology()` 已写入 `photoInfo` / `videoInfo` / `sources` / `thumb.sourceRef`。
- 当前 `FileTileData` 同时承载两类状态：一类是对象本身（来源、媒体定位、封面、文件元数据），另一类是磁贴实例（`id`、分组、父文件夹、坐标、尺寸）。同一对象被多次拖入时会复制前一类数据。
- 现有封面 OPFS 路径以 `tileId` 为主，`TempSessionCredential.linkedTileIds` 也保存了反向索引；这会让多个实例刷新同一对象时重复请求、重复存储和重复合并。
- 当前左键点击磁贴在 `TileGroupContainer.handleTileClick()` 和 `TileFolderModal` 中统一调用 `tileStore.openFile()`，打开 `FileDetailModal`；右键菜单也打开详情。
- 当前聊天域已有完整媒体打开链路：`chatMediaStore.openViewer()`、`chatVideoStore`、`progressiveStream`、`streamBus`。但查看器挂在 `ConversationContainer`，归档页无法直接复用。
- 当前 Explore 树和磁贴板都由 `tileStore` 的 `groups + tiles + FolderTileData.children` 表示；它们是同一拓扑，不应新增第二套“磁贴目标”数据模型。

### 1.3 会话管理中心现状

- 普通会话 Tab 的 `sessionManagerStore.selectedPeerKeys` 已支持单选、Shift 连选、全选当前、清空。
- 临时会话凭据 Tab 只有逐条“生成磁贴/转正/删除”，没有选择态、多选态、Shift 连选和拖拽状态。
- 普通会话已支持拖到左侧 Explore 树：`startDragSessionCardToTree()` → `aggregateSearchStore.dragToTree` → `finishDragToTree()` → `importSearchResultsToTopology()`。
- 临时凭据也已经有 `TempSessionCredential.linkedTileIds` 和单条 `placeTempCredentialTile()`，但它们不是规范化资源索引，不能作为多实例架构的最终 SSOT。
- 会话管理中心已有收纳后 `scheduleTileCoverRefresh()`，但没有“刷新选中会话封面”的显式动作，也没有按资源去重后同时更新列表头像和所有磁贴实例。
- 会话管理中心是全屏弹窗；由于 Explore 树属于同一个拓扑，首选是把拖拽目标限定为弹窗内可见的 Explore 树/树节点。若必须拖到背后的磁贴板，需要 CSS 收起弹窗而不是复制一套落点逻辑。

---

## 2. Approach

### Workstream A：把总线与并发变成强制规则

推荐新增一份规则文档，并把关键约束变成 `pnpm build` 门禁，形成“文档 + 静态检查 + 契约测试”三层。

#### A1. 新增 `.rules/telegram-bus-and-concurrency.md`

必须写清以下规范性内容：

1. **唯一调用链**
   ```text
   View（零 ref）
     → Store（SSOT）
       → Data Source（薄桥）
         → TelegramBusClient
           → mtprotoBridge / tg.worker
             → BusRouter
               → 9 条业务总线之一
                 → RequestScheduler
                   → TransportKernel
                     → GramJS TelegramClient
   ```
2. **9 条总线职责矩阵**：AccountSession / ChatRead / Search / Cover / MediaAsset / Stream / ChatCommand / BotInteraction / VaultTransfer；明确每条“负责 / 不负责”。
3. **共享内核**：TransportKernel、RequestScheduler、EntityReferenceStore、TelemetryKernel。
4. **新增总线的准入清单**：契约、BusRouter 路由、TelegramBusClient 方法、监控子池映射、测试、规则文档，五者缺一不可。
5. **禁止项**：
   - 业务代码不得直接 import GramJS / `Api.*` / `TelegramClient`；
   - 不得绕过 `TelegramBusClient` 直接 `requestBus`；
   - 不得跨总线调用另一条总线的实现函数；
   - 不得在总线内自建并发池或硬编码并发数字；
   - 不得在 `buses/**` 反向引用 `@/stores/**`；
   - 不得恢复旧 `TgChatRequest` / 字符串方法分发器。
6. **上下文必填字段**：`requestId`、`traceId`、`accountId`、`operation`、`priority`、`AbortSignal`、`source`。
7. **并发规则**：
   - 唯一来源 `src/worker/local/telegram/contracts/concurrency.ts`；
   - 用户配置上限 ≠ 调度器运行时有效值；
   - 子池受账号级总预算约束；
   - 搜索封面保留槽位；
   - 大量任务只能进有界队列，禁止无界 `Promise.all` 发起 RPC；
   - FloodWait / 超时 / 账号切换的降速、取消和恢复规则。
8. **错误与遥测**：领域错误分桶、不得回传 GramJS 异常、统一 `bus.request` span、监控帧不包含正文/标题/文件名。
9. **变更检查清单**：改总线 / 并发 / 新增操作时必须跑的测试和验证。

#### A2. 更新 `AGENTS.md`

- 规则索引加入新文档；
- “硬性约束”新增 2 条：
  - Telegram 数据只能经 9 条业务总线；
  - 并发只能读 `concurrency.ts`，不得自建池；
- “变更检查清单”加入：
  - 新增总线/操作是否同步 BusRouter、Client、监控、测试；
  - `pnpm test:bus` 是否通过。

#### A3. 修正 `.rules/state-management.md`

- 把聊天数据流里的旧 `chatDataSource` 改成：
  ```text
  chatStore → chat 域 Data Source → telegramBusClient
    → mtprotoBridge → tg.worker → BusRouter → 对应总线 → RequestScheduler
  ```
- 把“并发配额”段落链接到新规则文档，避免两份规则漂移；
- 补充“媒体打开”边界：磁贴只保存可序列化来源定位，播放器句柄仍归 `videoPlayback` / `chatMediaStore`。

#### A4. 扩展 `scripts/check-architecture.mjs`

在现有 10 条规则基础上新增：

| 规则 id | 检查内容 |
| --- | --- |
| `views-no-telegram-bus` | `src/views/**` 禁止 import `telegramBusClient`、`mtprotoBridge`、`mtprotoHub` |
| `worker-no-main-stores` | `src/worker/local/telegram/**` 禁止 import `@/stores/**` |
| `telegram-client-construction` | `new TelegramClient` 只能出现在 `telegram/runtime/`、`telegram/transport*` |
| `orphan-bus-implementation` | `telegram/buses/*.ts`（排除 parser）必须被 `busRouter.ts` 引用 |
| `bus-contract-sync` | `contracts/buses.ts` 的 `TelegramBusOps` 键与 `busRouter.ts` 的 `ROUTES` 键一致；`telegramBusClient` 顶层键一致 |
| `bus-monitor-coverage` | `contracts/monitor.ts` 的总线映射必须覆盖 9 条总线 |
| `no-unbounded-promise-all` | `telegram/buses/**` 禁止裸 `Promise.all` 发起 RPC；确有需要的文件加入只减不增的豁免 |

> `bus-contract-sync` / `bus-monitor-coverage` 用静态解析实现；如果解析复杂，改为独立 `scripts/test-bus-contract.mjs`，在 `pnpm build` 中排在 `arch:check` 之后。

#### A5. 新增 `scripts/test-bus-contract.mjs`

零依赖 Node 脚本，做运行期/源码级一致性校验：

- 9 条总线名称固定；
- `TelegramBusOps` 每个 bus 至少有一个 op；
- `ROUTES` 与 `TelegramBusOps` 完全对齐；
- `telegramBusClient` 暴露的顶层 bus 与契约一致；
- 每条总线在 `monitor.ts` 有子池映射；
- 输出中文失败原因。

`package.json` 增加：

```json
"test:bus": "node scripts/test-bus-contract.mjs",
"build": "node scripts/check-architecture.mjs && node scripts/test-bus-contract.mjs && vue-tsc -b && tsc -p tsconfig.worker.json && vite build"
```

#### A6. 文档与 research 的关系

- `.rules/telegram-bus-and-concurrency.md` 是**规范**；
- `docs/research/gramjs-business-bus-rearchitecture.md` 保留为设计背景和实现记录；
- 两者冲突时以 `.rules/` 为准，并在 research 顶部加一行“规范以 .rules 为准”。

---

### Workstream B：视频/图片磁贴默认“打开”，详情移到右键

#### B1. 资源与磁贴实例的持久化模型（核心设计）

**推荐结论：不存多个副本，也不把完整媒体对象继续嵌在每个磁贴中；持久化一个规范资源 Asset，多个磁贴实例通过 `resourceId` 引用它。**

```ts
interface ExploreResource {
  id: string;
  kind: 'telegram-message' | 'telegram-session' | 'local-file' | 'note';
  identityKey: string;
  source?: TelegramResourceSource;
  metadata: ResourceMetadata;
  thumbnail?: ResourceThumbnailRef;
  createdAtMs: number;
  updatedAtMs: number;
  deletedAtMs?: number;
}

interface FileTileData extends BaseTileData {
  resourceId?: string;
  fileType: FileCategory;
}

interface ExploreManifestV3 extends ExploreManifestV2 {
  schemaVersion: 3;
  resources: Record<string, ExploreResource>;
}
```

资源身份键：Telegram 媒体使用 `tg:<accountId>:<peerKey>:<messageId>:<mediaId>`（无 mediaId 时回退消息 ID + kind）；会话使用 `tg-session:<accountId>:<peerKey>`；本地文件必须有稳定 ID，不得仅以显示名/路径去重；笔记使用稳定 note ID。临时凭据和正式会话是同一个会话资源，凭据状态另行更新，不创建重复对象。

持久化职责：

- `ExploreResource` 保存来源定位、多源引用、媒体/会话元数据、共享描述和封面引用；
- tile instance 保存实例 ID、resourceId、拓扑位置/尺寸/排序、标题或标签覆盖；默认从资源继承；
- Telegram auth key 等敏感凭据仍只由凭据保险库管理，资源仅引用 `credentialId`；
- 高清缩略图路径改为 `/resource-thumbs/{resourceId}.webp`，ObjectURL 只在 Data Source 内存缓存，manifest 不存 ObjectURL；
- 删除一个 tile 只删实例；最后一个引用消失后由延迟 orphan GC 回收资源与封面。资源级删除需单独 tombstone，不能因删除一个引用而删除共享资源；引用数实时计算，不冗余持久化易漂移的 `refCount`。
- 同一个对象拖入多个目录时新建多个实例并共享 resourceId；媒体字节、Telegram DTO、高清封面不复制。

#### B2. V2 → V3 兼容迁移与 CRDT

- 本地 localStorage、OPFS manifest、云同步 manifest 和 `.lattice-archive` 冷备导入统一调用纯函数 `migrateExploreManifestV2ToV3()`，不清空 D1、不要求重建线上库。
- 递归扫描顶层及文件夹 children，为稳定 identityKey 建唯一 resource，旧 tile 写入 resourceId；不确定身份的数据使用 `legacy:<tileId>`，禁止误合并；实例 ID、位置、尺寸、标题保持不变。
- 同 identityKey 的旧 tile 合并资源元数据：按 `updatedAtMs` LWW，多来源按来源身份稳定去重，封面选择可用且较新的版本；迁移幂等。
- 新 manifest 使用 schemaVersion 3。CRDT 分别合并 resources、tile instances、tombstones：资源 metadata LWW、多源集合并集、tile 布局按实例 ID LWW；缺失资源引用时优先由旧字段修复，否则保留占位并记结构化告警，不静默删 tile。
- 资源表和 tile refs 在一个压缩 manifest 中原子同步，避免跨设备出现只有引用没有资源的中间状态。
- 冷备包 V3 缩略图索引由 `tileId → bytes` 改为 `resourceId → bytes`；V2 包通过迁移映射重建资源缩略图。
- OPFS GC 按有效 resource IDs 判断孤儿；保留兼容窗口，迁移完成且所有 manifest 写为 V3 后再回收旧 tileId 缩略图。

不采用每个磁贴复制完整文件/媒体：其存储、云同步流量、封面刷新 RPC 和 CRDT 冲突都会随实例数放大，更新后副本易分叉。规范资源与实例引用分离后，资源内容唯一、布局可独立。

#### B3. 媒体磁贴默认行为与展示类型

- 底层 `FileCategory` 仍是 `image | video`，不破坏搜索筛选和文件视觉；展示标签为“Telegram 媒体链接”。
- 纯函数 `isTelegramMediaTile()` / `tileTypeLabel()` / `mediaSourceOf()` 根据 resource kind/source 判断，不靠文件扩展名猜测。
- `TileGroupContainer` 和 `TileFolderModal` 左键打开归档页内查看器，不改变路由、不切换 activeChatKey；拖动手势阈值不变，拖动不触发打开。
- `AppLayout.vue` 常驻挂载唯一 `MediaViewer`；Chats 不再创建第二个实例。
- `chatMediaStore.viewer` 改为 discriminated union：`message`（现有聊天查看）或 `resource`（resourceId + 可序列化 photo/video DTO + 来源）。查看器直接由 `chatMediaStore` 管理，照片/视频下载、视频流 Range、seek、取消、缓存都继续复用 `chatMediaLoader`、MediaAssetBus、StreamBus、`videoPlayback`。
- resource viewer 不伪造/写入 chatStore 消息窗口；隐藏消息翻页语义。文件引用过期时经已有 Worker 总线刷新/错误路径处理，禁止主线程直接 RPC。
- 右键菜单将原“查看文件详情”改为“详情”；Telegram 媒体增加“打开”。详情仍调用原 FileDetailModal。
- 非 Telegram 图片/视频、无稳定来源的旧条目仍使用原详情行为。


- 纯函数测试：`isTelegramMediaTile` / `tileTypeLabel` / `mediaSourceOf`（可用 Node 脚本）。
- 手工验证：
  - 搜索结果视频拖入分组 → 左键 → 聊天查看器打开并流式播放；
  - 图片 → 左键 → 照片查看器；
  - 右键 → 详情 → 原 `FileDetailModal`；
  - 没有 Telegram 来源的 mock 磁贴 → 左键仍打开详情；
  - 离线 / 消息已删除 → 提示并回退，不崩溃；
  - 拖拽磁贴不会误触打开。

---

### Workstream C：会话管理中心多选与封面刷新、拖入磁贴

#### C1. 复用现有多选

保留 `sessionManagerStore` 现有实现：

- `selectedPeerKeys`
- `handleSessionCardClick()`（Shift 连选）
- `selectAllFilteredPeers()`
- `clearSelectedPeers()`
- `lastClickedPeerIndex`

只补一个 getter：

```ts
selectedDialogs: computed(() => filteredDialogs.filter(d => selectedPeerKeys.includes(d.key)))
```

避免视图和 action 反复过滤，保持 SSOT。

#### C2. 批量封面刷新

新增 `sessionManagerStore.refreshSelectedSessionCovers()`：

1. 校验 `selectedPeerKeys.length > 0`，否则写 `coverRefreshNotice = '请先勾选至少一个会话'`；
2. 对选中会话：
   - 刷新会话列表头像：调用 `chatMediaStore.refreshDialogAvatars(peerKeys)`；
   - 刷新已落位磁贴：在 `tileStore` 中递归查找 `peerKey/sessionId` 命中选中集合的会话磁贴，收集 `tileId`，调用 `tileStore.refreshTileCoversByIds(ids)`；
3. 进度/结果写入 `sessionManagerStore`：
   - `isRefreshingSelectedCovers`
   - `coverRefreshNotice`
   - `lastCoverRefreshAt`
4. 全部走 `coverImageBus` / `chatMediaLoader`，不新增并发池，不直接调 `telegramBusClient.cover`。

`chatMediaStore` 新增最小 action：

```ts
async refreshDialogAvatars(peerKeys: string[]) {
  // 1. 计算 avatarKey
  // 2. 取消在途 loader
  // 3. 删除 entries[key]
  // 4. 删除 chatMediaCache 对应条目
  // 5. 重新 handleAvatarVisibility(peerKey, true)
}
```

注意：

- 不清空整个媒体缓存，只清选中会话头像；
- 批量刷新必须受 `chatMediaLoader` 既有并发限制；
- 失败按会话记录，不因一个失败中断全部；
- 视图零 ref，按钮状态和提示都从 Store 读。

UI：在 `SessionManagerModal` 第二行“一键收纳”旁增加“刷新选中封面 (n)”按钮；主按钮不置灰，未选中时点击显示中文提示。

#### C3. 拖入磁贴系统

当前已有“拖到左侧 Explore 树”，需要确认是否满足需求：

**方案 C3-A（最小改动，推荐先做）**

- 保留现有 `startDragSessionCardToTree()` + `dragToTree` + `finishDragToTree()`；
- 在文档和 UI 提示中明确“拖到左侧 Explore 分组/文件夹即进入磁贴系统”；
- 只补批量封面刷新；
- 不新增跨弹窗拖拽，避免全屏弹窗遮挡和复杂状态。

**方案 C3-B（直接拖到磁贴板，改动更大）**

若必须把会话拖到弹窗背后的磁贴板：

1. 新增 `src/stores/archive/stores/topologyDragStore.ts`，承接当前 `aggregateSearchStore.dragToTree`：
   - payload（items / pointer / hoverTargetType / hoverTargetId / hoverTargetTitle）
   - `startDrag()` / `updatePointer()` / `finishDrag()` / `cancelDrag()`
   - 聚合搜索和会话管理中心共用，避免拖拽状态归聚合搜索域。
2. `TileBoard.vue` / `TileGroupContainer.vue` 增加落点属性：
   - `data-board-drop-group-id`
   - `data-board-drop-folder-id`
3. `updatePointer()` 统一用 `document.elementFromPoint()` 探测：
   - 文件夹磁贴 → `addFileToFolder` / `importSearchResultsToTopology(folder)`
   - 分组空白 → `importSearchResultsToTopology(group)`
4. 会话管理中心拖拽开始后进入“拖拽模式”：
   - 弹窗不卸载，只 CSS 收起到顶部/侧边，露出磁贴板（保持 DOM 稳定，符合 frontend-architecture 的“无突变折叠”规则）；
   - 拖拽结束或取消后恢复；
   - 或者提供一个“拖到磁贴板”专用把手，点击后临时收起弹窗。
5. 所有拖拽中间态进 Store，视图零 ref。

> 由于全屏弹窗与磁贴板的空间冲突，C3-B 的交互成本明显高于 C3-A。建议先确认你是否真的需要“拖到板”，还是“拖到左侧 Explore 树”已经满足。

#### C4. 测试

- 多选：单选、Shift 连选、全选、清空；
- 批量刷新：选中 1 个 / 多个 / 无选中 / 离线 / 部分失败；
- 刷新后会话头像与已落位磁贴封面都更新；
- 拖拽到分组 / 文件夹（若做 C3-B）；
- 重复会话不重复创建磁贴；
- 拖拽取消不创建磁贴、不改变选中态。

---

## 3. Files to modify

### 规则与门禁

- `docs/plan/architecture-rules-and-media-tile-session-plan.md`（本计划）
- `.rules/telegram-bus-and-concurrency.md`（新增）
- `AGENTS.md`
- `.rules/state-management.md`
- `.rules/frontend-architecture.md`（补磁贴点击/拖拽边界）
- `scripts/check-architecture.mjs`
- `scripts/test-bus-contract.mjs`（新增）
- `package.json`（`test:bus`，可选加入 `build`）

### 媒体磁贴

- `src/views/main/archive/utils/tilePresentation.ts`（新增）
- `src/views/main/archive/components/board/TileGroupContainer.vue`
- `src/views/main/archive/components/folder-modal/TileFolderModal.vue`
- `src/views/main/archive/components/context-menu/TileContextMenu.vue`
- `src/views/main/archive/components/tiles/FileTile.vue`
- `src/views/main/archive/components/file-modal/FileDetailModal.vue`
- `src/views/main/archive/ArchivePlaceholderView.vue`（如需媒体打开提示条）
- `src/stores/archive/stores/tileStore.ts`（`openTelegramMedia` / `mediaOpenNotice`）
- `src/stores/chat/stores/chatStore.ts`（优先复用，不改；必要时把 `focusMessageInChat` 的定位结果返回）
- `src/stores/chat/stores/chatMediaStore.ts`（优先复用 `openViewer`，不复制播放器）

### 会话管理中心

- `src/stores/archive/stores/sessionManagerStore.ts`
- `src/views/main/archive/components/session-manager/SessionManagerModal.vue`
- `src/stores/chat/stores/chatMediaStore.ts`（`refreshDialogAvatars`）
- `src/stores/archive/stores/tileStore.ts`（按 peerKey 查找会话磁贴 / 批量刷新）
- `src/stores/archive/stores/topologyDragStore.ts`（仅 C3-B）
- `src/stores/archive/stores/aggregateSearchStore.ts`（仅 C3-B 迁移拖拽状态）
- `src/views/main/archive/components/board/TileBoard.vue`（仅 C3-B 落点）
- `src/views/main/archive/components/search-modal/**`（仅 C3-B 改用新拖拽 Store）

---

## 4. Reuse

| 能力 | 复用位置 |
| --- | --- |
| 打开会话、切账号、补历史、定位消息 | `chatStore.openSessionFromTile()` |
| 照片/视频查看器 | `chatMediaStore.openViewer()` |
| 视频流播放、画质、seek、降级 | `chatVideoStore` + `progressiveStream` + `streamBus` |
| 批量磁贴封面刷新 | `tileStore.refreshTileCoversByIds()` |
| 导入后自动补封面 | `tileStore.scheduleTileCoverRefresh()` |
| 磁贴封面拉取 | `fetchAndApplyCoverForFileTile()` / `coverImageBus` |
| 会话多选 | `sessionManagerStore.selectedPeerKeys` / `handleSessionCardClick()` |
| 拖到 Explore 树 | `startDragSessionCardToTree()` / `dragToTree` / `finishDragToTree()` |
| 搜索/会话批量入柜 | `tileStore.importSearchResultsToTopology()` |
| 并发唯一来源 | `contracts/concurrency.ts` / `RequestScheduler` |
| 架构门禁 | `scripts/check-architecture.mjs` |
| 调度器测试 | `scripts/test-request-scheduler.mjs` |

---

## 5. Steps

### Phase 1：规则固化（先做，防止后续功能继续绕开总线）

- [ ] 新增 `.rules/telegram-bus-and-concurrency.md`，写 9 总线矩阵、调用链、禁止项、并发规则、错误/遥测、变更清单。
- [ ] 更新 `AGENTS.md` 规则索引、硬性约束、检查清单。
- [ ] 修正 `.rules/state-management.md` 中旧的 `chatDataSource` 数据流，补总线调用链和媒体打开边界。
- [ ] 扩展 `scripts/check-architecture.mjs` 的 7 条新规则；已有违规只进“只减不增”的 LEGACY 豁免。
- [ ] 新增 `scripts/test-bus-contract.mjs`，校验 contracts / ROUTES / client / monitor 一致性。
- [ ] `package.json` 增加 `test:bus`，并决定是否并入 `build`。
- [ ] 跑 `pnpm arch:check`、`pnpm test:bus`、`pnpm build`，确认 0 新增违规。

### Phase 2：媒体磁贴默认打开

- [ ] 新增 `tilePresentation.ts`：`isTelegramMediaTile` / `tileTypeLabel` / `mediaSourceOf`。
- [ ] `tileStore` 新增 `openTelegramMedia(tile)` 与 `mediaOpenNotice` / `mediaOpenError`。
- [ ] `TileGroupContainer.handleTileClick` 与 `TileFolderModal` 左键改为媒体打开，其余保持详情。
- [ ] `TileContextMenu` 增加“打开”，原“查看文件详情”改为“详情”。
- [ ] `FileTile` / `FileDetailModal` 类型文案改为“Telegram 媒体链接”。
- [ ] 验证图片、视频、asFile 视频、无来源、离线、删除消息 6 种情况。
- [ ] 确认拖拽不会误触打开。

### Phase 3：会话管理中心

- [ ] 保留现有多选，新增 `selectedDialogs` getter。
- [ ] `chatMediaStore.refreshDialogAvatars(peerKeys)`：取消在途、清 entries、清缓存、重新请求。
- [ ] `sessionManagerStore.refreshSelectedSessionCovers()`：同时刷新会话头像与已落位磁贴封面。
- [ ] `SessionManagerModal` 增加“刷新选中封面”按钮与 Store 驱动提示。
- [ ] 确认拖入磁贴系统的范围：
  - C3-A：保留拖到左侧 Explore 树，补文案与测试；
  - C3-B：若确认要直接拖板，再新增 `topologyDragStore`、板级落点和弹窗收起模式。
- [ ] 跑批量刷新、多选、拖拽、重复落位测试。

### Phase 4：验证与收口

- [ ] `pnpm build` 全绿（含 arch:check + test:bus + vue-tsc + worker tsc + vite）。
- [ ] `pnpm test:scheduler`、`pnpm test:session-parser`、新增纯函数测试全绿。
- [ ] 真实 Telegram 账号手工验收媒体播放与封面刷新。
- [ ] 更新 README / AGENTS 的目录与规则索引。
- [ ] 确认无 `src/services/`、无视图本地 ref、无硬编码并发、无旧协议回流。

---

## 6. 需要你确认的决策点

1. **“词典系统”是否是“磁贴系统”的语音误差？**
   - 如果是：会话拖拽目标就是左侧 Explore 树 / 磁贴板。
   - 如果确实是另一个“词典”功能：请指出对应页面或模块，我需要重新定位。

2. **媒体磁贴左键“打开”是哪种体验？**
   - A（推荐，改动小）：跳到 `/workspace/chats/:chatKey`，用现有聊天查看器打开并播放；
   - B（不跳页）：在归档页直接弹出同一个播放器，需要把 `MediaViewer` 提升为跨域组件，并改造 `chatMediaStore` 接受外部媒体 DTO，改动明显更大。

3. **“封面刷新”刷新哪一层？**
   - A（推荐）：同时刷新会话列表头像 + 已落位会话磁贴封面；
   - B：只刷新会话列表头像；
   - C：只刷新已落位磁贴封面。

4. **会话拖拽是否必须直接拖到磁贴板？**
   - A（推荐先做）：保留现有“拖到左侧 Explore 树”，它已经进入磁贴系统；
   - B：必须拖到弹窗背后的磁贴板，需要增加弹窗收起/浮层拖拽模式。

---

## 7. Verification

### 自动化

```bash
pnpm arch:check
pnpm test:bus
pnpm test:scheduler
pnpm test:session-parser
pnpm build
```

- 负向验证：临时在 `src/views/**` 写入 `telegramBusClient`、在总线内写 `new TelegramClient`、新增一个未接入 BusRouter 的 bus 文件，确认 `arch:check` / `test:bus` 会失败；验证后删除临时改动。

### 手工验收矩阵

| 场景 | 预期 |
| --- | --- |
| 搜索结果视频拖入分组 → 左键 | 打开聊天查看器，走流媒体播放 |
| 搜索结果图片拖入文件夹 → 左键 | 打开照片查看器 |
| 媒体磁贴右键 → 详情 | 打开原 `FileDetailModal` |
| 非媒体文件左键 | 仍打开详情 |
| 无 Telegram 来源的 mock 磁贴左键 | 回退详情并提示 |
| 离线 / 消息已删除 | 中文提示，不崩溃，不进入死循环 |
| 会话多选（Shift / 全选 / 清空） | 选中态与计数正确 |
| 选中会话 → 刷新封面 | 会话头像与已落位磁贴封面更新，失败会话单独提示 |
| 拖会话到左侧 Explore 分组 / 文件夹 | 创建会话磁贴；重复会话不重复创建 |
| 拖拽取消 | 不创建磁贴，选中态不变 |
| 拖拽磁贴 | 不触发“打开” |
| 账号切换 / 关闭查看器 | 取消在途流分片，不串账号 |

### 性能与安全边界

- 不新增并发池，不硬编码并发；
- 批量刷新封面必须走 `coverImageBus` 与既有调度子池；
- 不在磁贴 Store 保存 Blob / ObjectURL / HTMLVideoElement；
- 不在日志中记录消息正文、会话标题、文件名；
- 不改变 `migrate` 部署模式，不触碰 D1。
