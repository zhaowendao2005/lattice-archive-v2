#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
const expected = ['account', 'chatRead', 'search', 'cover', 'mediaAsset', 'stream', 'chatCommand', 'bot', 'vault'];

function block(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0) throw new Error(`无法解析源码区块：${startMarker}`);
  return source.slice(start, end);
}

function keysIn(source) {
  return Array.from(source.matchAll(/^\s{2}([A-Za-z][\w]*):\s*\{/gm), (match) => match[1]);
}

function assertSame(label, actual) {
  const missing = expected.filter((key) => !actual.includes(key));
  const extra = actual.filter((key) => !expected.includes(key));
  if (missing.length || extra.length) {
    throw new Error(`${label} 不一致；缺少: ${missing.join(', ') || '无'}；多余: ${extra.join(', ') || '无'}`);
  }
}

try {
  const contracts = read('src/worker/local/telegram/contracts/buses.ts');
  const router = read('src/worker/local/telegram/runtime/busRouter.ts');
  const client = read('src/stores/telegram/data-sources/telegramBusClient.ts');
  const monitor = read('src/worker/local/telegram/contracts/monitor.ts');

  const contractBlock = block(contracts, 'export interface TelegramBusOps {', '\n}\n\nexport type BusName');
  const routeBlock = block(router, 'const ROUTES: RouteTable = {', '\n};');
  const clientBlock = block(client, 'export const telegramBusClient = {', '\n};');
  assertSame('TelegramBusOps', keysIn(contractBlock));
  assertSame('BusRouter.ROUTES', keysIn(routeBlock));
  assertSame('TelegramBusClient', keysIn(clientBlock));

  const monitored = Array.from(monitor.matchAll(/\bid:\s*'([A-Za-z][\w]*)'/g), (match) => match[1]);
  const uncovered = expected.filter((key) => !monitored.includes(key));
  if (uncovered.length) throw new Error(`Telegram monitor 未覆盖 bus: ${uncovered.join(', ')}`);

  for (const key of expected) {
    if (!new RegExp(`\\b${key}\\s*:\\s*\\{`).test(contractBlock)) throw new Error(`${key} 没有操作契约`);
    if (!new RegExp(`\\b${key}\\s*:\\s*\\{`).test(routeBlock)) throw new Error(`${key} 没有 BusRouter 路由`);
  }
  console.log(`✓ Telegram bus 契约通过（${expected.length} 条总线，contracts / routes / client / monitor 一致）`);
} catch (error) {
  console.error(`✖ Telegram bus 契约失败：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
