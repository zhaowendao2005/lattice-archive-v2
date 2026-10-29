#!/usr/bin/env node
/**
 * 一键部署：构建前端 → 处理远端 D1 → 部署 Worker（静态资源 + API）。
 *
 * 用法：
 *   pnpm deploy                  # 按 deploy.config.json 的 d1Mode 执行
 *   pnpm deploy:rebuild          # 强制重建模式
 *   pnpm deploy:migrate          # 强制迁移模式
 *   node scripts/deploy.mjs --mode=rebuild --dry-run
 *
 * 模式：
 *   rebuild —— 删除远端 D1 并按迁移模板重建（不保留数据，database_id 会变，脚本自动回写配置）
 *   migrate —— 传统迁移模式，保留数据，只执行未应用的迁移
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEV_VARS_PATH, readDevVars, seedAdmin } from './seed-admin.mjs';

const root = path.resolve(import.meta.dirname, '..');
const configPath = path.join(root, 'deploy.config.json');
const wranglerConfig = 'src/worker/remote/wrangler.jsonc';
const wranglerConfigPath = path.join(root, wranglerConfig);

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const modeArg = argv.find((arg) => arg.startsWith('--mode='))?.slice('--mode='.length);

let fileConfig = {};
try {
  fileConfig = JSON.parse(readFileSync(configPath, 'utf8'));
} catch {
  console.warn(`! 未读取到 ${configPath}，使用默认配置`);
}

const mode = modeArg || process.env.D1_MODE || fileConfig.d1Mode || 'migrate';
const dbName = process.env.D1_DATABASE || fileConfig.databaseName || 'lattice-v2-d1';
const location = fileConfig.rebuildLocation || 'apac';
const wrangler = process.env.WRANGLER_BIN || 'wrangler';
const baseArgs = ['--config', wranglerConfig];

if (!['rebuild', 'migrate'].includes(mode)) {
  console.error(`✘ 未知的 D1 模式: ${mode}（可选 rebuild / migrate）`);
  process.exit(1);
}

function run(command, args, { capture = false, allowFailure = false } = {}) {
  console.log(`\n$ ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    env: { ...process.env, CI: process.env.CI ?? 'true' },
  });
  if (result.status !== 0 && !allowFailure) {
    if (capture) process.stderr.write(result.stdout ?? '');
    if (capture) process.stderr.write(result.stderr ?? '');
    console.error(`\n✘ 命令失败（退出码 ${result.status}）`);
    process.exit(result.status ?? 1);
  }
  return (result.stdout ?? '') + (result.stderr ?? '');
}

function readDatabaseId() {
  const match = readFileSync(wranglerConfigPath, 'utf8').match(/"database_id":\s*"([^"]+)"/);
  return match?.[1] ?? null;
}

function writeDatabaseId(databaseId) {
  const source = readFileSync(wranglerConfigPath, 'utf8');
  const updated = source.replace(/"database_id":\s*"[^"]+"/g, `"database_id": "${databaseId}"`);
  writeFileSync(wranglerConfigPath, updated);
}

console.log(`\n▸ D1 模式: ${mode}${dryRun ? '（dry-run，不执行破坏性操作）' : ''}`);
console.log(`▸ 数据库: ${dbName}`);

// 1. 始终先构建，避免部署到旧产物
run('pnpm', ['build']);

// 2. 处理远端数据库
if (mode === 'rebuild') {
  const oldId = readDatabaseId();
  console.log(`\n⚠ 重建模式会永久删除 ${dbName} 及其全部数据（当前 database_id: ${oldId ?? '未知'}）。`);
  if (dryRun) {
    console.log('↷ dry-run: 跳过删除、重建与迁移');
  } else {
    run(wrangler, ['d1', 'delete', dbName, ...baseArgs, '-y'], { allowFailure: true });
    const output = run(wrangler, ['d1', 'create', dbName, '--location', location, ...baseArgs], { capture: true });
    process.stdout.write(output);
    const newId = output.match(/"database_id":\s*"([0-9a-f-]{36})"/)?.[1];
    if (!newId) {
      console.error('✘ 未能从 wrangler d1 create 输出中解析 database_id');
      process.exit(1);
    }
    writeDatabaseId(newId);
    console.log(`\n▸ 已回写 database_id: ${oldId ?? '未知'} → ${newId}`);
    run(wrangler, ['d1', 'migrations', 'apply', dbName, '--remote', ...baseArgs]);
  }
} else if (dryRun) {
  console.log('↷ dry-run: 跳过远端迁移');
} else {
  run(wrangler, ['d1', 'migrations', 'apply', dbName, '--remote', ...baseArgs]);
}

// 3. 同步管理员账户（读取 .dev.vars 的 ADMIN_*，每次部署都会 upsert 密码）
seedAdmin({ databaseName: dbName, local: false, dryRun, wrangler });

// 4. 部署 Worker（静态资源 + API）
// ADMIN_* 仅用于播种，不能上传为 Worker Secret；这里过滤后只传运行时密钥。
const devVars = readDevVars(DEV_VARS_PATH);
if (!devVars.TURNSTILE_SECRET) {
  console.error('\n✘ .dev.vars 缺少 TURNSTILE_SECRET（模板见 src/worker/remote/.dev.vars.example）');
  process.exit(1);
}
const runtimeSecrets = Object.entries(devVars).filter(([key]) => !key.startsWith('ADMIN_'));
let secretsDir = null;
const deployArgs = ['deploy', ...baseArgs, '--env='];
if (runtimeSecrets.length > 0) {
  secretsDir = mkdtempSync(path.join(tmpdir(), 'lattice-secrets-'));
  const secretsFile = path.join(secretsDir, '.dev.vars');
  writeFileSync(secretsFile, runtimeSecrets.map(([key, value]) => `${key}=${value}`).join('\n') + '\n', { mode: 0o600 });
  deployArgs.push('--secrets-file', secretsFile);
}
try {
  run(wrangler, [...deployArgs, ...(dryRun ? ['--dry-run'] : [])]);
} finally {
  if (secretsDir) rmSync(secretsDir, { recursive: true, force: true });
}
console.log('\n✓ 部署流程完成');
