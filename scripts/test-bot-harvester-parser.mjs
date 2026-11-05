import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const out = mkdtempSync(join(tmpdir(), 'lattice-bot-parser-'));
try {
  const ts = createRequire(import.meta.url)('typescript');
  const source = readFileSync(join(root, 'src/worker/local/telegram/buses/botHarvesterParser.ts'), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  writeFileSync(join(out, 'parser.mjs'), js);
  const parser = await import(pathToFileURL(join(out, 'parser.mjs')).href);
  const msg = text => ({ id: 1, text });
  assert.equal(parser.extractBotCandidatesFromMessage(msg('https://t.me/+InviteHash'), 1)[0]?.kind, 'invite_hash');
  assert.equal(parser.extractBotCandidatesFromMessage(msg('https://t.me/channel_name/123'), 1)[0]?.kind, 'deep_link');
  assert.deepEqual(parser.extractBotCandidatesFromMessage(msg('热搜：https://t.me/kuai?start=query_test'), 1), []);
  const hidden = { id: 2, text: '🔎资源', entities: [{ type: 'textUrl', offset: 2, length: 2, url: 'https://t.me/some_channel' }] };
  assert.equal(parser.extractBotCandidatesFromMessage(hidden, 1)[0]?.username, 'some_channel');
  console.log('✓ bot harvest URL extraction and bot deep-link exclusion');
} finally { rmSync(out, { recursive: true, force: true }); }
