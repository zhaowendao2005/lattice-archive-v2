#!/usr/bin/env node
/**
 * 跨平台策略（macOS / Windows）—— 仓库里唯一做「按系统决策」的地方。
 *
 * 背景：pnpm >= 10 默认不执行依赖的安装脚本，未放行的包会让整次
 * `pnpm install` 以 ERR_PNPM_IGNORED_BUILDS 失败（根 postinstall 会连带失败）。
 * 放行清单在 electron/pnpm-workspace.yaml，由本脚本生成，并由根 preinstall 自动执行。
 *
 * 命令：
 *   node scripts/platform.mjs info            当前系统解析出的策略
 *   node scripts/platform.mjs doctor          环境自检（换机器 / 系统升级后先跑它）
 *   node scripts/platform.mjs pack [--target=mac|win|linux] [--arch=arm64|x64|universal]
 *                                  [--publish=never|always] [--skip-web] [--skip-sync] [--dry-run]
 *   node scripts/platform.mjs sync-policy     重新生成放行清单（preinstall 用）
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ELECTRON = path.join(ROOT, 'electron');
const WORKSPACE_FILE = path.join(ELECTRON, 'pnpm-workspace.yaml');
const CAPACITOR_ELECTRON_CLI = path.join(ROOT, 'node_modules/@capawesome/capacitor-electron/dist/cli/index.js');
const ELECTRON_BUILDER_CLI = path.join(ELECTRON, 'node_modules/electron-builder/cli.js');

/**
 * 允许执行安装脚本的依赖。
 * 之所以是「全平台放行」而不是按系统切换：pnpm 在启动时就加载 pnpm-workspace.yaml、
 * 之后才跑 preinstall，脚本无法为本次安装切换配置；而仓库只能提交一份文件。
 * 这些包的脚本目前都只是按宿主架构拷贝二进制（纯 copyFile，无编译），两端都安全。
 * ⚠️ 新增依赖前请确认「全平台安全」，否则需改为按平台生成且不再提交该文件。
 */
const SAFE_BUILD_SCRIPTS = ['electron-winstaller'];

const FAMILY_OF = { darwin: 'mac', mac: 'mac', win32: 'win', win: 'win', linux: 'linux' };
const LABEL = { mac: 'macOS', win: 'Windows', linux: 'Linux' };
const PACK_MATRIX = {
  mac: { flag: '--mac', targets: ['dmg', 'zip'], arch: { arm64: '--arm64', x64: '--x64', universal: '--universal' } },
  win: { flag: '--win', targets: ['nsis', 'portable'], arch: { arm64: '--arm64', x64: '--x64' } },
  linux: { flag: '--linux', targets: ['AppImage', 'deb'], arch: { arm64: '--arm64', x64: '--x64' } },
};

const C = process.stdout.isTTY
  ? { ok: '\u001b[32m', warn: '\u001b[33m', err: '\u001b[31m', dim: '\u001b[2m', bold: '\u001b[1m', reset: '\u001b[0m' }
  : { ok: '', warn: '', err: '', dim: '', bold: '', reset: '' };

/* ---------------------------------- 工具 ---------------------------------- */

function familyOf(target = process.platform) {
  const family = FAMILY_OF[target];
  if (!family) throw new Error(`不支持的平台: ${target}（仅支持 darwin|mac / win32|win / linux）`);
  return family;
}

/** 运行子进程：统一打印命令、Windows 下走 shell，失败即抛错 */
function run(command, args, { cwd = ROOT, dryRun = false } = {}) {
  const label = `[${path.relative(ROOT, cwd) || '.'}] ${path.basename(command)} ${args.join(' ')}`;
  if (dryRun) return console.log(`${C.dim}→ ${label}${C.reset}`);
  console.log(`\n${C.bold}→ ${label}${C.reset}`);
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw Object.assign(new Error(`命令失败（退出码 ${result.status}）：${label}`), { exitCode: result.status ?? 1 });
}

function toolVersion(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', shell: process.platform === 'win32' });
  return result.error || result.status !== 0 ? null : (result.stdout || '').trim().split(/\r?\n/)[0];
}

/** 读取 electron/ 下已安装依赖的 package.json */
function readInstalled(packageName, base = ELECTRON) {
  const direct = path.join(base, 'node_modules', packageName, 'package.json');
  if (fs.existsSync(direct)) return { dir: path.dirname(direct), json: JSON.parse(fs.readFileSync(direct, 'utf8')) };
  const store = path.join(base, 'node_modules/.pnpm');
  const entry = fs.existsSync(store)
    ? fs
        .readdirSync(store)
        .find((name) => name.startsWith(`${packageName.replace('/', '+')}@`))
    : null;
  const nested = entry && path.join(store, entry, 'node_modules', packageName, 'package.json');
  return nested && fs.existsSync(nested) ? { dir: path.dirname(nested), json: JSON.parse(fs.readFileSync(nested, 'utf8')) } : null;
}

/** 按显示宽度补齐（CJK 占 2 列），保证自检表格对齐 */
function pad(text, width) {
  let used = 0;
  for (const char of text) used += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(char) ? 2 : 1;
  return text + ' '.repeat(Math.max(0, width - used));
}

/* ------------------------------ 安装脚本放行 ------------------------------ */

const WORKSPACE_HEADER = `# ⚠️ 由 scripts/platform.mjs 生成，请勿手工编辑（改策略改 SAFE_BUILD_SCRIPTS 后重跑）。
# pnpm >= 10 默认不执行依赖的安装脚本；这里声明允许执行的依赖，
# 缺省或写成非布尔值会让 \`pnpm install\` 以 ERR_PNPM_IGNORED_BUILDS 失败。
`;

const renderWorkspace = () => `${WORKSPACE_HEADER}allowBuilds:\n${SAFE_BUILD_SCRIPTS.map((name) => `  ${name}: true`).join('\n')}\n`;

/** 生成/校正 electron/pnpm-workspace.yaml（幂等） */
function syncPolicy() {
  const expected = renderWorkspace();
  const changed = !fs.existsSync(WORKSPACE_FILE) || fs.readFileSync(WORKSPACE_FILE, 'utf8') !== expected;
  if (changed) fs.writeFileSync(WORKSPACE_FILE, expected);
  console.log(`${C.ok}✓${C.reset} ${path.relative(ROOT, WORKSPACE_FILE)} ${changed ? '已更新' : '已是最新'}`);
  return changed;
}

/** 校验放行清单：每个值必须是 true/false，且覆盖所有已知包 */
function checkPolicy() {
  if (!fs.existsSync(WORKSPACE_FILE)) return `缺失 ${path.relative(ROOT, WORKSPACE_FILE)}，执行 node scripts/platform.mjs sync-policy`;
  const declared = {};
  for (const line of fs.readFileSync(WORKSPACE_FILE, 'utf8').split(/\r?\n/)) {
    const match = /^ {2}([^:#\s]+):\s*(.+)$/.exec(line);
    if (match) declared[match[1]] = match[2].trim();
  }
  for (const [name, value] of Object.entries(declared)) {
    if (value !== 'true' && value !== 'false') return `${name} 的值不是布尔：${value}`;
  }
  const missing = SAFE_BUILD_SCRIPTS.filter((name) => !(name in declared));
  return missing.length ? `未声明 allowBuilds.${missing.join(', ')}` : null;
}

/* ------------------------------ better-sqlite3 ---------------------------- */

/**
 * 是否需要针对 Electron ABI 重编译。
 * >= 13 改为 Node-API 预编译产物（prebuilds/<platform>-<arch>.node），与 Electron ABI 无关，无需重编译。
 */
function sqliteInfo(arch = process.arch) {
  const pkg = readInstalled('better-sqlite3');
  if (!pkg) return { version: null, needsRebuild: false, reason: 'electron/ 尚未安装更好的 sqlite（先 pnpm install）' };
  const { version } = pkg.json;
  const runtime = process.platform === 'linux' && !process.report?.getReport?.().header?.glibcVersionRuntime ? 'linuxmusl' : process.platform;
  const prebuild = path.join(pkg.dir, 'prebuilds', `${runtime}-${arch}.node`);
  const hasPrebuild = fs.existsSync(prebuild);
  const napi = Number.parseInt(version, 10) >= 13;
  const needsRebuild = !(napi && hasPrebuild);
  return {
    version,
    needsRebuild,
    reason: needsRebuild
      ? `缺少 ${runtime}-${arch} 的 Node-API 预编译产物，需重编译`
      : `自带 Node-API 预编译产物（${runtime}-${arch}），Electron 可直接加载`,
  };
}

/* ---------------------------------- 打包 ---------------------------------- */

function packPlan({ target = process.platform, arch = process.arch, publish = 'never' } = {}) {
  const family = familyOf(target);
  const matrix = PACK_MATRIX[family];
  if (!matrix.arch[arch]) {
    throw new Error(`${LABEL[family]} 不支持架构 ${arch}（可用：${Object.keys(matrix.arch).join(' / ')}）`);
  }
  const crossCompiling = family !== familyOf(process.platform);
  return {
    family,
    label: LABEL[family],
    targets: matrix.targets,
    arch,
    args: [matrix.flag, ...matrix.targets, matrix.arch[arch], '--publish', publish],
    note: !crossCompiling
      ? null
      : family === 'win'
        ? '交叉打 Windows 包需要 wine；签名建议在 Windows 机器上做'
        : family === 'mac'
          ? 'Windows / Linux 无法交叉打 macOS 包（签名与公证依赖 macOS）'
          : '交叉打 Linux 包通常需要 Docker 或 fpm',
  };
}

/* ---------------------------------- 命令 ---------------------------------- */

function commandInfo() {
  const family = familyOf();
  const sqlite = sqliteInfo();
  const plan = packPlan({ target: process.platform, arch: process.arch });

  console.log(`${C.bold}宿主${C.reset}        ${LABEL[family]} (${process.platform}) · ${process.arch}${family === 'mac' && process.arch === 'arm64' ? ' · Apple Silicon' : ''}`);
  console.log(`${C.bold}放行脚本${C.reset}    ${SAFE_BUILD_SCRIPTS.join(', ')}  ${C.dim}${path.relative(ROOT, WORKSPACE_FILE)}${C.reset}`);
  console.log(`${C.bold}better-sqlite3${C.reset}  ${sqlite.version ?? '未安装'}  ${C.dim}${sqlite.reason}${C.reset}`);
  console.log(`${C.bold}本机打包${C.reset}    electron-builder ${plan.args.join(' ')}`);
  console.log(`${C.bold}打包产物${C.reset}    electron/dist`);
}

function commandDoctor() {
  const checks = [];
  const add = (level, name, detail) => checks.push({ level, name, detail });
  const family = familyOf();

  const nodeMajor = Number.parseInt(process.versions.node, 10);
  add(nodeMajor >= 22 ? 'ok' : 'err', `Node.js ${process.version}`, 'better-sqlite3 要求 >= 22');

  const pnpmVersion = toolVersion('pnpm', ['-v']);
  add(pnpmVersion && Number.parseInt(pnpmVersion, 10) >= 10 ? 'ok' : 'err', `pnpm ${pnpmVersion ?? '未安装'}`, '>= 10 起需显式放行依赖脚本');

  const policyProblem = checkPolicy();
  add(policyProblem ? 'err' : 'ok', 'electron/pnpm-workspace.yaml', policyProblem ?? SAFE_BUILD_SCRIPTS.join(', '));

  const electron = readInstalled('electron');
  if (!electron) add('err', 'electron', '未安装，先 pnpm install');
  else {
    const hasBinary = fs.existsSync(path.join(electron.dir, 'dist'));
    add(hasBinary ? 'ok' : 'warn', `electron ${electron.json.version}`, hasBinary ? '二进制已就绪' : '二进制未下载（首次运行时自动下载）');
  }

  const sqlite = sqliteInfo();
  if (!sqlite.version) add('err', 'better-sqlite3', sqlite.reason);
  else {
    const probe = spawnSync(
      process.execPath,
      ['-e', "const db=require('better-sqlite3');console.log(new db(':memory:').prepare('select sqlite_version() v').get().v)"],
      { cwd: ELECTRON, encoding: 'utf8' },
    );
    add(
      probe.status === 0 ? 'ok' : 'err',
      `better-sqlite3 ${sqlite.version}`,
      probe.status === 0 ? `加载正常（SQLite ${probe.stdout.trim()}）` : (probe.stderr || '').trim().split('\n')[0],
    );
    if (sqlite.needsRebuild) add('warn', 'better-sqlite3 ABI', `${sqlite.reason} → pnpm electron:rebuild-sqlite`);
  }

  // 仅在需要本地编译原生模块时才是硬性要求，因此只给 warn
  const toolchain = family === 'mac' ? toolVersion('xcode-select', ['-p']) : family === 'win' ? toolVersion('where', ['cl.exe']) : toolVersion('g++', ['--version']);
  add(toolchain ? 'ok' : 'warn', family === 'mac' ? 'Xcode CLT' : family === 'win' ? 'MSVC' : 'g++', toolchain ?? '未检测到（仅编译原生模块时必需）');

  add(fs.existsSync(ELECTRON_BUILDER_CLI) ? 'ok' : 'err', 'electron-builder', fs.existsSync(ELECTRON_BUILDER_CLI) ? '已就绪' : '未安装');
  add(fs.existsSync(CAPACITOR_ELECTRON_CLI) ? 'ok' : 'err', '@capawesome/capacitor-electron', fs.existsSync(CAPACITOR_ELECTRON_CLI) ? '已就绪' : '未安装');

  console.log(`${C.bold}环境自检 · ${LABEL[family]} ${process.arch}${C.reset}\n`);
  const icon = { ok: `${C.ok}✓${C.reset}`, warn: `${C.warn}!${C.reset}`, err: `${C.err}✗${C.reset}` };
  for (const check of checks) console.log(`  ${icon[check.level]} ${pad(check.name, 30)} ${C.dim}${check.detail ?? ''}${C.reset}`);

  const failed = checks.filter((check) => check.level === 'err').length;
  console.log('');
  if (failed) {
    console.error(`${C.err}${failed} 项未通过${C.reset}`);
    process.exit(1);
  }
  console.log(`${C.ok}全部通过${C.reset}`);
}

function commandPack(flags) {
  const plan = packPlan({
    target: typeof flags.target === 'string' ? flags.target : process.platform,
    arch: typeof flags.arch === 'string' ? flags.arch : process.arch,
    publish: typeof flags.publish === 'string' ? flags.publish : 'never',
  });
  const dryRun = Boolean(flags['dry-run']);

  console.log(`${C.bold}打包计划${C.reset}  ${plan.label} · ${plan.arch} · ${plan.targets.join(' / ')}`);
  console.log(`  electron-builder ${plan.args.join(' ')}`);
  if (plan.note) console.log(`  ${C.warn}!${C.reset} ${plan.note}`);

  if (!flags['skip-web']) run('pnpm', ['run', 'build'], { dryRun });
  if (!flags['skip-sync']) run('pnpm', ['run', 'cap:sync'], { dryRun });
  run('pnpm', ['run', 'build'], { cwd: ELECTRON, dryRun });
  run(process.execPath, [CAPACITOR_ELECTRON_CLI, 'vendor'], { cwd: ELECTRON, dryRun });
  run(process.execPath, [ELECTRON_BUILDER_CLI, '--config', 'electron-builder.config.js', ...plan.args], { cwd: ELECTRON, dryRun });
  if (!dryRun) console.log(`\n${C.ok}✓ 打包完成${C.reset} 产物在 electron/dist`);
}

/* ---------------------------------- 入口 ---------------------------------- */

const { command = 'info', flags } = process.argv.slice(2).reduce(
  (acc, arg) => {
    if (arg.startsWith('--')) {
      const [key, value] = arg.slice(2).split('=');
      acc.flags[key] = value ?? true;
    } else acc.command = arg;
    return acc;
  },
  { command: 'info', flags: {} },
);

try {
  if (command === 'info') commandInfo();
  else if (command === 'doctor') commandDoctor();
  else if (command === 'pack') commandPack(flags);
  else if (command === 'sync-policy') syncPolicy();
  else {
    console.error(`未知命令: ${command}（可用：info / doctor / pack / sync-policy）`);
    process.exit(1);
  }
} catch (error) {
  console.error(`${C.err}✗ ${error.message}${C.reset}`);
  process.exit(error.exitCode ?? 1);
}
