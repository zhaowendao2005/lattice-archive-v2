import type { SearchCategoryOption } from '../types';

export const SEARCH_CATEGORY_OPTIONS: SearchCategoryOption[] = [
  {
    value: 'video',
    label: '视频',
    shortCode: 'VID',
    description: 'MP4 / MKV / WebM 录屏、技术演示与流媒体片段',
  },
  {
    value: 'image',
    label: '图片',
    shortCode: 'IMG',
    description: 'PNG / WebP / SVG 架构图、设计原稿与相册快照',
  },
  {
    value: 'text',
    label: '文档',
    shortCode: 'TXT',
    description: 'Markdown 笔记、代码源文件、JSON/YAML 配置与 PDF 文档',
  },
  {
    value: 'other',
    label: '其他',
    shortCode: 'EXT',
    description: '普通消息及其他附件',
  },
];
