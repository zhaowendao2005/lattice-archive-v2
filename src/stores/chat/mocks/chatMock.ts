/**
 * ============================================================================
 * [MOCK DATA] 聊天与会话业务域模拟数据集
 * 
 * 规范约束说明：
 * 1. 本文件收敛「Telegram 会话列表」及「对应对话详情」的所有原型数据。
 * 2. 【接线即删铁律】：一旦 chatDataSource 接入真实 Telegram MTProto 或
 *    本地 SQLite 数据库时，请立即物理删除本文件以及 chatStore 中的对应引用。
 * ============================================================================
 */

export interface ChatSessionMock {
  id: string;
  title: string;
  avatarText: string;
  avatarBg: string;
  lastMessage: string;
  timestamp: string;
  unreadCount: number;
  tags: string[];
}

export interface ChatMessageMock {
  id: string;
  sessionId: string;
  senderName: string;
  senderInitials: string;
  avatarBg: string;
  isSelf: boolean;
  content: string;
  timestamp: string;
  status?: 'sent' | 'delivered' | 'read';
}

/** 模拟会话列表数据 */
export const MOCK_CHAT_SESSIONS: ChatSessionMock[] = [
  {
    id: 'chat_group_1',
    title: 'Lattice Protocol Group',
    avatarText: 'TG',
    avatarBg: 'bg-sky-600',
    lastMessage: 'Elena: 现代温润圆角与瑞士白底浅蓝规范已合并。',
    timestamp: '14:32',
    unreadCount: 12,
    tags: ['#dev', '#specs'],
  },
  {
    id: 'chat_user_2',
    title: 'Marcus K.',
    avatarText: 'MK',
    avatarBg: 'bg-slate-800',
    lastMessage: '圆角版本视觉质感温润亲切，且无苹果风的毛玻璃堆叠。',
    timestamp: '11:05',
    unreadCount: 0,
    tags: ['#core'],
  },
  {
    id: 'chat_bot_3',
    title: 'Archive Bot',
    avatarText: 'AR',
    avatarBg: 'bg-slate-300 text-slate-800',
    lastMessage: 'SQLite 本地归档数据库增量备份完毕（5,420 条记录）。',
    timestamp: '昨天',
    unreadCount: 0,
    tags: ['#sqlite'],
  },
  {
    id: 'chat_system_4',
    title: 'System Dispatch',
    avatarText: 'SY',
    avatarBg: 'bg-cyan-700',
    lastMessage: 'WebKit 双击放大手势已成功拦截，触屏响应时间为 0ms。',
    timestamp: '10-06',
    unreadCount: 0,
    tags: ['#runtime'],
  },
];

/** 模拟消息流数据 */
export const MOCK_CHAT_MESSAGES: Record<string, ChatMessageMock[]> = {
  chat_group_1: [
    {
      id: 'msg_1',
      sessionId: 'chat_group_1',
      senderName: 'Marcus K.',
      senderInitials: 'MK',
      avatarBg: 'bg-slate-800',
      isSelf: false,
      content: '当前前端已经采用现代温润圆角体系（8px 按钮、12px 容器、14px 流线气泡），视觉质感非常平衡。',
      timestamp: '14:15',
    },
    {
      id: 'msg_2',
      sessionId: 'chat_group_1',
      senderName: 'You (Elena)',
      senderInitials: 'EL',
      avatarBg: 'bg-sky-600',
      isSelf: true,
      content: '是的，左侧栏伸缩时 DOM Tree 结构完全保持稳定，由纯 CSS 宽度与可见性控制，彻底消除了重排与抖动。',
      timestamp: '14:28',
      status: 'read',
    },
    {
      id: 'msg_3',
      sessionId: 'chat_group_1',
      senderName: 'Elena Rostova',
      senderInitials: 'EL',
      avatarBg: 'bg-sky-600',
      isSelf: true,
      content: '白底配浅蓝强调色（#0284C7 与 #F0F7FF），配合 1px 细线排版，信息密度很高且没有冗余的卡片堆叠。',
      timestamp: '14:32',
      status: 'read',
    },
  ],
  chat_user_2: [
    {
      id: 'msg_u2_1',
      sessionId: 'chat_user_2',
      senderName: 'Marcus K.',
      senderInitials: 'MK',
      avatarBg: 'bg-slate-800',
      isSelf: false,
      content: 'Pinia 状态管理分为了 data-sources、stores 和 mocks 三层，架构很清晰。',
      timestamp: '11:05',
    },
  ],
};
