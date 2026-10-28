import panelAlley from './panel-alley.jpg';
import panelCitic from './panel-citic.jpg';
import panelLights from './panel-lights.jpg';
import panelTokyo from './panel-tokyo.jpg';
import bandAlley from './band-alley.jpg';
import bandCitic from './band-citic.jpg';
import bandLights from './band-lights.jpg';
import bandTokyo from './band-tokyo.jpg';
import thumbAlley from './thumb-alley.jpg';
import thumbCitic from './thumb-citic.jpg';
import thumbLights from './thumb-lights.jpg';
import thumbTokyo from './thumb-tokyo.jpg';

/**
 * 登录页壁纸的一张图，配套三套裁切：
 * - `panel`：4:5 竖构图，供桌面/平板横屏的左栏图片面板使用；
 * - `band`：约 1.45:1 横构图，供手机与平板竖屏的顶部图带使用；
 * - `thumb`：方形缩略图，仅供轮替指示点使用。
 *
 * 三者共用同一 `position`（object-position），保证不同裁切下主体不被切掉。
 */
export interface LoginWallpaper {
  id: string;
  /** 壁纸名，用于指示点提示与面板角标 */
  label: string;
  /** 地点或类别，作为副标题 */
  place: string;
  /** 面板主文案 */
  headline: string;
  /** 面板补充说明 */
  caption: string;
  panel: string;
  band: string;
  thumb: string;
  /** 主体视觉重心，避免 cover 裁切切掉塔尖 / 灭点 */
  position: string;
  /** 基础压暗强度 0~1，亮部壁纸取值更高 */
  veil: number;
  /** 底部渐浓强度 0~1，保证面板文案可读 */
  fade: number;
}

export const LOGIN_WALLPAPERS: LoginWallpaper[] = [
  {
    id: 'citic',
    label: '中信大厦',
    place: '北京 · 中央商务区',
    headline: '让散落的文件重新成序',
    caption: '磁贴归档把每一份材料固定在它该在的位置，拖拽即成秩序。',
    panel: panelCitic,
    band: bandCitic,
    thumb: thumbCitic,
    position: '50% 42%',
    veil: 0.3,
    fade: 0.92,
  },
  {
    id: 'tokyo',
    label: '东京夜景',
    place: '東京 · 港区',
    headline: '深夜的同步从不上云',
    caption: '所有数据留在本地 SQLite，断网也能完整检索与翻阅。',
    panel: panelTokyo,
    band: bandTokyo,
    thumb: thumbTokyo,
    position: '50% 50%',
    veil: 0.16,
    fade: 0.88,
  },
  {
    id: 'lights',
    label: '光纤流光',
    place: '长曝光 · 城市光轨',
    headline: '本地优先，毫秒即达',
    caption: 'WAL 模式下的嵌入式引擎，十万条记录依旧瞬时响应。',
    panel: panelLights,
    band: bandLights,
    thumb: thumbLights,
    position: '50% 50%',
    veil: 0.22,
    fade: 0.9,
  },
  {
    id: 'alley',
    label: '老城窄巷',
    place: '高台民居 · 巷道',
    headline: '旧纸也值得被妥善安放',
    caption: '跨端一致的设计令牌，Windows、iPad 与 iPhone 同貌同行。',
    panel: panelAlley,
    band: bandAlley,
    thumb: thumbAlley,
    position: '50% 35%',
    veil: 0.26,
    fade: 0.93,
  },
];

/** 自动轮替间隔（毫秒），进度环动画时长与之保持一致 */
export const WALLPAPER_INTERVAL = 9000;