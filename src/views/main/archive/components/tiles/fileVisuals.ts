import type { Component } from 'vue';
import {
  Database,
  File,
  FileArchive,
  FileCode,
  FileText,
  Image,
  Music,
  Terminal,
  Video,
} from '@lucide/vue';
import type { FileCategory } from '../../types/tile';

/**
 * 全站统一的文件视觉语言：
 * - tint / color：磁贴本体的淡色底与图标色（FileTile、文件夹内迷你磁贴）
 * - solidBg / solidIcon：文件夹缩略图里的实色小方块
 */
export interface FileVisual {
  icon: Component;
  tint: string;
  color: string;
  solidBg: string;
  solidIcon: string;
  badge: string;
}

export const FILE_VISUALS: Record<FileCategory, FileVisual> = {
  pdf: {
    icon: FileText,
    tint: 'bg-rose-500/10',
    color: 'text-rose-400',
    solidBg: 'bg-gradient-to-br from-rose-500 to-red-600 shadow-sm shadow-rose-950/40',
    solidIcon: 'text-white',
    badge: 'PDF',
  },
  doc: {
    icon: FileText,
    tint: 'bg-blue-500/10',
    color: 'text-blue-400',
    solidBg: 'bg-gradient-to-br from-blue-500 to-indigo-600 shadow-sm shadow-blue-950/40',
    solidIcon: 'text-white',
    badge: 'DOC',
  },
  code: {
    icon: FileCode,
    tint: 'bg-emerald-500/10',
    color: 'text-emerald-400',
    solidBg: 'bg-[#18181b] border border-white/10 shadow-sm shadow-slate-950/50',
    solidIcon: 'text-emerald-400',
    badge: 'CODE',
  },
  image: {
    icon: Image,
    tint: 'bg-purple-500/10',
    color: 'text-purple-400',
    solidBg: 'bg-gradient-to-br from-cyan-400 to-teal-500 shadow-sm shadow-cyan-950/40',
    solidIcon: 'text-white',
    badge: 'IMG',
  },
  archive: {
    icon: FileArchive,
    tint: 'bg-amber-500/10',
    color: 'text-amber-400',
    solidBg: 'bg-gradient-to-br from-amber-500 to-yellow-600 shadow-sm shadow-amber-950/40',
    solidIcon: 'text-white',
    badge: 'ZIP',
  },
  audio: {
    icon: Music,
    tint: 'bg-teal-500/10',
    color: 'text-teal-400',
    solidBg: 'bg-gradient-to-br from-purple-500 to-indigo-600 shadow-sm shadow-purple-950/40',
    solidIcon: 'text-white',
    badge: 'AUDIO',
  },
  video: {
    icon: Video,
    tint: 'bg-pink-500/10',
    color: 'text-pink-400',
    solidBg: 'bg-gradient-to-br from-rose-500 to-pink-600 shadow-sm shadow-pink-950/40',
    solidIcon: 'text-white',
    badge: 'VIDEO',
  },
  data: {
    icon: Database,
    tint: 'bg-cyan-500/10',
    color: 'text-cyan-400',
    solidBg: 'bg-gradient-to-br from-sky-500 to-blue-600 shadow-sm shadow-sky-950/40',
    solidIcon: 'text-white',
    badge: 'DATA',
  },
  exec: {
    icon: Terminal,
    tint: 'bg-orange-500/10',
    color: 'text-orange-400',
    solidBg: 'bg-gradient-to-br from-amber-500 to-orange-600 shadow-sm shadow-orange-950/40',
    solidIcon: 'text-white',
    badge: 'APP',
  },
  text: {
    icon: FileText,
    tint: 'bg-sky-500/10',
    color: 'text-sky-300',
    solidBg: 'bg-slate-100 shadow-sm shadow-black/20',
    solidIcon: 'text-slate-800',
    badge: 'TXT',
  },
  generic: {
    icon: File,
    tint: 'bg-slate-500/10',
    color: 'text-slate-300',
    solidBg: 'bg-slate-700/80 shadow-sm shadow-slate-950/40',
    solidIcon: 'text-white/90',
    badge: 'FILE',
  },
};

export function getFileVisual(fileType: FileCategory | undefined): FileVisual {
  if (!fileType) return FILE_VISUALS.generic;
  return FILE_VISUALS[fileType] ?? FILE_VISUALS.generic;
}
