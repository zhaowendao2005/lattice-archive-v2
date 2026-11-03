/**
 * ============================================================================
 * Telegram 业务总线契约（主线程 TelegramBusClient ↔ local Worker BusRouter）
 * ============================================================================
 * 9 条业务总线的操作、输入与输出类型。上游只看到 DTO，GramJS 的 Api.* 类型只存在于 Worker 总线内部。
 * 这是唯一的跨线程请求契约：旧的 TgChatRequest 方法字符串协议已删除。
 */
import type { BotHarvestCandidateItem } from '@/types/botHarvest';
import type { TgInlineButton } from '../../chatProtocol';
import type {
  TgAccountHealthReport,
  TgCallbackAnswer,
  TgDialogCursor,
  TgDialogDto,
  TgDialogPage,
  TgDocumentLocation,
  TgDocumentPart,
  TgHistoryPage,
  TgInvitePreview,
  TgJoinChatResult,
  TgMediaFile,
  TgMessageDto,
  TgPeerKey,
  TgPeerRef,
  TgPhotoLocation,
  TgPhotoSize,
  TgSearchMessagesPage,
  TgSpawnedSlotResult,
  TgSyncResult,
  TgUpdatesState,
  TgVaultTopicsInfo,
} from '../../chatProtocol';

interface Op<I, O> { input: I; output: O }

export type SearchFilter = 'all' | 'video' | 'photo' | 'document' | 'music' | 'url';

export interface BotPageMetadata { page: number | null; hasPagination: boolean; pairedQuery: { queryText: string; queryMsgId?: number } }

export interface SearchMessagesInput {
  peer?: TgPeerRef;
  query: string;
  filter?: SearchFilter;
  minDate?: number;
  maxDate?: number;
  fromPeer?: TgPeerRef;
  topMsgId?: number;
  offsetId?: number;
  offsetRate?: number;
  offsetPeer?: TgPeerRef;
  limit: number;
}

export interface ForwardToVaultInput { fromPeer: TgPeerRef; toPeer: TgPeerRef; messageIds: number[]; dropAuthor?: boolean; topMsgId?: number }
export interface CloneNoForwardsInput { fromPeer: TgPeerRef; toPeer: TgPeerRef; messageId: number; topMsgId?: number; caption?: string }
export interface EnsureVaultTopicsInput { vaultPeer?: TgPeerRef; title?: string }
export interface SyncBeaconInput { vaultPeer: TgPeerRef; beaconTopicId: number; limit?: number }
export interface SpawnPendingSlotInput {
  apiId: number;
  apiHash: string;
  twoFaPassword?: string;
  deviceFingerprint: { deviceModel: string; systemVersion: string; appVersion: string; langCode: string; systemLangCode: string };
}

/** 封面请求来源：搜索结果封面可使用封面池中为搜索保留的槽位。 */
export type CoverOrigin = 'chat' | 'search';

export interface TelegramBusOps {
  account: {
    probeHealth: Op<{ ensureTtlDays?: number }, TgAccountHealthReport>;
    spawnPendingSlot: Op<SpawnPendingSlotInput, TgSpawnedSlotResult>;
  };
  chatRead: {
    getDialogs: Op<{ folderId?: 0 | 1; cursor?: TgDialogCursor; limit: number }, TgDialogPage>;
    getHistory: Op<{ peer: TgPeerRef; offsetId: number; limit: number }, TgHistoryPage>;
    getHistoryAround: Op<{ peer: TgPeerRef; messageId: number; limit: number }, TgHistoryPage>;
    syncFrom: Op<{ state: TgUpdatesState | null }, TgSyncResult>;
  };
  search: {
    searchMessages: Op<SearchMessagesInput, TgSearchMessagesPage>;
  };
  cover: {
    avatar: Op<{ peer: TgPeerRef; photoId: string; dcId: number; containerPeer?: TgPeerRef; messageId?: number }, TgMediaFile>;
    photo: Op<{ peer: TgPeerRef; messageId: number; photo: TgPhotoLocation; size: TgPhotoSize; origin?: CoverOrigin }, TgMediaFile>;
    documentThumb: Op<{ peer: TgPeerRef; messageId: number; document: TgDocumentLocation; size: TgPhotoSize; origin?: CoverOrigin }, TgMediaFile>;
  };
  mediaAsset: {
    document: Op<{ peer: TgPeerRef; messageId: number; document: TgDocumentLocation; size: number; mimeType: string }, TgMediaFile>;
  };
  stream: {
    part: Op<{ peer: TgPeerRef; messageId: number; document: TgDocumentLocation; offset: number; limit: number; size: number; mimeType: string }, TgDocumentPart>;
  };
  chatCommand: {
    setArchived: Op<{ peer: TgPeerRef; archived: boolean }, { folderId: 0 | 1 }>;
    batchSetArchived: Op<{ peers: TgPeerRef[]; archived: boolean }, { folderId: 0 | 1; count: number }>;
    resolveUsername: Op<{ username: string }, TgDialogDto | null>;
    join: Op<{ peer: TgPeerRef }, TgJoinChatResult>;
    leave: Op<{ peer: TgPeerRef }, { ok: true }>;
    deleteChat: Op<{ peer: TgPeerRef; revoke?: boolean }, { ok: true }>;
    sendMessage: Op<{ peer: TgPeerRef; text: string; replyToMsgId?: number }, TgMessageDto | null>;
    checkInvite: Op<{ hash: string }, TgInvitePreview>;
    importInvite: Op<{ hash: string }, TgJoinChatResult>;
    batchCheckChannels: Op<{ channels: TgPeerRef[] }, { dialogs: TgDialogDto[]; invalidKeys: TgPeerKey[] }>;
  };
  bot: {
    metadata: Op<{ message: TgMessageDto; windowMessages: TgMessageDto[]; fallbackLastQuery?: string }, BotPageMetadata>;
    findNextButton: Op<{ rows: TgInlineButton[][]; nextPageNum: number }, TgInlineButton | null>;
    extractCandidates: Op<{ message: TgMessageDto; pageNum: number }, BotHarvestCandidateItem[]>;
    start: Op<{ bot: TgPeerRef; startParam: string }, TgMessageDto | null>;
    pressCallback: Op<{ peer: TgPeerRef; messageId: number; data: string }, TgCallbackAnswer>;
  };
  vault: {
    forward: Op<ForwardToVaultInput, { ok: true; forwardedMsgIds: number[] }>;
    cloneNoForwards: Op<CloneNoForwardsInput, { ok: true; message: TgMessageDto | null }>;
    ensureTopics: Op<EnsureVaultTopicsInput, TgVaultTopicsInfo>;
    syncBeacon: Op<SyncBeaconInput, { syncedDialogs: TgDialogDto[] }>;
  };
}

export type BusName = keyof TelegramBusOps;
export type BusOpName<B extends BusName> = keyof TelegramBusOps[B] & string;
export type BusInput<B extends BusName, O extends BusOpName<B>> = TelegramBusOps[B][O] extends Op<infer I, unknown> ? I : never;
export type BusOutput<B extends BusName, O extends BusOpName<B>> = TelegramBusOps[B][O] extends Op<unknown, infer R> ? R : never;
