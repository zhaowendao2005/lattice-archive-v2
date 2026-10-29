#!/usr/bin/env node
/**
 * 管理员账户种子：读取 .dev.vars 的 ADMIN_EMAIL / ADMIN_PASSWORD / ADMIN_NAME，
 * 生成与 Worker 完全一致的 PBKDF2 哈希，并 upsert 到 D1。
 *
 * 用法：
 *   node scripts/seed-admin.mjs --local     # 写入本地开发库
 *   node scripts/seed-admin.mjs --remote    # 写入远端库（deploy 会自动调用）
 *   node scripts/seed-admin.mjs --remote --dry-run
 */
import { pbkdf2Sync, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ITERATIONS = 25_000;
const KEY_LENGTH = 32;

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEV_VARS_PATH = path.join(ROOT, 'src/worker/remote/.dev.vars');

/** 解析 .dev.vars（KEY=VALUE，# 开头为注释），保留值中的等号。 */
export function readDevVars(file = DEV_VARS_PATH) {
  let source;
  try {
    source = readFileSync(file, 'utf8');
  } catch {
    return {};
  }
  const vars = {};
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    vars[key] = value;
  }
  return vars;
}

const sqlString = (value) => `'${String(value).replace(/'/g, "''")}'`;

/** 生成 upsert 管理员的 SQL；同一邮箱重复部署会更新密码与资料。 */
export function buildAdminSql(vars, now = Date.now()) {
  const email = (vars.ADMIN_EMAIL ?? '').trim().toLowerCase();
  const password = vars.ADMIN_PASSWORD ?? '';
  const name = (vars.ADMIN_NAME ?? 'System Operator').trim() || 'System Operator';
  if (!email || !email.includes('@')) throw new Error('ADMIN_EMAIL 缺失或格式无效');
  if (password.length < 8) throw new Error('ADMIN_PASSWORD 至少需要 8 位');

  const salt = randomBytes(16);
  const hash = pbkdf2Sync(password, salt, ITERATIONS, KEY_LENGTH, 'sha256');
  const initials = (vars.ADMIN_INITIALS ?? Array.from(name).slice(0, 2).join('')).toUpperCase();

  return `INSERT INTO users (id, name, email, initials, role, password_hash, password_salt, iterations, created_at, updated_at)
VALUES (${sqlString('adm_' + randomUUID())}, ${sqlString(name)}, ${sqlString(email)}, ${sqlString(initials)}, 'admin', ${sqlString(hash.toString('hex'))}, ${sqlString(salt.toString('hex'))}, ${ITERATIONS}, ${now}, ${now})
ON CONFLICT(email) DO UPDATE SET
  name = excluded.name,
  initials = excluded.initials,
  role = 'admin',
  password_hash = excluded.password_hash,
  password_salt = excluded.password_salt,
  iterations = excluded.iterations,
  updated_at = excluded.updated_at;`;
}

/** 写入 D1；local / remote 二选一。 */
export function seedAdmin({
  databaseName = 'lattice-v2-d1',
  local = false,
  dryRun = false,
  wrangler = process.env.WRANGLER_BIN || 'wrangler',
  vars = readDevVars(),
} = {}) {
  if (!vars.ADMIN_EMAIL || !vars.ADMIN_PASSWORD) {
    console.warn('! 未配置 ADMIN_EMAIL / ADMIN_PASSWORD，跳过管理员种子');
    return false;
  }
  const sql = buildAdminSql(vars);
  const target = local ? '本地' : '远端';
  if (dryRun) {
    console.log(`↷ dry-run: 跳过管理员种子（${target} ${vars.ADMIN_EMAIL}）`);
    return false;
  }

  const dir = mkdtempSync(path.join(tmpdir(), 'lattice-admin-'));
  const file = path.join(dir, 'seed-admin.sql');
  try {
    writeFileSync(file, sql, { mode: 0o600 });
    chmodSync(file, 0o600);
    const args = [
      'd1', 'execute', databaseName,
      '--config', 'src/worker/remote/wrangler.jsonc',
      local ? '--local' : '--remote',
      '--file', file,
    ];
    console.log(`\n$ ${wrangler} ${args.join(' ')}`);
    const result = spawnSync(wrangler, args, {
      cwd: ROOT,
      stdio: 'inherit',
      env: { ...process.env, CI: process.env.CI ?? 'true' },
    });
    if (result.status !== 0) throw new Error(`管理员种子写入${target}库失败`);
    console.log(`▸ 管理员账户已更新：${vars.ADMIN_EMAIL}`);
    return true;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  const argv = process.argv.slice(2);
  try {
    seedAdmin({
      local: argv.includes('--local'),
      dryRun: argv.includes('--dry-run'),
    });
  } catch (error) {
    console.error(`✘ ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
