/**
 * 墨阅 · 核心领域模型
 *
 * 这一层是「事实来源」：Android 端（Kotlin）与 Web 验证器（TypeScript）保持字段语义一一对应，
 * 便于两端算法行为互相校验。字段命名刻意保持直白，避免两端认知漂移。
 */

/** 书籍来源格式。PDF 在两端都只做整页渲染，不参与重排。 */
export type BookFormat = 'txt' | 'epub' | 'pdf'

/** 文本编码。'auto' 表示由 detectEncoding 推断。 */
export type TextEncoding = 'utf-8' | 'gb18030' | 'utf-16le' | 'utf-16be'

/** 阅读主题。纸感暖色为默认基调。 */
export type ThemeId = 'paper' | 'sepia' | 'green' | 'night' | 'ink'

/** 翻页方式。 */
export type PageMode = 'simulation' | 'slide' | 'cover' | 'scroll' | 'none'

/** 书籍分组（书架分类）。 */
export interface BookGroup {
  id: string
  name: string
  /** 分组色，用于书架上的标签底色 */
  color: string
  createdAt: number
}

/**
 * 一本书。
 *
 * 设计要点：书籍内容不整体入库，只在 chapters 表里按章保存；
 * 每章记录 `start`（该章在原始文档中的字符偏移），
 * 因此「全局字符偏移」成为进度、书签、笔记、搜索结果的统一坐标系。
 */
export interface Book {
  id: string
  title: string
  author: string
  /** 简介 */
  intro: string
  format: BookFormat
  encoding: TextEncoding
  /** 封面图 dataURL 或资源路径；为空时用程序生成的渐变书脊封面 */
  cover?: string
  /** 全书字符数（不含被剥离的 HTML 标签） */
  charCount: number
  chapterCount: number
  /** 原始文档的总字符长度，用于进度百分比换算与偏移校验 */
  sourceLength: number
  groupId?: string
  /** 是否已读完 */
  finished: boolean
  /** 加入书架时间 */
  addedAt: number
  /** 最后阅读时间，用于「最近阅读」排序 */
  lastReadAt: number
  /** SAF 持久化 URI（Android）或 IndexedDB key（Web） */
  sourceRef?: string
}

/** 章节。`start` 是在原始文档中的字符偏移，`title` 已去除首尾空白。 */
export interface Chapter {
  bookId: string
  /** 章序号，从 0 开始 */
  index: number
  title: string
  /** 该章正文内容 */
  content: string
  /** 该章在原始文档中的字符偏移 */
  start: number
  /** 该章字符数 */
  length: number
  /** 是否由分章算法识别出的真实章节标题（false 表示是强制切分的兜底块） */
  detected: boolean
}

/**
 * 阅读位置。
 *
 * 用 `chapterIndex` + `chapterOffset` 定位，同时冗余保存 `globalOffset`，
 * 以便在重新分章（例如换解析策略）后仍能尽量还原位置。
 */
export interface ReadingPosition {
  chapterIndex: number
  /** 章内字符偏移 */
  chapterOffset: number
  /** 全书字符偏移 */
  globalOffset: number
  /** 该位置对应的页码（按当前排版计算） */
  pageIndex: number
  /** 全书进度 0..1 */
  percent: number
  updatedAt: number
}

/** 书签。 */
export interface Bookmark {
  id: string
  bookId: string
  chapterIndex: number
  chapterOffset: number
  globalOffset: number
  /** 书签摘录的上下文文本，便于在列表里辨认 */
  excerpt: string
  /** 用户备注 */
  note: string
  createdAt: number
}

/** 划线。`endOffset` 为章内右开区间。 */
export interface Highlight {
  id: string
  bookId: string
  chapterIndex: number
  startOffset: number
  endOffset: number
  /** 划线文本内容 */
  text: string
  /** 划线颜色，取自主题强调色集合 */
  color: string
  note: string
  createdAt: number
}

/** 一次连续阅读会话，用于统计时长。 */
export interface ReadingSession {
  id: string
  bookId: string
  startedAt: number
  /** 秒 */
  durationSec: number
  /** 本次会话阅读的字数 */
  charCount: number
}

/** 排版参数，改变后需要重新分页。 */
export interface Typography {
  /** 字号 sp */
  fontSize: number
  /** 行距倍数 */
  lineHeight: number
  /** 段间距倍数 */
  paragraphSpacing: number
  /** 页边距 dp */
  margin: number
  /** 字体系列 key */
  fontFamily: FontFamilyId
  /** 是否两端对齐 */
  justify: boolean
  /** 是否加粗正文 */
  bold: boolean
  /** 首行缩进字数 */
  indent: number
}

export type FontFamilyId = 'serif' | 'sans' | 'kai' | 'song' | 'hei'

/** 阅读器全局设置。 */
export interface ReaderSettings {
  theme: ThemeId
  pageMode: PageMode
  typography: Typography
  /** 护眼色温 0..1，0 为关闭 */
  eyeCareWarmth: number
  /** 应用内亮度 0..1，null 表示跟随系统 */
  brightness: number | null
  /** 自动阅读速度：每秒字符数 */
  autoReadSpeed: number
  /** TTS 语速 0.5..2.0 */
  ttsRate: number
  /** TTS 音调 0..2 */
  ttsPitch: number
  /** 是否常亮 */
  keepScreenOn: boolean
  /** 是否显示顶部状态栏信息 */
  showStatusBar: boolean
  /** 是否使用 Material You 动态取色（Android 12+） */
  dynamicColor: boolean
  /** 是否跟随系统深色模式 */
  followSystemDark: boolean
}

export const DEFAULT_TYPOGRAPHY: Typography = {
  fontSize: 19,
  lineHeight: 1.7,
  paragraphSpacing: 0.8,
  margin: 22,
  fontFamily: 'serif',
  justify: true,
  bold: false,
  indent: 2,
}

export const DEFAULT_SETTINGS: ReaderSettings = {
  theme: 'paper',
  pageMode: 'simulation',
  typography: DEFAULT_TYPOGRAPHY,
  eyeCareWarmth: 0,
  brightness: null,
  autoReadSpeed: 28,
  ttsRate: 1.0,
  ttsPitch: 1.0,
  keepScreenOn: false,
  showStatusBar: true,
  dynamicColor: true,
  followSystemDark: false,
}

/** 主题配色。`paper` 与 `sepia` 是纸感暖色的两级；`night` 为深色。 */
export interface ThemePalette {
  id: ThemeId
  name: string
  /** 阅读页背景 */
  background: string
  /** 阅读页正文色 */
  text: string
  /** 次要文字（页码、章节名） */
  textSecondary: string
  /** 界面主色（工具栏、按钮） */
  primary: string
  /** 界面背景（书架、设置页） */
  surface: string
  /** 卡片背景 */
  card: string
  /** 分割线 */
  divider: string
  /** 是否为深色主题 */
  dark: boolean
  /** 是否适合长时间阅读 */
  eyeFriendly: boolean
}

export const THEMES: Record<ThemeId, ThemePalette> = {
  paper: {
    id: 'paper',
    name: '纸白',
    background: '#F7F3EA',
    text: '#33302B',
    textSecondary: '#8C8377',
    primary: '#8A6A46',
    surface: '#FBF8F2',
    card: '#FFFFFF',
    divider: '#E7E0D3',
    dark: false,
    eyeFriendly: true,
  },
  sepia: {
    id: 'sepia',
    name: '羊皮',
    background: '#F0E4CC',
    text: '#4A3F2F',
    textSecondary: '#9A8A70',
    primary: '#967A50',
    surface: '#F6EEDC',
    card: '#FFFBF2',
    divider: '#E0D2B6',
    dark: false,
    eyeFriendly: true,
  },
  green: {
    id: 'green',
    name: '青竹',
    background: '#DCE8DA',
    text: '#2F3A2E',
    textSecondary: '#6E7C6C',
    primary: '#4E7A4A',
    surface: '#E6EFE4',
    card: '#F5FAF3',
    divider: '#C9D8C6',
    dark: false,
    eyeFriendly: true,
  },
  night: {
    id: 'night',
    name: '夜幕',
    background: '#16171A',
    text: '#B9BCC2',
    textSecondary: '#71757D',
    primary: '#8FA6C4',
    surface: '#1D1F23',
    card: '#24262B',
    divider: '#31343A',
    dark: true,
    eyeFriendly: true,
  },
  ink: {
    id: 'ink',
    name: '墨黑',
    background: '#000000',
    text: '#9BA0A6',
    textSecondary: '#5E646B',
    primary: '#7C93B0',
    surface: '#0C0D0F',
    card: '#15171A',
    divider: '#242629',
    dark: true,
    eyeFriendly: false,
  },
}

/** 字体族映射。Android 端使用自有字体资源，Web 端退回系统可用字体。 */
export const FONT_STACKS: Record<FontFamilyId, { name: string; css: string }> = {
  serif: { name: '宋体衬线', css: '"Songti SC", "SimSun", "Noto Serif CJK SC", serif' },
  sans: { name: '无衬线', css: '"PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif' },
  kai: { name: '楷体', css: '"Kaiti SC", "KaiTi", "STKaiti", serif' },
  song: { name: '思源宋', css: '"Source Han Serif SC", "Noto Serif CJK SC", "SimSun", serif' },
  hei: { name: '黑体', css: '"Source Han Sans SC", "Noto Sans CJK SC", "SimHei", sans-serif' },
}
