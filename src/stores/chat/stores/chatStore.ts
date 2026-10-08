import { defineStore } from 'pinia';
import { chatDataSource } from '../data-sources/chatDataSource';
import type { ChatSessionMock, ChatMessageMock } from '../mocks/chatMock';

export const useChatStore = defineStore('chat', {
  state: () => ({
    sessions: [] as ChatSessionMock[],
    activeSessionId: 'chat_group_1',
    messagesMap: {} as Record<string, ChatMessageMock[]>,
    searchKeyword: '',
    draftInput: '',
    isLoading: false,
  }),

  getters: {
    /** 当前激活的会话详情 */
    activeSession(state): ChatSessionMock | undefined {
      return state.sessions.find((s) => s.id === state.activeSessionId);
    },

    /** 当前激活会话的消息流 */
    activeMessages(state): ChatMessageMock[] {
      return state.messagesMap[state.activeSessionId] || [];
    },

    /** 检索过滤后的会话列表 */
    filteredSessions(state): ChatSessionMock[] {
      const kw = state.searchKeyword.trim().toLowerCase();
      if (!kw) return state.sessions;
      return state.sessions.filter(
        (s) =>
          s.title.toLowerCase().includes(kw) ||
          s.lastMessage.toLowerCase().includes(kw) ||
          s.tags.some((t) => t.toLowerCase().includes(kw))
      );
    },
  },

  actions: {
    async initialize() {
      this.isLoading = true;
      try {
        const list = await chatDataSource.fetchSessions();
        this.sessions = list;
        if (list.length > 0 && !this.activeSessionId) {
          this.activeSessionId = list[0].id;
        }
        if (this.activeSessionId) {
          await this.loadMessages(this.activeSessionId);
        }
      } finally {
        this.isLoading = false;
      }
    },

    async selectSession(sessionId: string) {
      this.activeSessionId = sessionId;
      if (!this.messagesMap[sessionId]) {
        await this.loadMessages(sessionId);
      }
    },

    async loadMessages(sessionId: string) {
      const msgs = await chatDataSource.fetchMessages(sessionId);
      this.messagesMap[sessionId] = msgs;
    },

    setSearchKeyword(keyword: string) {
      this.searchKeyword = keyword;
    },

    setDraftInput(text: string) {
      this.draftInput = text;
    },

    async sendCurrentMessage() {
      const text = this.draftInput.trim();
      if (!text || !this.activeSessionId) return;

      const sent = await chatDataSource.sendMessage(this.activeSessionId, text);
      if (!this.messagesMap[this.activeSessionId]) {
        this.messagesMap[this.activeSessionId] = [];
      }
      this.messagesMap[this.activeSessionId].push(sent);
      this.draftInput = '';

      // 同步更新会话项的最后一条消息
      const session = this.sessions.find((s) => s.id === this.activeSessionId);
      if (session) {
        session.lastMessage = `You: ${text}`;
        session.timestamp = sent.timestamp;
      }
    },
  },
});
