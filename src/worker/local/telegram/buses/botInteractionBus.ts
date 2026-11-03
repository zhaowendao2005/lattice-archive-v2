/**
 * ============================================================================
 * B8 BotInteractionBus · /start、Callback 按钮与静默编辑等待（BOT_RESPONSE_TIMEOUT 为业务超时，不触发重连）
 * ============================================================================
 * 只在 local Worker 内运行，由 BusRouter 经 RequestScheduler 调度后调用；
 * 输入输出均为 contracts/buses.ts 定义的 DTO，不向上游暴露 Api.* 类型。
 */
import { Buffer } from 'buffer';
import type { TelegramClient } from 'telegram';
import { Api } from 'telegram/tl';
import type { TgCallbackAnswer, TgMessageDto, TgPeerRef } from '../../chatProtocol';
import { startLocalTrace } from '../telemetry/localSpans';
import { invokeWithGateway, resolveInputPeer } from '../runtime/transportKernel';
import { currentEngineState, firstNewMessageOf, nextRandomId } from '../runtime/updateEngine';
import { sendMessage } from './chatCommandBus';

/** 唤醒机器人并传递深链参数（messages.StartBot 或直接发送 /start）。 */
export async function startBot(client: TelegramClient, botRef: TgPeerRef, startParam: string): Promise<TgMessageDto | null> {
  const param = startParam.trim();
  if (!param) return sendMessage(client, botRef, '/start');
  const peerKey = `user-${botRef.id}`;
  const trace = startLocalTrace('chat.send', 'startBot', { peer: peerKey, startParam: param });
  const peer = await resolveInputPeer(client, botRef);
  if (!(peer instanceof Api.InputPeerUser)) {
    return sendMessage(client, botRef, `/start ${param}`);
  }
  const bot = new Api.InputUser({ userId: peer.userId, accessHash: peer.accessHash });
  const result = await invokeWithGateway(
    client,
    new Api.messages.StartBot({
      bot,
      peer,
      randomId: nextRandomId(),
      startParam: param,
    }),
    { peerKey, state: currentEngineState(), advancePts: true, trace },
  );
  const dto = firstNewMessageOf(result, peerKey, `/start ${param}`, undefined, trace);
  trace.finishRoot({ msgId: dto?.id, pts: currentEngineState()?.pts }, 'INFO');
  return dto;
}

/** 点击消息下方的 Callback 内联按钮（messages.GetBotCallbackAnswer）。 */
export async function pressBotCallback(client: TelegramClient, ref: TgPeerRef, messageId: number, data: string): Promise<TgCallbackAnswer> {
  const peerKey = `${ref.type}-${ref.id}`;
  const trace = startLocalTrace('bot.callback', 'pressBotCallback', {
    peer: peerKey,
    messageId,
  });
  const peer = await resolveInputPeer(client, ref);
  try {
    const result = await invokeWithGateway<Api.messages.BotCallbackAnswer>(
      client,
      new Api.messages.GetBotCallbackAnswer({
        peer,
        msgId: messageId,
        data: Buffer.from(data, 'base64'),
      }),
      { peerKey, trace },
    );
    trace.finishRoot({ hasMessage: Boolean(result.message), hasUrl: Boolean(result.url) }, 'INFO');
    return {
      message: result.message || undefined,
      alert: Boolean(result.alert) || undefined,
      url: result.url || undefined,
    };
  } catch (error) {
    // 关键修复：大量 Telegram 搜索机器人在收到翻页 Callback 后仅调用 editMessageText 更新消息与按钮，
    // 而不调用 answerCallbackQuery，导致 Telegram 服务端在 ~10s 后返回 BOT_RESPONSE_TIMEOUT。
    // 此类情形并非错误，必须优雅降级为正常空回调结果，避免中断自动翻页或弹出假性报错。
    const code = String(
      (error as { errorMessage?: string })?.errorMessage ??
        (error instanceof Error ? error.message : ''),
    ).toUpperCase();
    if (code.includes('BOT_RESPONSE_TIMEOUT') || code.includes('DATA_INVALID')) {
      trace.childSpan(
        'bot.callback',
        'callback_timeout_normalized',
        { peer: peerKey, messageId, code },
        'INFO',
      );
      trace.finishRoot({ normalizedTimeout: true }, 'INFO');
      return {};
    }
    trace.finishRoot({ ok: false, code }, 'ERROR');
    throw error;
  }
}
