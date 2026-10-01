/**
 * 图标集（lucide-react 适配层）。
 *
 * 这里不再维护自己的 SVG 路径：图标全部来自开源库 lucide-react，
 * 我们只做一层极薄的适配，目的有三个 ——
 *
 *   1. **调用点零改动**：对外仍然导出同一批 `IconXxx` 名字，
 *      所有页面不必改 import 列表，也不必记住 lucide 的命名；
 *   2. **视觉口径统一**：尺寸默认 22（移动端触摸友好）、线宽默认 1.7，
 *      与项目既有的纸感风格保持一致，不会因为某个调用点漏填参数而走形；
 *   3. **换库成本收敛到一个文件**：将来若换图标库，只改这里。
 *
 * 图标一律使用 currentColor，因此颜色由父级 `color` 决定；
 * 需要「实心」观感的图标（书签激活态、播放/暂停）额外传 `fill="currentColor"`。
 *
 * 名字 → lucide 图标的对应关系见各导出项上方的注释。
 */

import type { CSSProperties } from 'react'
import {
  ArrowUpDown,
  BookA,
  Bookmark,
  ChartColumn,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Eye,
  Folder,
  Layers,
  LayoutGrid,
  Library,
  Lightbulb,
  List,
  Menu,
  MessageSquareText,
  Minus,
  Moon,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings,
  StickyNote,
  Sun,
  Trash,
  Type,
  Upload,
  Volume2,
  X,
} from 'lucide-react'

export interface IconProps {
  size?: number
  className?: string
  style?: CSSProperties
  strokeWidth?: number
}

/** 书架：lucide `library` 的整排竖立书脊与原手绘图标几乎同形。 */
export const IconShelf = (p: IconProps) => (
  <Library size={p.size ?? 22} className={p.className} style={p.style} strokeWidth={p.strokeWidth ?? 1.7} />
)

/** 统计：柱状图。lucide 把 `BarChart3` 重命名为 `ChartColumn`，用规范名。 */
export const IconStats = (p: IconProps) => (
  <ChartColumn size={p.size ?? 22} className={p.className} style={p.style} strokeWidth={p.strokeWidth ?? 1.7} />
)

/** 笔记列表：带文字的便签。 */
export const IconNotes = (p: IconProps) => (
  <StickyNote size={p.size ?? 22} className={p.className} style={p.style} strokeWidth={p.strokeWidth ?? 1.7} />
)

/** 设置：齿轮。 */
export const IconSettings = (p: IconProps) => (
  <Settings size={p.size ?? 22} className={p.className} style={p.style} strokeWidth={p.strokeWidth ?? 1.7} />
)

/** 返回：左向尖括号。 */
export const IconBack = (p: IconProps) => (
  <ChevronLeft size={p.size ?? 22} className={p.className} style={p.style} strokeWidth={p.strokeWidth ?? 1.7} />
)

/** 搜索：放大镜。 */
export const IconSearch = (p: IconProps) => (
  <Search size={p.size ?? 22} className={p.className} style={p.style} strokeWidth={p.strokeWidth ?? 1.7} />
)

/** 关闭：叉号。 */
export const IconClose = (p: IconProps) => (
  <X size={p.size ?? 22} className={p.className} style={p.style} strokeWidth={p.strokeWidth ?? 1.7} />
)

/** 增加。 */
export const IconPlus = (p: IconProps) => (
  <Plus size={p.size ?? 22} className={p.className} style={p.style} strokeWidth={p.strokeWidth ?? 1.7} />
)

/** 减少。 */
export const IconMinus = (p: IconProps) => (
  <Minus size={p.size ?? 22} className={p.className} style={p.style} strokeWidth={p.strokeWidth ?? 1.7} />
)

/** 菜单：三条横线。 */
export const IconMenu = (p: IconProps) => (
  <Menu size={p.size ?? 22} className={p.className} style={p.style} strokeWidth={p.strokeWidth ?? 1.7} />
)

/** 目录/列表。 */
export const IconList = (p: IconProps) => (
  <List size={p.size ?? 22} className={p.className} style={p.style} strokeWidth={p.strokeWidth ?? 1.7} />
)

/** 网格布局。 */
export const IconGrid = (p: IconProps) => (
  <LayoutGrid size={p.size ?? 22} className={p.className} style={p.style} strokeWidth={p.strokeWidth ?? 1.7} />
)

/** 书签（描边态）。 */
export const IconBookmark = (p: IconProps) => (
  <Bookmark size={p.size ?? 22} className={p.className} style={p.style} strokeWidth={p.strokeWidth ?? 1.7} />
)

/** 书签（激活态）：与描边态同一形状，额外填充 currentColor 使其为实心。 */
export const IconBookmarkFilled = (p: IconProps) => (
  <Bookmark
    size={p.size ?? 22}
    className={p.className}
    style={p.style}
    strokeWidth={p.strokeWidth ?? 1.7}
    fill="currentColor"
  />
)

/** 行内笔记/批注：带文字的对话气泡。 */
export const IconNote = (p: IconProps) => (
  <MessageSquareText size={p.size ?? 22} className={p.className} style={p.style} strokeWidth={p.strokeWidth ?? 1.7} />
)

/** 删除。lucide `trash` 即原 `Trash2` 形状，用规范名。 */
export const IconTrash = (p: IconProps) => (
  <Trash size={p.size ?? 22} className={p.className} style={p.style} strokeWidth={p.strokeWidth ?? 1.7} />
)

/** 编辑：铅笔。 */
export const IconEdit = (p: IconProps) => (
  <Pencil size={p.size ?? 22} className={p.className} style={p.style} strokeWidth={p.strokeWidth ?? 1.7} />
)

/** 日间模式：太阳。 */
export const IconSun = (p: IconProps) => (
  <Sun size={p.size ?? 22} className={p.className} style={p.style} strokeWidth={p.strokeWidth ?? 1.7} />
)

/** 夜间模式：月亮。 */
export const IconMoon = (p: IconProps) => (
  <Moon size={p.size ?? 22} className={p.className} style={p.style} strokeWidth={p.strokeWidth ?? 1.7} />
)

/** 右向箭头。 */
export const IconArrowRight = (p: IconProps) => (
  <ChevronRight size={p.size ?? 22} className={p.className} style={p.style} strokeWidth={p.strokeWidth ?? 1.7} />
)

/** 左向箭头。 */
export const IconArrowLeft = (p: IconProps) => (
  <ChevronLeft size={p.size ?? 22} className={p.className} style={p.style} strokeWidth={p.strokeWidth ?? 1.7} />
)

/** 勾选。 */
export const IconCheck = (p: IconProps) => (
  <Check size={p.size ?? 22} className={p.className} style={p.style} strokeWidth={p.strokeWidth ?? 1.7} />
)

/** 上传/导入。 */
export const IconUpload = (p: IconProps) => (
  <Upload size={p.size ?? 22} className={p.className} style={p.style} strokeWidth={p.strokeWidth ?? 1.7} />
)

/** 朗读：喇叭。 */
export const IconSpeaker = (p: IconProps) => (
  <Volume2 size={p.size ?? 22} className={p.className} style={p.style} strokeWidth={p.strokeWidth ?? 1.7} />
)

/** 暂停（实心）：原图标是两根实心竖条，这里填充 currentColor 让观感一致。 */
export const IconPause = (p: IconProps) => (
  <Pause
    size={p.size ?? 22}
    className={p.className}
    style={p.style}
    strokeWidth={p.strokeWidth ?? 1.7}
    fill="currentColor"
  />
)

/** 播放（实心）。 */
export const IconPlay = (p: IconProps) => (
  <Play
    size={p.size ?? 22}
    className={p.className}
    style={p.style}
    strokeWidth={p.strokeWidth ?? 1.7}
    fill="currentColor"
  />
)

/** 词典：带字母 A 的书本，比原「书 + 横线」更明确地指向查词。 */
export const IconDictionary = (p: IconProps) => (
  <BookA size={p.size ?? 22} className={p.className} style={p.style} strokeWidth={p.strokeWidth ?? 1.7} />
)

/** 文件夹/分组。 */
export const IconFolder = (p: IconProps) => (
  <Folder size={p.size ?? 22} className={p.className} style={p.style} strokeWidth={p.strokeWidth ?? 1.7} />
)

/** 排序。 */
export const IconSort = (p: IconProps) => (
  <ArrowUpDown size={p.size ?? 22} className={p.className} style={p.style} strokeWidth={p.strokeWidth ?? 1.7} />
)

/** 可见性/预览。 */
export const IconEye = (p: IconProps) => (
  <Eye size={p.size ?? 22} className={p.className} style={p.style} strokeWidth={p.strokeWidth ?? 1.7} />
)

/** 提示/技巧。 */
export const IconLightbulb = (p: IconProps) => (
  <Lightbulb size={p.size ?? 22} className={p.className} style={p.style} strokeWidth={p.strokeWidth ?? 1.7} />
)

/** 刷新/重建。 */
export const IconRefresh = (p: IconProps) => (
  <RefreshCw size={p.size ?? 22} className={p.className} style={p.style} strokeWidth={p.strokeWidth ?? 1.7} />
)

/** 展开：下向尖括号。 */
export const IconChevronDown = (p: IconProps) => (
  <ChevronDown size={p.size ?? 22} className={p.className} style={p.style} strokeWidth={p.strokeWidth ?? 1.7} />
)

/** 排版：字型图标。 */
export const IconText = (p: IconProps) => (
  <Type size={p.size ?? 22} className={p.className} style={p.style} strokeWidth={p.strokeWidth ?? 1.7} />
)

/** 分层/多级。 */
export const IconLayers = (p: IconProps) => (
  <Layers size={p.size ?? 22} className={p.className} style={p.style} strokeWidth={p.strokeWidth ?? 1.7} />
)
