/**
 * [STORE] 消息悬停工具条的通用动作状态（复制反馈）。
 *
 * 视图零 ref：「已复制」的短暂反馈状态放在这里；复制本身只调用浏览器剪贴板，不触达 Telegram。
 */
import { defineStore } from 'pinia';

let resetTimer: number | null = null;

export const useMessageActionStore = defineStore('messageAction', {
  state: () => ({
    /** 刚复制成功的消息 ID，约 1.5 秒后自动清除，用于把按钮图标短暂换成对勾。 */
    copiedMessageId: null as number | null,
  }),
  actions: {
    async copyMessageText(messageId: number, text: string) {
      const content = text.trim();
      if (!content) return;
      try {
        await navigator.clipboard.writeText(content);
      } catch {
        return;
      }
      this.copiedMessageId = messageId;
      if (resetTimer !== null) window.clearTimeout(resetTimer);
      resetTimer = window.setTimeout(() => {
        this.copiedMessageId = null;
        resetTimer = null;
      }, 1500);
    },
  },
});
