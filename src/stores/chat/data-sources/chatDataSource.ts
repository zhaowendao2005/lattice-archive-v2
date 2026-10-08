/**
 * ============================================================================
 * [DATA SOURCE] 聊天与会话业务单例数据接线器
 * 
 * 职责：
 * 1. 作为连接底层真实数据接口（如 SQLite / MTProto / IPC）与前端渲染的唯一全局单例。
 * 2. 现阶段封装 Mock 数据供给，待真实底层接通时替换为实际 query/fetch 逻辑。
 * ============================================================================
 */
import {
  MOCK_CHAT_SESSIONS,
  MOCK_CHAT_MESSAGES,
  type ChatSessionMock,
  type ChatMessageMock,
} from '../mocks/chatMock';

export class ChatDataSource {
  private static instance: ChatDataSource;

  public static getInstance(): ChatDataSource {
    if (!ChatDataSource.instance) {
      ChatDataSource.instance = new ChatDataSource();
    }
    return ChatDataSource.instance;
  }

  /** 获取所有活跃会话列表 */
  public async fetchSessions(): Promise<ChatSessionMock[]> {
    return Promise.resolve([...MOCK_CHAT_SESSIONS]);
  }

  /** 获取指定会话的消息流 */
  public async fetchMessages(sessionId: string): Promise<ChatMessageMock[]> {
    const list = MOCK_CHAT_MESSAGES[sessionId] || [];
    return Promise.resolve([...list]);
  }

  /** 发送新消息 */
  public async sendMessage(sessionId: string, text: string): Promise<ChatMessageMock> {
    const newMsg: ChatMessageMock = {
      id: `msg_${Date.now()}`,
      sessionId,
      senderName: 'You (Elena)',
      senderInitials: 'EL',
      avatarBg: 'bg-sky-600',
      isSelf: true,
      content: text,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      status: 'delivered',
    };
    return Promise.resolve(newMsg);
  }
}

export const chatDataSource = ChatDataSource.getInstance();
