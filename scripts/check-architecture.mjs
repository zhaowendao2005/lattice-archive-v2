#!/usr/bin/env node
/**
 * 架构边界检查（零依赖，纳入 pnpm build）。
 *
 * 为什么不是只靠 TypeScript：tsc / vue-tsc 只保证类型正确，不会阻止「Store 直接触达 GramJS」
 * 「视图声明本地 ref」「业务代码硬编码并发」这类架构违规。本脚本把 AGENTS.md / .rules 与
 * docs/research/gramjs-business-bus-rearchitecture.md 中可静态判定的约束变成构建门禁。
 *
 * 遗留豁免（LEGACY）只允许减少：豁免文件不再违规时脚本会报错，提示删除该豁免（棘轮）。
 *
 * 用法：node scripts/check-architecture.mjs
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative, sep } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(ROOT, 'src');
const CODE_EXT = /\.(ts|vue|mts|js|mjs)$/;

/** 遗留豁免：规则 id → 文件 → 原因。迁移完成后必须删除对应条目。 */
const LEGACY = {
  'main-thread-worker-imports': {
  },
};

/** 主线程允许引用的 local Worker 模块：纯类型契约与纯函数。 */
const WORKER_IMPORT_ALLOW = [
  /^@\/worker\/local\/archive\/(searchContracts|searchModel)$/,
  /^@\/worker\/local\/protocol$/,
  /^@\/worker\/local\/chatProtocol$/,
  /^@\/worker\/local\/chat\/telegramErrors$/,
  /^@\/worker\/local\/telegram\/contracts\/[\w-]+$/,
];

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (CODE_EXT.test(name)) out.push(full);
  }
  return out;
}

/** 去掉注释，避免文档里出现的示例代码被误判；保留换行以便报告行号。 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length))
    .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));
}

function lineOf(source, index) {
  return source.slice(0, index).split('\n').length;
}

const toPosix = (p) => p.split(sep).join('/');

/** 每条规则：applies(file) 决定检查范围，find(code, file) 返回违规 [{ index, text }]。 */
const RULES = [
  {
    id: 'no-services-layer',
    message: '禁止新建顶层 src/services/（业务实现放 src/worker/local 或 src/worker/remote）',
    applies: (f) => f.startsWith('src/services/'),
    find: () => [{ index: 0, text: 'src/services/' }],
  },
  {
    id: 'gramjs-import-boundary',
    message: 'GramJS（telegram 包）只能在 src/worker/local/telegram/（运行时、总线、转换器）内引用',
    applies: (f) => !f.startsWith('src/worker/local/telegram/'),
    pattern: /from\s+['"]telegram(\/[^'"]*)?['"]/g,
  },
  {
    id: 'gramjs-rpc-boundary',
    message: 'Telegram RPC / 文件下载只能出现在 src/worker/local/telegram/runtime/ 或 buses/',
    applies: (f) => !/^src\/worker\/local\/telegram\/(runtime|buses)\//.test(f) && !f.startsWith('src/worker/remote/'),
    pattern: /\.(invoke|invokeWithSender|downloadFile|iterDownload)\s*\(/g,
  },
  {
    id: 'views-zero-ref',
    message: '视图层禁止本地 ref / reactive（状态进 Store，DOM 句柄进 Data Source）',
    applies: (f) => f.startsWith('src/views/'),
    pattern: /\b(ref|reactive|shallowRef|shallowReactive)\s*(<[^>]*>)?\s*\(/g,
  },
  {
    id: 'views-no-network',
    message: '视图层禁止直接发起网络请求或调用 MTProto Bridge',
    applies: (f) => f.startsWith('src/views/'),
    pattern: /\bfetch\s*\(|mtprotoHub|requestChat\s*\(|telegramBusClient|mtprotoBridge/g,
  },
  {
    id: 'main-thread-worker-imports',
    message: '主线程只能引用 local Worker 的协议 / 契约 / 纯函数模块（允许列表见脚本）',
    applies: (f) => f.startsWith('src/stores/') || f.startsWith('src/views/') || f.startsWith('src/router/'),
    find: (code) => {
      const hits = [];
      for (const m of code.matchAll(/from\s+['"](@\/worker\/local\/[^'"]+)['"]/g)) {
        if (!WORKER_IMPORT_ALLOW.some((re) => re.test(m[1]))) hits.push({ index: m.index, text: m[1] });
      }
      return hits;
    },
  },
  {
    id: 'no-hardcoded-concurrency',
    message: '并发预算必须来自 src/worker/local/telegram/contracts/concurrency.ts，禁止硬编码并发常量或自建并发池',
    applies: (f) => (f.startsWith('src/worker/local/') || /^src\/stores\/[^/]+\/data-sources\//.test(f)) && f !== 'src/worker/local/telegram/contracts/concurrency.ts',
    pattern: /\b[A-Z_]*(CONCURREN|PARALLEL)[A-Z_]*\s*(:[^=]+)?=\s*(\d|\{)|new\s+Pool\s*\(/g,
  },
  {
    id: 'legacy-protocol',
    message: '旧 TgChatRequest 字符串分发协议已删除，禁止复活（新代码走 TelegramBusClient → BusRouter）',
    applies: () => true,
    pattern: /\b(TgChatRequest|TgChatResponseMap|TgChatMethod|requestChat|runChatRequest|dispatchChatRequest|chatDataSource)\b|['"]chat(Request|Cancel|Response|Progress)['"]/g,
  },
  {
    id: 'bus-client-entry',
    message: '主线程只能经 telegramBusClient 发起总线请求，禁止在 Store / 视图中直接调用 requestBus',
    applies: (f) => !['src/stores/telegram/data-sources/telegramBusClient.ts', 'src/stores/telegram/data-sources/mtprotoBridge.ts'].includes(f),
    pattern: /\.requestBus\s*\(/g,
  },
  {
    id: 'worker-no-main-stores',
    message: 'local Telegram Worker 不得反向依赖主线程 Store',
    applies: (f) => f.startsWith('src/worker/local/telegram/'),
    pattern: /from\s+['"]@\/stores\//g,
  },
  {
    id: 'telegram-client-construction',
    message: 'TelegramClient 只能由 Telegram runtime 与 PendingSlot 会话总线创建',
    applies: (f) => f.startsWith('src/worker/local/') && !['src/worker/local/telegram/runtime/telegramRuntime.ts', 'src/worker/local/telegram/buses/accountSessionBus.ts'].includes(f),
    pattern: /new\s+TelegramClient\s*\(/g,
  },
  {
    id: 'telegram-bus-implementation-routing',
    message: '业务 bus 实现必须由 runtime/busRouter.ts 显式路由',
    applies: (f) => f.startsWith('src/worker/local/telegram/buses/') && !/(Parser|parser)\.ts$/.test(f),
    find: (_code, file) => {
      const router = readFileSync(join(ROOT, 'src/worker/local/telegram/runtime/busRouter.ts'), 'utf8');
      const name = file.split('/').pop()?.replace(/\.ts$/, '');
      return name && !router.includes(`from '../buses/${name}'`)
        ? [{ index: 0, text: `${name} is not routed` }]
        : [];
    },
  },
  {
    id: 'bus-api-types',
    message: '业务总线契约与主线程不得暴露 GramJS Api.* 类型',
    applies: (f) => f.startsWith('src/worker/local/telegram/contracts/') || f.startsWith('src/stores/') || f.startsWith('src/views/'),
    pattern: /\bApi\.[A-Z]\w*/g,
  },
];

const files = walk(SRC).map((full) => ({ full, rel: toPosix(relative(ROOT, full)) }));
const errors = [];
const staleLegacy = [];

for (const rule of RULES) {
  const legacy = LEGACY[rule.id] ?? {};
  const legacyHit = new Set();
  for (const { full, rel } of files) {
    if (!rule.applies(rel)) continue;
    const code = stripComments(readFileSync(full, 'utf8'));
    const hits = rule.find
      ? rule.find(code, rel)
      : [...code.matchAll(rule.pattern)].map((m) => ({ index: m.index, text: m[0] }));
    if (hits.length === 0) continue;
    if (legacy[rel]) { legacyHit.add(rel); continue; }
    for (const hit of hits) errors.push(`[${rule.id}] ${rel}:${lineOf(code, hit.index)} \`${hit.text.trim()}\` — ${rule.message}`);
  }
  for (const rel of Object.keys(legacy)) {
    if (!legacyHit.has(rel)) staleLegacy.push(`[${rule.id}] ${rel} 已不再违规，请从 scripts/check-architecture.mjs 的 LEGACY 中删除该豁免`);
  }
}

const legacyCount = Object.values(LEGACY).reduce((sum, entries) => sum + Object.keys(entries).length, 0);
if (errors.length || staleLegacy.length) {
  console.error(`✖ 架构检查失败（${errors.length} 处违规，${staleLegacy.length} 条过期豁免）\n`);
  for (const line of [...errors, ...staleLegacy]) console.error(`  ${line}`);
  process.exit(1);
}
console.log(`✓ 架构检查通过（${RULES.length} 条规则，${files.length} 个文件，遗留豁免 ${legacyCount} 条）`);
