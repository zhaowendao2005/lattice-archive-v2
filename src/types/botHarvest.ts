/** Candidate link extracted from a Telegram bot result message. */
export interface BotHarvestCandidateItem {
  key: string;
  title: string;
  kind: 'username' | 'invite_hash' | 'deep_link';
  username?: string;
  inviteHash?: string;
  botUsername?: string;
  startParam?: string;
  sourcePage: number;
  sourceTextSnippet: string;
  alreadyInExplore: boolean;
  alreadyJoined: boolean;
  selected: boolean;
}
