/**
 * ============================================================================
 * TransportKernel：MTProto RPC 网关、公共 pts 推进与 InputPeer 解析
 * ============================================================================
 * 1. 统一收口业务总线主动发起的 `client.invoke`，采集耗时与结构化 Trace Span；
 * 2. 统一推进公共消息盒 `pts`（UpdateShortSentMessage / Updates / AffectedHistory / AffectedMessages），
 *    防止漏推进导致假性 gap 重置窗口；
 * 3. `BOT_RESPONSE_TIMEOUT` 只记 WARN，属于业务超时，绝不触发连接重连；
 * 4. 把 DTO 的 peer 引用解析为 GramJS InputPeer（实体缓存优先，缺失时回填会话首页）。
 * 只有 runtime/ 与 buses/ 可以引用本模块。
 */
import type { TelegramClient } from 'telegram';
import { Api } from 'telegram/tl';
import { returnBigInt } from 'telegram/Helpers';
import type { TgPeerKey, TgPeerRef, TgUpdatesState } from '../../chatProtocol';
import { isSelfKey, peerInfo, rememberEntities } from '../converters/converters';
import { startLocalTrace, type LocalTraceContext } from '../telemetry/localSpans';

/** 参与公共消息盒 pts 连续性推进的 TL 更新构造器集合 */
const COMMON_PTS_UPDATE_TYPES = [
  Api.UpdateNewMessage,
  Api.UpdateEditMessage,
  Api.UpdateDeleteMessages,
  Api.UpdateReadHistoryInbox,
  Api.UpdateReadHistoryOutbox,
  Api.UpdateReadMessagesContents,
  Api.UpdateWebPage,
  Api.UpdatePinnedMessages,
  Api.UpdateFolderPeers,
  Api.UpdateShortMessage,
  Api.UpdateShortChatMessage,
];

/**
 * 统一推进公共消息盒的 pts 水位（适用于主动写 RPC 返回的 Updates / UpdateShortSentMessage / AffectedHistory 等）
 */
export function advancePtsFromRpcResult(
  state: TgUpdatesState | null,
  result: unknown,
  trace?: LocalTraceContext,
  sourceMethod = 'rpc',
): void {
  if (!state || !result) return;

  const applySinglePts = (pts: number, ptsCount: number, date?: number, label = sourceMethod) => {
    const oldPts = state.pts;
    if (pts > state.pts) {
      const contiguous = oldPts + ptsCount === pts;
      state.pts = pts;
      if (typeof date === 'number' && date > state.date) state.date = date;
      trace?.childSpan(
        'chat.pts',
        'advance_pts',
        {
          source: label,
          oldPts,
          newPts: pts,
          ptsCount,
          verdict: contiguous ? 'apply_contiguous' : 'adopt_outbox_pts',
        },
        'INFO',
      );
    }
  };

  // 1. 私聊/机器人发送消息返回的 UpdateShortSentMessage
  if (result instanceof Api.UpdateShortSentMessage) {
    applySinglePts(result.pts, result.ptsCount, result.date, 'UpdateShortSentMessage');
    return;
  }

  // 2. 删除历史/消息返回的 AffectedHistory / AffectedMessages
  if (
    result instanceof Api.messages.AffectedHistory ||
    result instanceof Api.messages.AffectedMessages
  ) {
    applySinglePts(result.pts, result.ptsCount, undefined, result.className);
    return;
  }

  // 3. 标准 Updates / UpdatesCombined 容器
  if (result instanceof Api.Updates || result instanceof Api.UpdatesCombined) {
    const ptsItems: { pts: number; ptsCount: number; className: string }[] = [];
    for (const item of result.updates) {
      if (COMMON_PTS_UPDATE_TYPES.some((t) => item instanceof t)) {
        const u = item as unknown as { pts?: number; ptsCount?: number; className?: string };
        if (typeof u.pts === 'number' && typeof u.ptsCount === 'number') {
          ptsItems.push({
            pts: u.pts,
            ptsCount: u.ptsCount,
            className: u.className ?? 'Update',
          });
        }
      }
    }
    ptsItems.sort((a, b) => a.pts - b.pts);
    for (const item of ptsItems) {
      applySinglePts(item.pts, item.ptsCount, result.date, item.className);
    }
    if (typeof result.date === 'number' && result.date > state.date) {
      state.date = result.date;
    }
    if (typeof result.seq === 'number' && result.seq > state.seq) {
      state.seq = result.seq;
    }
  }
}

export interface GatewayInvokeOptions {
  accountId?: string;
  peerKey?: string;
  state?: TgUpdatesState | null;
  advancePts?: boolean;
  trace?: LocalTraceContext;
  tags?: Record<string, string | number | boolean | undefined>;
}

/**
 * 统一居中管理的 MTProto RPC 调用入口
 */
export async function invokeWithGateway<R>(
  client: TelegramClient,
  query: Api.AnyRequest,
  options: GatewayInvokeOptions = {},
): Promise<R> {
  const methodName = (query as { className?: string }).className ?? 'mtproto.Invoke';
  const startMs = Date.now();
  const ownTrace =
    options.trace ??
    startLocalTrace('tg.gateway', methodName, {
      accountId: options.accountId,
      peer: options.peerKey,
      ...options.tags,
    });

  try {
    const result = (await client.invoke(query)) as R;
    const durMs = Date.now() - startMs;

    if (options.advancePts && options.state) {
      advancePtsFromRpcResult(options.state, result, ownTrace, methodName);
    }

    if (options.trace) {
      ownTrace.childSpan(
        'tg.gateway',
        'rpc_invoke',
        {
          method: methodName,
          peer: options.peerKey,
          ok: true,
          ...options.tags,
        },
        'INFO',
        durMs,
      );
    } else {
      ownTrace.finishRoot({ ok: true, durMs }, 'INFO');
    }

    return result;
  } catch (error) {
    const durMs = Date.now() - startMs;
    const rawCode = String(
      (error as { errorMessage?: string })?.errorMessage ??
        (error instanceof Error ? error.message : 'UNKNOWN'),
    ).toUpperCase();

    if (options.trace) {
      ownTrace.childSpan(
        'tg.gateway',
        'rpc_error',
        {
          method: methodName,
          peer: options.peerKey,
          code: rawCode,
          ...options.tags,
        },
        rawCode.includes('BOT_RESPONSE_TIMEOUT') ? 'WARN' : 'ERROR',
        durMs,
      );
    } else {
      ownTrace.finishRoot(
        { ok: false, code: rawCode, durMs },
        rawCode.includes('BOT_RESPONSE_TIMEOUT') ? 'WARN' : 'ERROR',
      );
    }
    throw error;
  }
}

/**
 * 把 DTO 里的 peer 引用转成 GramJS 的 InputPeer。
 * 优先用调用方给的 accessHash，其次用实体缓存，都没有则让 GramJS 自己去解析。
 * 「自己」需要特殊处理成 InputPeerSelf。
 */
export async function resolveInputPeer(client: TelegramClient, ref: TgPeerRef): Promise<Api.TypeInputPeer> {
  if (ref.type === 'user' && isSelfKey(`user-${ref.id}`)) return new Api.InputPeerSelf();
  if (ref.type === 'chat') return new Api.InputPeerChat({ chatId: returnBigInt(ref.id) });
  const key = `${ref.type}-${ref.id}` as TgPeerKey;
  const accessHash = ref.accessHash ?? peerInfo(key)?.ref.accessHash;
  if (accessHash !== undefined) {
    return ref.type === 'user'
      ? new Api.InputPeerUser({ userId: returnBigInt(ref.id), accessHash: returnBigInt(accessHash) })
      : new Api.InputPeerChannel({ channelId: returnBigInt(ref.id), accessHash: returnBigInt(accessHash) });
  }
  const peer = ref.type === 'user' ? new Api.PeerUser({ userId: returnBigInt(ref.id) }) : new Api.PeerChannel({ channelId: returnBigInt(ref.id) });
  try {
    return await client.getInputEntity(peer);
  } catch {
    // 若该会话位于归档文件夹 (folderId=1) 或尚未拉取进缓存，尝试拉取归档与活动会话首页填充实体字典
    for (const folderId of [1, 0] as const) {
      try {
        const res = await client.invoke(new Api.messages.GetDialogs({
          offsetDate: 0,
          offsetId: 0,
          offsetPeer: new Api.InputPeerEmpty(),
          limit: 100,
          hash: returnBigInt(0),
          excludePinned: false,
          folderId,
        }));
        if (!(res instanceof Api.messages.DialogsNotModified)) {
          rememberEntities(res.users, res.chats);
        }
        const hydrated = peerInfo(key)?.ref.accessHash;
        if (hydrated !== undefined) {
          return ref.type === 'user'
            ? new Api.InputPeerUser({ userId: returnBigInt(ref.id), accessHash: returnBigInt(hydrated) })
            : new Api.InputPeerChannel({ channelId: returnBigInt(ref.id), accessHash: returnBigInt(hydrated) });
        }
      } catch {
        // 忽略拉取异常，继续尝试
      }
    }
    return client.getInputEntity(peer);
  }
}
