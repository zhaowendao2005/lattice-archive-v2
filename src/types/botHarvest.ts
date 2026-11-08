/** Link from a Telegram bot result, enriched only after resolving its real chat peer. */
export interface BotHarvestCandidateItem {
  /** Canonical Telegram peer key after verification; never the message/link identity. */
  key: string;
  /** Real Telegram chat title after verification, never the bot's media caption. */
  title: string;
  /** The link form used to resolve the peer. */
  kind: 'username' | 'invite_hash' | 'internal_peer';
  username?: string;
  inviteHash?: string;
  /** Telegram's internal channel id from a t.me/c/<id>/<messageId> link. */
  internalChannelId?: string;
  sourcePage: number;
  /** Source link retained for provenance/preview; it is not the tile identity. */
  sourceTextSnippet: string;
  peerKey?: string;
  peerId?: string;
  peerType?: 'chat' | 'channel';
  peerKind?: 'group' | 'supergroup' | 'channel';
  accessHash?: string;
  avatarPhotoId?: string;
  avatarDcId?: number;
  avatarThumb?: string;
  participantsCount?: number;
  about?: string;
  peekExpiresAt?: number;
  alreadyInExplore: boolean;
  alreadyJoined: boolean;
  selected: boolean;
}
