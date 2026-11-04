#!/usr/bin/env node
/**
 * 本地批量会话解析器行为测试：验证纯文本 StringSession 与 JSON 行格式。
 * 真实 UI 调用经 Telegram Worker，但这里直接测试 Worker 实现函数，避免协议回归。
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ts = createRequire(import.meta.url)('typescript');
const out = mkdtempSync(join(tmpdir(), 'lattice-session-parser-'));
try {
  mkdirSync(join(out, 'worker/local'), { recursive: true });
  const source = readFileSync(join(ROOT, 'src/worker/local/sessionBatchParser.ts'), 'utf8');
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  writeFileSync(join(out, 'worker/local/sessionBatchParser.mjs'), code);
  const parser = await import(pathToFileURL(join(out, 'worker/local/sessionBatchParser.mjs')).href);
  const session = `1${'A'.repeat(160)}`;
  const text = `${session}\n+8613800138000|ignored\n{"session":"${session}","phone":"+8613800138000","dc_id":4,"twoFA":"secret"}`;
  const items = parser.parseSessionTextLines(text);
  assert.equal(items.length, 2);
  assert.equal(items[0].sessionString, session);
  assert.equal(items[0].phone, undefined);
  assert.equal(items[1].phone, '+8613800138000');
  assert.equal(items[1].twoFaPassword, 'secret');
  assert.equal(items[1].dcId, 4);
  assert.equal(parser.parseSessionTextLines('not a session').length, 0);
  console.log('✓ session batch parser tests passed');
} finally {
  rmSync(out, { recursive: true, force: true });
}
