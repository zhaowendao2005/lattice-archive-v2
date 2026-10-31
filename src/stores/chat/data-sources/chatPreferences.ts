/**
 * [DATA SOURCE] 聊天本机偏好（localStorage）
 *
 * 只保存非敏感的设备级开关（媒体自动下载 / 自动播放策略、播放器倍速与音量、画质上限）；读取失败或内容损坏时回退默认值。
 */
import type { AutoDownloadPrefs, AutoplayPrefs, PlayerPrefs } from '../types';

const AUTO_DOWNLOAD_KEY = 'lattice.chat.autoDownload.v1';
const AUTOPLAY_KEY = 'lattice.chat.autoplay.v1';
const PLAYER_KEY = 'lattice.chat.player.v1';
export const DEFAULT_AUTO_DOWNLOAD: AutoDownloadPrefs = { private: true, group: true, channel: true };
export const DEFAULT_AUTOPLAY: AutoplayPrefs = { gif: true, round: true };
/** maxHeight = 0 表示「自动」（不超过 720p 与屏幕物理高度）。 */
export const DEFAULT_PLAYER: PlayerPrefs = { rate: 1, volume: 1, muted: false, maxHeight: 0 };
const RATES = [0.5, 1, 1.5, 2];

function readJson<T extends object>(key: string): Partial<T> | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) as Partial<T> : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown) {
  try { window.localStorage.setItem(key, JSON.stringify(value)); } catch { /* 存储不可用时仅本次运行生效 */ }
}

const pickBoolean = (value: unknown, fallback: boolean) => (typeof value === 'boolean' ? value : fallback);

export const chatPreferences = {
  readAutoDownload(): AutoDownloadPrefs {
    const parsed = readJson<AutoDownloadPrefs>(AUTO_DOWNLOAD_KEY);
    if (!parsed) return { ...DEFAULT_AUTO_DOWNLOAD };
    return {
      private: pickBoolean(parsed.private, DEFAULT_AUTO_DOWNLOAD.private),
      group: pickBoolean(parsed.group, DEFAULT_AUTO_DOWNLOAD.group),
      channel: pickBoolean(parsed.channel, DEFAULT_AUTO_DOWNLOAD.channel),
    };
  },

  writeAutoDownload(prefs: AutoDownloadPrefs) { writeJson(AUTO_DOWNLOAD_KEY, prefs); },

  readAutoplay(): AutoplayPrefs {
    const parsed = readJson<AutoplayPrefs>(AUTOPLAY_KEY);
    return { gif: pickBoolean(parsed?.gif, DEFAULT_AUTOPLAY.gif), round: pickBoolean(parsed?.round, DEFAULT_AUTOPLAY.round) };
  },

  writeAutoplay(prefs: AutoplayPrefs) { writeJson(AUTOPLAY_KEY, prefs); },

  readPlayer(): PlayerPrefs {
    const parsed = readJson<PlayerPrefs>(PLAYER_KEY);
    if (!parsed) return { ...DEFAULT_PLAYER };
    const volume = typeof parsed.volume === 'number' && parsed.volume >= 0 && parsed.volume <= 1 ? parsed.volume : DEFAULT_PLAYER.volume;
    const maxHeight = typeof parsed.maxHeight === 'number' && parsed.maxHeight >= 0 ? parsed.maxHeight : DEFAULT_PLAYER.maxHeight;
    return {
      rate: RATES.includes(parsed.rate as number) ? parsed.rate as number : DEFAULT_PLAYER.rate,
      volume,
      muted: pickBoolean(parsed.muted, DEFAULT_PLAYER.muted),
      maxHeight,
    };
  },

  writePlayer(prefs: PlayerPrefs) { writeJson(PLAYER_KEY, prefs); },
};
