/**
 * 本地 Telegram Worker 入口（独立线程运行 GramJS，主线程永不接触 auth_key）。
 *
 * 只做两件事：最先求值 polyfills（GramJS 在模块初始化阶段就使用 Buffer / window / process），
 * 再把主线程命令交给 TelegramRuntime。所有业务实现位于 ./telegram/。
 */
import './polyfills';
import type { TgCommand } from './protocol';
import { handle } from './telegram/runtime/telegramRuntime';

/** 所有命令异步处理，单条失败不会打断消息循环。 */
self.addEventListener('message', (event: MessageEvent<TgCommand>) => { void handle(event.data); });
