/**
 * ============================================================================
 * 聚合搜索系统 Mock 临时垫层 (Aggregate Search Mock Layer)
 * ============================================================================
 * 业务归属：磁贴归档 -> 聚合搜索系统（预创建前端阶段）
 * 生命周期：【接线即删】当远端/本地 SQLite 聚合检索接口正式就绪并接入
 * `aggregateSearchDataSource.ts` 后，必须立即物理删除本文件。
 *
 * 包含内容：
 * 1. SEARCH_CATEGORY_OPTIONS：搜索前筛选的 5 类文件类型定义（视频、图片、会话、文本文件、其他）
 * 2. MOCK_SCOPE_SESSIONS：右栏搜索范围控制的两类会话源（已加入的会话 / 只有凭据的会话）
 * 3. MOCK_SEARCH_RESULTS_POOL：支持流式分块推送与触底懒加载的拟真归档检索结果池
 */
import type {
  AggregateSearchResultItem,
  SearchCategoryOption,
  SearchPreFilterCategory,
  SearchScopeSessionDto,
} from '../types';
import type { FileCategory } from '@/views/main/archive/types/tile';

/**
 * 搜索前筛选 —— 按文件类型筛选的 5 个标准可选项
 */
export const SEARCH_CATEGORY_OPTIONS: SearchCategoryOption[] = [
  {
    value: 'video',
    label: '视频',
    shortCode: 'VID',
    description: 'MP4 / MKV / WebM 录屏、技术演示与流媒体片段',
  },
  {
    value: 'image',
    label: '图片',
    shortCode: 'IMG',
    description: 'PNG / WebP / SVG 架构图、设计原稿与相册快照',
  },
  {
    value: 'session',
    label: '会话',
    shortCode: 'CHAT',
    description: 'Telegram 群组讨论串、频道专题归档与对话快照',
  },
  {
    value: 'text',
    label: '文本文件',
    shortCode: 'TXT',
    description: 'Markdown 笔记、代码源文件、JSON/YAML 配置与 PDF 文档',
  },
  {
    value: 'other',
    label: '其他',
    shortCode: 'EXT',
    description: '加密压缩包、SQLite 索引库、二进制固件与无损音频',
  },
];

/**
 * 右栏「搜索范围控制」Mock 会话源：
 * - 第一类 (joined)：所有我们已加入的会话
 * - 第二类 (credential_only)：所有我们只有凭据的会话
 */
export const MOCK_SCOPE_SESSIONS: SearchScopeSessionDto[] = [
  // ── 第一类：已加入的会话 (joined) ─────────────────────────────────────
  {
    id: 'sess-joined-core',
    title: 'Lattice 核心架构研发群',
    initials: 'LC',
    kind: 'joined',
    peerTypeLabel: '超级群组',
    handleOrHash: '@lattice_core_dev',
    itemCountLabel: '18.4k 条消息',
    accentClass: 'bg-gradient-to-br from-sky-500 to-blue-600 text-white',
  },
  {
    id: 'sess-joined-design',
    title: 'Swiss Tech 视觉与动效实验室',
    initials: 'ST',
    kind: 'joined',
    peerTypeLabel: '官方频道',
    handleOrHash: '@swiss_tech_ui',
    itemCountLabel: '4,290 份媒体',
    accentClass: 'bg-gradient-to-br from-cyan-500 to-teal-600 text-white',
  },
  {
    id: 'sess-joined-wasm',
    title: 'Rust & WebAssembly 编译组',
    initials: 'RW',
    kind: 'joined',
    peerTypeLabel: '超级群组',
    handleOrHash: '@rust_wasm_cn',
    itemCountLabel: '9,610 条消息',
    accentClass: 'bg-gradient-to-br from-amber-500 to-orange-600 text-white',
  },
  {
    id: 'sess-joined-perf',
    title: '前端合成管线与 GPU 优化',
    initials: 'GP',
    kind: 'joined',
    peerTypeLabel: '研讨群组',
    handleOrHash: '@compositor_pipeline',
    itemCountLabel: '6,120 条消息',
    accentClass: 'bg-gradient-to-br from-emerald-500 to-teal-700 text-white',
  },
  {
    id: 'sess-joined-cross',
    title: 'Electron & iOS 跨端容器联调',
    initials: 'EI',
    kind: 'joined',
    peerTypeLabel: '工作群组',
    handleOrHash: '@cap_electron_ios',
    itemCountLabel: '3,480 条消息',
    accentClass: 'bg-gradient-to-br from-indigo-500 to-blue-700 text-white',
  },
  {
    id: 'sess-joined-weekly',
    title: '全球开源系统工程周刊',
    initials: 'OS',
    kind: 'joined',
    peerTypeLabel: '订阅频道',
    handleOrHash: '@oss_systems_weekly',
    itemCountLabel: '2,150 篇归档',
    accentClass: 'bg-gradient-to-br from-purple-500 to-indigo-600 text-white',
  },

  // ── 第二类：只有凭据的会话 (credential_only) ──────────────────────────
  {
    id: 'sess-cred-mtproto',
    title: 'MTProto 2.0 协议深水区档案',
    initials: 'MT',
    kind: 'credential_only',
    peerTypeLabel: '受限频道',
    credentialBadge: 'access_hash 凭据',
    expiresAt: '2026-11-20 23:59',
    expiresLabel: '剩余 19 天',
    handleOrHash: 'hash:0x9f4a…c81e',
    itemCountLabel: '凭据可检 · 1,420 项',
    accentClass: 'bg-slate-800 border border-sky-400/40 text-sky-300',
  },
  {
    id: 'sess-cred-quantum',
    title: '量子晶格动力学离线快照库',
    initials: 'QL',
    kind: 'credential_only',
    peerTypeLabel: '私密归档源',
    credentialBadge: '冷备份密钥凭据',
    expiresAt: '2026-12-01 00:00',
    expiresLabel: '剩余 30 天',
    handleOrHash: 'vault:0x31b7…72d0',
    itemCountLabel: '凭据可检 · 890 项',
    accentClass: 'bg-slate-800 border border-amber-400/40 text-amber-300',
  },
  {
    id: 'sess-cred-d1',
    title: 'Cloudflare D1 边缘分布式内测',
    initials: 'CF',
    kind: 'credential_only',
    peerTypeLabel: '私密群组',
    credentialBadge: '邀请哈希凭据',
    expiresAt: '2026-11-05 18:00',
    expiresLabel: '剩余 4 天 (即将到期)',
    handleOrHash: 't.me/+7K9xP2mQ_vA',
    itemCountLabel: '凭据可检 · 640 项',
    accentClass: 'bg-slate-800 border border-rose-400/40 text-rose-300',
  },
  {
    id: 'sess-cred-webkit',
    title: 'WebKit 渲染内核未公开备忘',
    initials: 'WK',
    kind: 'credential_only',
    peerTypeLabel: '只读镜像',
    credentialBadge: '@username 公开句柄',
    expiresAt: '2027-01-01 00:00',
    expiresLabel: '剩余 61 天',
    handleOrHash: '@webkit_internals_ro',
    itemCountLabel: '凭据可检 · 2,030 项',
    accentClass: 'bg-slate-800 border border-emerald-400/40 text-emerald-300',
  },
  {
    id: 'sess-cred-zkp',
    title: '零知识证明与端到端加密信箱',
    initials: 'ZK',
    kind: 'credential_only',
    peerTypeLabel: '加密节点',
    credentialBadge: 'access_hash 凭据',
    expiresAt: '2026-11-15 12:00',
    expiresLabel: '剩余 14 天',
    handleOrHash: 'hash:0x6e08…f19a',
    itemCountLabel: '凭据可检 · 510 项',
    accentClass: 'bg-slate-800 border border-purple-400/40 text-purple-300',
  },
];

/**
 * 生成左端正方形缩略图的内联 SVG Data URL（高对比度瑞士科技几何缩略图）
 */
function createSquareThumbnailSvg(
  category: SearchPreFilterCategory,
  code: string,
  index: number,
): string {
  const palettes: Record<
    SearchPreFilterCategory,
    { bg1: string; bg2: string; accent: string; sub: string }
  > = {
    video: { bg1: '#1f1024', bg2: '#3b0a28', accent: '#f472b6', sub: '#fb7185' },
    image: { bg1: '#0c1f2e', bg2: '#0f3547', accent: '#38bdf8', sub: '#2dd4bf' },
    session: { bg1: '#0d1b38', bg2: '#172e5c', accent: '#60a5fa', sub: '#38bdf8' },
    text: { bg1: '#0c241d', bg2: '#11382d', accent: '#34d399', sub: '#a7f3d0' },
    other: { bg1: '#261a0b', bg2: '#3d280d', accent: '#fbbf24', sub: '#f59e0b' },
  };
  const p = palettes[category];
  const gridOffset = (index * 7) % 18;

  let centerGraphic = '';
  if (category === 'video') {
    centerGraphic = `<polygon points="27,21 27,43 45,32" fill="${p.accent}" opacity="0.92"/>`;
  } else if (category === 'image') {
    centerGraphic = `
      <circle cx="24" cy="24" r="4.5" fill="${p.accent}" opacity="0.85"/>
      <polygon points="14,46 27,31 36,40 43,33 52,46" fill="${p.sub}" opacity="0.75"/>
    `;
  } else if (category === 'session') {
    centerGraphic = `
      <rect x="16" y="20" width="32" height="19" rx="2" fill="none" stroke="${p.accent}" stroke-width="2.2"/>
      <line x1="22" y1="26" x2="40" y2="26" stroke="${p.sub}" stroke-width="2"/>
      <line x1="22" y1="32" x2="34" y2="32" stroke="${p.sub}" stroke-width="2" opacity="0.7"/>
    `;
  } else if (category === 'text') {
    centerGraphic = `
      <rect x="19" y="15" width="26" height="34" rx="1.5" fill="none" stroke="${p.accent}" stroke-width="2"/>
      <line x1="24" y1="23" x2="40" y2="23" stroke="${p.sub}" stroke-width="2"/>
      <line x1="24" y1="30" x2="40" y2="30" stroke="${p.sub}" stroke-width="1.8" opacity="0.8"/>
      <line x1="24" y1="37" x2="33" y2="37" stroke="${p.sub}" stroke-width="1.8" opacity="0.6"/>
    `;
  } else {
    centerGraphic = `
      <rect x="18" y="18" width="28" height="28" rx="2" fill="none" stroke="${p.accent}" stroke-width="2"/>
      <rect x="27" y="25" width="10" height="14" fill="${p.sub}" opacity="0.75"/>
    `;
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="${p.bg1}"/>
        <stop offset="100%" stop-color="${p.bg2}"/>
      </linearGradient>
    </defs>
    <rect width="64" height="64" fill="url(#g)"/>
    <line x1="0" y1="${16 + gridOffset}" x2="64" y2="${16 + gridOffset}" stroke="#ffffff" stroke-opacity="0.06" stroke-width="1"/>
    <line x1="${20 + gridOffset}" y1="0" x2="${20 + gridOffset}" y2="64" stroke="#ffffff" stroke-opacity="0.06" stroke-width="1"/>
    ${centerGraphic}
    <text x="5" y="12" fill="#ffffff" fill-opacity="0.42" font-family="monospace" font-size="7.5" font-weight="bold">${code}</text>
  </svg>`;

  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

interface RawMockSeed {
  title: string;
  category: SearchPreFilterCategory;
  fileType: FileCategory;
  extension: string;
  fileSize: string;
  snippet: string;
  sessionIndex: number;
  updatedAt: string;
  badgeMeta: string;
}

const RAW_SEEDS: RawMockSeed[] = [
  // 视频 (video)
  {
    title: 'Windows 10 Fluent 亚克力合成管线 120Hz 实测录屏',
    category: 'video',
    fileType: 'video',
    extension: 'mp4',
    fileSize: '148.6 MB',
    snippet: '展示 backdrop-blur 与 scale(0.94) 硬件加速层在桌面端的帧率稳定性分析',
    sessionIndex: 0,
    updatedAt: '2026-10-31',
    badgeMeta: '06:24',
  },
  {
    title: 'Service Worker 512KiB 分片渐进式视频流压测演示',
    category: 'video',
    fileType: 'video',
    extension: 'mp4',
    fileSize: '312.0 MB',
    snippet: '206 Partial Content 响应拦截与 24 块内存 LRU 缓冲池无缝拖动回放',
    sessionIndex: 3,
    updatedAt: '2026-10-30',
    badgeMeta: '14:08',
  },
  {
    title: 'MTProto 2.0 握手与 DH 密钥交换抓包全流程解说',
    category: 'video',
    fileType: 'video',
    extension: 'mkv',
    fileSize: '420.5 MB',
    snippet: '基于 access_hash 凭据直连测试 DC 节点的二进制帧结构逐字节拆解',
    sessionIndex: 6,
    updatedAt: '2026-10-29',
    badgeMeta: '21:15',
  },
  {
    title: 'WebKit 视口锁定与 iOS 原生手势防抖真机录像',
    category: 'video',
    fileType: 'video',
    extension: 'mov',
    fileSize: '89.2 MB',
    snippet: 'iPadOS 触控板指针吸附与双指缩放拦截在 Capacitor 容器中的实机表现',
    sessionIndex: 4,
    updatedAt: '2026-10-28',
    badgeMeta: '03:52',
  },
  {
    title: '量子晶格动力学 5000 节点实时演化 GPU 渲染导出',
    category: 'video',
    fileType: 'video',
    extension: 'webm',
    fileSize: '256.8 MB',
    snippet: '冷备份凭据归档库中的高帧率晶格振动波包传播可视化仿真视频',
    sessionIndex: 7,
    updatedAt: '2026-10-27',
    badgeMeta: '09:30',
  },

  // 图片 (image)
  {
    title: 'Swiss Tech Blue 色彩令牌与 OKLCH 阶梯全览图谱',
    category: 'image',
    fileType: 'image',
    extension: 'png',
    fileSize: '8.4 MB',
    snippet: '涵盖亮色/暗色自适应面板、发丝边框与沉浸媒体查看器深色语义令牌对照表',
    sessionIndex: 1,
    updatedAt: '2026-10-31',
    badgeMeta: '4K PNG',
  },
  {
    title: '磁贴归档 2D 网格排开与文件夹三档意图状态机架构图',
    category: 'image',
    fileType: 'image',
    extension: 'svg',
    fileSize: '1.2 MB',
    snippet: 'none -> candidate -> locked 滞回阈值与时间黏性保护窗口几何示意图',
    sessionIndex: 0,
    updatedAt: '2026-10-30',
    badgeMeta: 'VECTOR',
  },
  {
    title: 'Cloudflare Worker + D1 远端边缘鉴权拓扑白皮书配图',
    category: 'image',
    fileType: 'image',
    extension: 'webp',
    fileSize: '4.7 MB',
    snippet: 'PBKDF2 25000 次派生、Turnstile 校验与 SHA-256 会话摘要隔离链路图',
    sessionIndex: 8,
    updatedAt: '2026-10-29',
    badgeMeta: '3840×2160',
  },
  {
    title: 'WebKit RenderLayer 合成树与隐式层爆炸诊断截图',
    category: 'image',
    fileType: 'image',
    extension: 'png',
    fileSize: '6.1 MB',
    snippet: 'Safari 开发者工具 Compositing Borders 下亚克力弹窗零重排图层分布',
    sessionIndex: 9,
    updatedAt: '2026-10-28',
    badgeMeta: 'RETINA',
  },
  {
    title: '深空暗色桌面壁纸原片 · 东京霓虹雨夜高动态裁切版',
    category: 'image',
    fileType: 'image',
    extension: 'jpg',
    fileSize: '14.3 MB',
    snippet: '适用于开始屏幕磁贴背景的 16:10 高清无模糊底层壁纸素材',
    sessionIndex: 1,
    updatedAt: '2026-10-26',
    badgeMeta: '5120×3200',
  },

  // 会话 (session)
  {
    title: '关于「视图层零本地 ref 铁律」与 Pinia 三层架构的深度讨论串',
    category: 'session',
    fileType: 'doc',
    extension: 'chat',
    fileSize: '186 条消息',
    snippet: '汇总 Data Source 单例持有 DOM 句柄、Store 管理页面交互态的最佳实践决议',
    sessionIndex: 0,
    updatedAt: '2026-10-31',
    badgeMeta: '186 MSG',
  },
  {
    title: 'GramJS 本地 Web Worker 多标签页 BroadcastChannel 桥接纪要',
    category: 'session',
    fileType: 'doc',
    extension: 'chat',
    fileSize: '342 条消息',
    snippet: '主标签页直连 Telegram DC、从标签页共享单连接与实时 chatUpdates 广播实录',
    sessionIndex: 6,
    updatedAt: '2026-10-30',
    badgeMeta: '342 MSG',
  },
  {
    title: 'Rust WebAssembly 音频指纹提取与本地索引加速专题讨论',
    category: 'session',
    fileType: 'doc',
    extension: 'chat',
    fileSize: '215 条消息',
    snippet: 'SIMD 指令集优化下百万级归档条目毫秒级模糊检索的基准测试对话',
    sessionIndex: 2,
    updatedAt: '2026-10-29',
    badgeMeta: '215 MSG',
  },
  {
    title: '零知识证明会话凭据离线校验与匿名归档交换协议研讨',
    category: 'session',
    fileType: 'doc',
    extension: 'chat',
    fileSize: '94 条消息',
    snippet: '在未加入目标群组的前提下仅凭受限 access_hash 安全读取公开历史快照',
    sessionIndex: 10,
    updatedAt: '2026-10-28',
    badgeMeta: '94 MSG',
  },
  {
    title: 'Electron better-sqlite3 原生模块跨平台签名与 CI 打包排障记录',
    category: 'session',
    fileType: 'doc',
    extension: 'chat',
    fileSize: '128 条消息',
    snippet: 'macOS 公证、Windows 驱动级体积裁剪与 iOS SPM 离线构建完整对话归档',
    sessionIndex: 4,
    updatedAt: '2026-10-27',
    badgeMeta: '128 MSG',
  },

  // 文本文件 (text)
  {
    title: 'frontend-architecture-v2.md · 前端无突变折叠与分栏设计规范',
    category: 'text',
    fileType: 'doc',
    extension: 'md',
    fileSize: '42.8 KB',
    snippet: '详述侧边栏与三栏弹窗在展开/折叠时保持 DOM 树 100% 恒定的 CSS 实现细则',
    sessionIndex: 0,
    updatedAt: '2026-10-31',
    badgeMeta: 'MD',
  },
  {
    title: 'progressiveStream.ts · 渐进式流媒体分块调度器核心源码',
    category: 'text',
    fileType: 'code',
    extension: 'ts',
    fileSize: '18.6 KB',
    snippet: '512KiB 对齐分片计算、前 2MiB 设备密钥 AES-GCM 加密落盘与 AbortSignal 回收',
    sessionIndex: 3,
    updatedAt: '2026-10-30',
    badgeMeta: 'TS',
  },
  {
    title: '0002_init_tg_binding_schema.sql · D1 数据库迁移与索引脚本',
    category: 'text',
    fileType: 'code',
    extension: 'sql',
    fileSize: '11.2 KB',
    snippet: '定义远端用户绑定表、严格外键级联清理与高频查询复合索引结构',
    sessionIndex: 8,
    updatedAt: '2026-10-29',
    badgeMeta: 'SQL',
  },
  {
    title: 'WebKit 硬件加速合成层内存预算与 Backdrop-Filter 性能白皮书',
    category: 'text',
    fileType: 'pdf',
    extension: 'pdf',
    fileSize: '5.6 MB',
    snippet: '剖析高斯模糊采样半径、离屏纹理尺寸与 GPU 显存带宽占用的定量关系',
    sessionIndex: 9,
    updatedAt: '2026-10-28',
    badgeMeta: 'PDF',
  },
  {
    title: 'clash-verge-enterprise-rules.yaml · 多节点分流与低延迟路由表',
    category: 'text',
    fileType: 'text',
    extension: 'yaml',
    fileSize: '64.0 KB',
    snippet: '针对 Telegram DC1~DC5 及 Cloudflare Worker 边缘节点的专线规则配置',
    sessionIndex: 5,
    updatedAt: '2026-10-26',
    badgeMeta: 'YAML',
  },

  // 其他 (other)
  {
    title: 'lattice_cold_snapshot_2026Q4.vault · 加密冷启动快照归档包',
    category: 'other',
    fileType: 'archive',
    extension: 'vault',
    fileSize: '64.5 MB',
    snippet: 'AES-GCM-256 封装的会话窗口、置顶顺序与凭据哈希离线恢复归档包',
    sessionIndex: 7,
    updatedAt: '2026-10-31',
    badgeMeta: 'VAULT',
  },
  {
    title: 'everything_ntfs_mft_index.db · 全盘文件名倒排索引数据库',
    category: 'other',
    fileType: 'data',
    extension: 'db',
    fileSize: '112.4 MB',
    snippet: '包含 180 万条本地归档文件路径、扩展名与 SHA-256 校验和的极速检索库',
    sessionIndex: 2,
    updatedAt: '2026-10-30',
    badgeMeta: 'SQLITE',
  },
  {
    title: 'mtproto_tl_schema_layer198.bin · 二进制协议类型定义快照',
    category: 'other',
    fileType: 'data',
    extension: 'bin',
    fileSize: '3.8 MB',
    snippet: 'TL 构造器 CRC32 校验码映射表与预编译序列化字节码字典',
    sessionIndex: 6,
    updatedAt: '2026-10-29',
    badgeMeta: 'BIN',
  },
  {
    title: 'ambient_deep_focus_synth.flac · 瑞士实验室环境白噪音无损工程',
    category: 'other',
    fileType: 'audio',
    extension: 'flac',
    fileSize: '48.9 MB',
    snippet: '24bit/96kHz 沉浸式低频合成器环境音，适配长时间代码审阅与归档整理',
    sessionIndex: 1,
    updatedAt: '2026-10-28',
    badgeMeta: 'FLAC',
  },
  {
    title: 'zk_snark_verifier_wasm_simd.wasm · 零知识证明验证器预编译模块',
    category: 'other',
    fileType: 'exec',
    extension: 'wasm',
    fileSize: '9.4 MB',
    snippet: '可在浏览器 Worker 线程内独立验证凭据有效性的 WebAssembly 二进制模块',
    sessionIndex: 10,
    updatedAt: '2026-10-27',
    badgeMeta: 'WASM',
  },
];

const CATEGORY_LABEL_MAP: Record<SearchPreFilterCategory, string> = {
  video: '视频',
  image: '图片',
  session: '会话',
  text: '文本文件',
  other: '其他',
};

/**
 * 构建支持 3 页以上懒加载的 75 条完整拟真搜索结果池
 */
function buildMockSearchResultsPool(): AggregateSearchResultItem[] {
  const results: AggregateSearchResultItem[] = [];
  const totalBatches = 3; // 3 * 25 = 75 条结果，充分覆盖流式加载 + 多次触底懒加载

  for (let batch = 0; batch < totalBatches; batch++) {
    RAW_SEEDS.forEach((seed, idx) => {
      const globalIdx = batch * RAW_SEEDS.length + idx;
      const session =
        MOCK_SCOPE_SESSIONS[(seed.sessionIndex + batch) % MOCK_SCOPE_SESSIONS.length]!;
      const versionSuffix = batch === 0 ? '' : ` · 归档卷 #${batch + 1}`;

      results.push({
        id: `agg-res-${globalIdx + 1}`,
        title: `${seed.title}${versionSuffix}`,
        category: seed.category,
        categoryLabel: CATEGORY_LABEL_MAP[seed.category],
        fileType: seed.fileType,
        extension: seed.extension,
        fileSize: seed.fileSize,
        snippet: seed.snippet,
        sessionId: session.id,
        sessionTitle: session.title,
        sessionKind: session.kind,
        updatedAt: seed.updatedAt,
        badgeMeta: seed.badgeMeta,
        thumbnailUrl: createSquareThumbnailSvg(
          seed.category,
          seed.extension.toUpperCase().slice(0, 4),
          globalIdx,
        ),
      });
    });
  }

  return results;
}

export const MOCK_SEARCH_RESULTS_POOL: AggregateSearchResultItem[] =
  buildMockSearchResultsPool();
