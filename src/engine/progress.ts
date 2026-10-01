/**
 * 阅读进度与位置换算。
 *
 * 所有进度都建立在「全局字符偏移」这一唯一坐标系上：
 *   全局偏移 = chapter.start + 章内偏移
 * 由此可以无损地在「全书百分比 / 章节 + 章内偏移 / 页码」之间往返换算，
 * 书签、笔记、搜索结果、跳转全部共用这一套换算，不会出现「跳过去差几页」的问题。
 */

import type { Book, Chapter, ReadingPosition } from './types'
import { pageIndexForOffset, visualWeight, type PageSlice } from './pagination'

/** 全书总字符数（按章节长度累加，避免依赖 Book.charCount 可能未及时更新的情况）。 */
export function totalCharCount(chapters: Chapter[]): number {
  let sum = 0
  for (const c of chapters) sum += c.length
  return sum
}

/** 由「章号 + 章内偏移」构造完整阅读位置。 */
export function makePosition(
  _bookId: string,
  chapters: Chapter[],
  chapterIndex: number,
  chapterOffset: number,
  pages?: PageSlice[],
): ReadingPosition {
  const safeIndex = clampChapterIndex(chapters, chapterIndex)
  const chapter = chapters[safeIndex]
  const safeOffset = chapter ? clamp(chapterOffset, 0, chapter.length) : 0
  const globalOffset = chapter ? chapter.start + safeOffset : 0
  const total = totalCharCount(chapters)
  const pageIndex = pages ? pageIndexForOffset(pages, safeOffset) : 0

  return {
    chapterIndex: safeIndex,
    chapterOffset: safeOffset,
    globalOffset,
    pageIndex,
    percent: total > 0 ? clamp(globalOffset / total, 0, 1) : 0,
    updatedAt: Date.now(),
  }
}

/** 由全局偏移反推完整阅读位置。 */
export function positionFromGlobalOffset(
  _bookId: string,
  chapters: Chapter[],
  globalOffset: number,
): ReadingPosition {
  const total = totalCharCount(chapters)
  const offset = clamp(globalOffset, 0, total)
  const index = chapterIndexForGlobalOffset(chapters, offset)
  const chapter = chapters[index]
  const chapterOffset = chapter ? clamp(offset - chapter.start, 0, chapter.length) : 0
  return {
    chapterIndex: index,
    chapterOffset,
    globalOffset: offset,
    pageIndex: 0,
    percent: total > 0 ? offset / total : 0,
    updatedAt: Date.now(),
  }
}

/** 二分查找全局偏移落在哪一章。 */
export function chapterIndexForGlobalOffset(chapters: Chapter[], globalOffset: number): number {
  if (chapters.length === 0) return 0
  let lo = 0
  let hi = chapters.length - 1
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2)
    if (chapters[mid].start <= globalOffset) lo = mid
    else hi = mid - 1
  }
  return lo
}

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min
  return Math.min(Math.max(value, min), max)
}

function clampChapterIndex(chapters: Chapter[], index: number): number {
  if (chapters.length === 0) return 0
  return clamp(Math.floor(index), 0, chapters.length - 1)
}

/** 全书已读百分比（0..100，保留一位小数）。 */
export function progressPercent(chapters: Chapter[], globalOffset: number): number {
  const total = totalCharCount(chapters)
  if (total <= 0) return 0
  return Math.round(clamp(globalOffset / total, 0, 1) * 1000) / 10
}

/**
 * 剩余阅读时长估算。
 *
 * 采用中文阅读的通行口径：约 400 字/分钟（≈6.7 字/秒）。
 * 用 `visualWeight` 而非 `length` 计数，避免大量英文/标点导致高估。
 */
export const DEFAULT_READING_SPEED_CHARS_PER_MINUTE = 400

export function estimateReadingMinutes(
  chapters: Chapter[],
  fromGlobalOffset: number,
  charsPerMinute = DEFAULT_READING_SPEED_CHARS_PER_MINUTE,
): number {
  const total = totalCharCount(chapters)
  const remaining = Math.max(0, total - fromGlobalOffset)
  const weight = (remaining / total) * visualWeightWeightedTotal(chapters)
  if (charsPerMinute <= 0) return 0
  return Math.max(0, Math.round(weight / charsPerMinute))
}

/** 全书视觉字数（CJK 记 1，ASCII 记 0.5），供时长估算使用。 */
function visualWeightWeightedTotal(chapters: Chapter[]): number {
  let sum = 0
  for (const c of chapters) sum += visualWeight(c.content)
  return sum
}

/** 把分钟数格式化为「3 小时 12 分钟」这类可读文案。 */
export function formatDuration(minutes: number): string {
  if (minutes <= 0) return '不到 1 分钟'
  if (minutes < 60) return `${minutes} 分钟`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m === 0 ? `${h} 小时` : `${h} 小时 ${m} 分钟`
}

/**
 * 进度摘要，直接供书架卡片渲染。
 * `finished` 的判定用相对阈值而非绝对相等，避免因排版取整永远到不了 100%。
 */
export interface ProgressSummary {
  percent: number
  /** 形如「第 12 章 · 34%」 */
  label: string
  finished: boolean
  remainingMinutes: number
  remainingLabel: string
}

export function summarizeProgress(
  chapters: Chapter[],
  chapterIndex: number,
  status: 'reading' | 'finished' | 'unread' = 'reading',
): ProgressSummary {
  if (chapters.length === 0) {
    return { percent: 0, label: '无章节', finished: false, remainingMinutes: 0, remainingLabel: '' }
  }
  const index = clampChapterIndex(chapters, chapterIndex)
  const chapter = chapters[index]
  const total = totalCharCount(chapters)
  const percent = total > 0 ? Math.round((chapter.start / total) * 1000) / 10 : 0
  const finished = status === 'finished' || percent >= 99.5
  const remainingMinutes = estimateReadingMinutes(chapters, chapter.start)

  const label = finished
    ? '已读完'
    : status === 'unread'
      ? '未开始'
      : `第 ${index + 1} 章 · ${percent.toFixed(1)}%`

  return {
    percent: finished ? 100 : percent,
    label,
    finished,
    remainingMinutes,
    remainingLabel: finished ? '' : `约剩 ${formatDuration(remainingMinutes)}`,
  }
}

/**
 * 从旧位置迁移到重新分章后的位置。
 * 用于「用户在阅读中途修改了分章策略」或「重新导入同一本书」的场景：
 * 以全局偏移为锚点，找最接近的章节。
 */
export function relocatePosition(chapters: Chapter[], previous: ReadingPosition): ReadingPosition {
  return positionFromGlobalOffset('', chapters, previous.globalOffset)
}

/** 判断两个位置是否在同一页（用于避免无意义的持久化写入与动画抖动）。 */
export function isSamePage(a: ReadingPosition, b: ReadingPosition): boolean {
  return a.chapterIndex === b.chapterIndex && a.pageIndex === b.pageIndex
}

/** 书籍是否已读完（供书架过滤「已读完」使用）。 */
export function isBookFinished(book: Book, chapters: Chapter[], position?: ReadingPosition): boolean {
  if (book.finished) return true
  if (!position) return false
  const total = totalCharCount(chapters)
  if (total <= 0) return false
  return position.globalOffset >= total * 0.995
}
