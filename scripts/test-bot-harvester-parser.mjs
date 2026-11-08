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
  const messageLinks = parser.extractBotCandidatesFromMessage(
    msg('媒体标题 https://t.me/channel_name/123 https://t.me/CHANNEL_NAME/568'),
    1,
  );
  assert.equal(messageLinks.length, 1, 'different message links for the same username must resolve to one peer candidate');
  assert.equal(messageLinks[0]?.kind, 'username');
  assert.equal(messageLinks[0]?.key, 'peer-channel_name');
  assert.equal(messageLinks[0]?.title, '@channel_name', 'media captions must not become session titles');
  assert.equal(messageLinks[0]?.startParam, undefined, 'message ids must not be retained as a bot start parameter');
  assert.equal(messageLinks[0]?.sourceTextSnippet, 'https://t.me/channel_name/123', 'the source message link may remain as provenance');

  const internalMessageLink = parser.extractBotCandidatesFromMessage(msg('https://t.me/c/123456789/568'), 1)[0];
  assert.equal(internalMessageLink?.kind, 'internal_peer');
  assert.equal(internalMessageLink?.internalChannelId, '123456789');
  assert.equal(internalMessageLink?.sourceTextSnippet, 'https://t.me/c/123456789/568');

  // A bot navigation link must not become a harvest target, including host/case variants.
  assert.deepEqual(parser.extractBotCandidatesFromMessage(msg('热搜：https://TELEGRAM.ME/SearchBot?START=query_test.'), 1), []);

  // Hidden textUrl entities remain harvestable even when the visible text has no URL.
  const hidden = { id: 2, text: '🔎资源', entities: [{ type: 'textUrl', offset: 2, length: 2, url: 'https://t.me/some_channel' }] };
  assert.equal(parser.extractBotCandidatesFromMessage(hidden, 1)[0]?.username, 'some_channel');

  // The same URL can be present in an entity, raw text, and an inline button; it is one candidate.
  const repeatedUrl = 'https://t.me/Shared_Channel';
  const repeated = {
    id: 3,
    text: `资源 ${repeatedUrl}`,
    entities: [{ type: 'url', offset: 3, length: repeatedUrl.length }],
    replyMarkup: [[{ kind: 'url', text: '打开', url: repeatedUrl }]],
  };
  assert.equal(parser.extractBotCandidatesFromMessage(repeated, 1).length, 1, 'entity/raw/button copies must deduplicate');

  // Host casing, username casing, and sentence punctuation must not alter URL identity.
  const normalized = parser.extractBotCandidatesFromMessage(
    msg('频道：https://TELEGRAM.ME/Case_Channel! https://t.me/case_channel.'),
    2,
  );
  assert.equal(normalized.length, 1, 'host/case/trailing punctuation variants must normalize to one candidate');
  assert.equal(normalized[0]?.key, 'peer-case_channel');

  // Telegram internal/non-session paths are not public username candidates.
  const nonSession = parser.extractBotCandidatesFromMessage(
    msg('https://t.me/c/123 https://t.me/addstickers/pack https://t.me/proxy/host https://t.me/share/url'),
    1,
  );
  assert.deepEqual(nonSession, [], 'non-session paths must be ignored');

  // Different representations of the same semantic peer are also one candidate.
  const semanticDuplicates = {
    id: 4,
    text: '@Semantic_Peer https://t.me/semantic_peer',
    entities: [{ type: 'mention', offset: 0, length: '@Semantic_Peer'.length }],
    replyMarkup: [[{ kind: 'url', text: '频道', url: 'https://telegram.me/SEMANTIC_PEER/' }]],
  };
  const semantic = parser.extractBotCandidatesFromMessage(semanticDuplicates, 3);
  assert.equal(semantic.length, 1, 'mention, URL, and button forms must deduplicate semantically');
  assert.equal(semantic[0]?.key, 'peer-semantic_peer');

  console.log('✓ bot harvest URL extraction, normalization, deduplication, and bot deep-link exclusion');
} finally { rmSync(out, { recursive: true, force: true }); }
