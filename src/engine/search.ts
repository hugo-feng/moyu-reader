/**
 * 全文搜索。
 *
 * 小说 App 的搜索有三个刚需：
 *   1. 结果要**按章节分组**，而不是一条平铺列表（否则几千个结果无法浏览）；
 *   2. 每条结果要有**上下文摘录**，并标出关键词位置以便高亮；
 *   3. 要能**一键跳转**到原文位置 —— 这里复用「全局字符偏移」坐标系，
 *      与进度、书签完全一致，因此跳转不需要额外的映射表。
 */

import type { Chapter } from './types'

export interface SearchMatch {
  bookId: string
  chapterIndex: number
  chapterTitle: string
  /** 匹配处在章内的字符偏移 */
  chapterOffset: number
  /** 匹配处在全书的字符偏移 */
  globalOffset: number
  /** 匹配到的原始文本（大小写敏感时为原文） */
  matchedText: string
  /** 摘录片段 */
  excerpt: string
  /** 摘录中关键词相对摘录起点的偏移，用于渲染高亮 */
  excerptMatchOffset: number
  /** 摘录中关键词长度 */
  excerptMatchLength: number
}

export interface SearchOptions {
  /** 是否区分大小写，默认否 */
  caseSensitive?: boolean
  /** 是否全词匹配（仅对 ASCII 生效） */
  wholeWord?: boolean
  /** 摘录关键词前后各取多少字符 */
  contextRadius?: number
  /** 单章最多返回多少条，默认不限 */
  maxPerChapter?: number
  /** 全局最多返回多少条 */
  maxResults?: number
}

export interface ChapterSearchGroup {
  chapterIndex: number
  chapterTitle: string
  matches: SearchMatch[]
}

export interface SearchOutcome {
  query: string
  total: number
  /** 命中过的章节数 */
  chapterHits: number
  groups: ChapterSearchGroup[]
  /** 是否因为 maxResults 被截断 */
  truncated: boolean
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 生成摘录，并把换行压成空格，让结果列表保持单行美观。
 */
function buildExcerpt(
  content: string,
  matchStart: number,
  matchEnd: number,
  radius: number,
): { excerpt: string; matchOffset: number; matchLength: number } {
  let from = Math.max(0, matchStart - radius)
  let to = Math.min(content.length, matchEnd + radius)

  // 不在词语中间截断，尽量向外扩展到标点或换行边界
  while (from > 0 && !isBoundary(content.charCodeAt(from - 1))) from--
  while (to < content.length && !isBoundary(content.charCodeAt(to))) to++

  const raw = content.slice(from, to)
  const matchedText = content.slice(matchStart, matchEnd)

  // 记录关键词在原始切片中的位置，再在压缩换行后重新定位
  const beforeRaw = raw.slice(0, matchStart - from)
  const excerpt = raw.replace(/\s+/g, ' ').trim()

  // 压缩空白后，前缀长度需要重新计算（前导空白已 trim）
  const leadingTrim = raw.replace(/\s+/g, ' ').length - raw.replace(/\s+/g, ' ').trimStart().length
  const compressedBefore = beforeRaw.replace(/\s+/g, ' ').length
  const matchOffset = Math.max(0, compressedBefore - leadingTrim)
  const matchLength = matchedText.replace(/\s+/g, ' ').length

  const prefix = from > 0 ? '…' : ''
  const suffix = to < content.length ? '…' : ''

  return {
    excerpt: `${prefix}${excerpt}${suffix}`,
    matchOffset: matchOffset + prefix.length,
    matchLength: Math.max(1, matchLength),
  }
}

function isBoundary(code: number): boolean {
  // 空白、常见中英文标点视为边界
  if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) return true
  if (code >= 0x21 && code <= 0x2f) return true
  if (code >= 0x3a && code <= 0x40) return true
  if (code >= 0x5b && code <= 0x60) return true
  if (code >= 0x7b && code <= 0x7e) return true
  if (code >= 0x3000 && code <= 0x303f) return true
  if (code >= 0xff00 && code <= 0xff0f) return true
  if (code >= 0xff1a && code <= 0xff20) return true
  return false
}

/**
 * 在全书范围内搜索。
 *
 * 之所以要传 `chapters` 而不是整本书文本：按章搜索可以先命中就停，
 * 且天然产出「按章分组」的结果结构；同时利用 `chapter.start`
 * 把章内偏移换算成全局偏移。
 */
export function searchChapters(
  bookId: string,
  chapters: Chapter[],
  query: string,
  options: SearchOptions = {},
): SearchOutcome {
  const trimmed = query.trim()
  const empty: SearchOutcome = {
    query: trimmed,
    total: 0,
    chapterHits: 0,
    groups: [],
    truncated: false,
  }
  if (trimmed.length === 0) return empty

  const radius = options.contextRadius ?? 28
  const maxPerChapter = options.maxPerChapter ?? Number.POSITIVE_INFINITY
  const maxResults = options.maxResults ?? Number.POSITIVE_INFINITY

  const flags = options.caseSensitive ? 'g' : 'gi'
  let pattern = escapeRegExp(trimmed)
  if (options.wholeWord) {
    // 全词匹配只对「以 ASCII 词字符开头/结尾」的关键词有意义
    const startsWord = /^[A-Za-z0-9_]/.test(trimmed)
    const endsWord = /[A-Za-z0-9_]$/.test(trimmed)
    if (startsWord) pattern = `\\b${pattern}`
    if (endsWord) pattern = `${pattern}\\b`
  }

  let regex: RegExp
  try {
    regex = new RegExp(pattern, flags)
  } catch {
    return empty
  }

  const groups: ChapterSearchGroup[] = []
  let total = 0
  let truncated = false

  for (const chapter of chapters) {
    regex.lastIndex = 0
    const matches: SearchMatch[] = []
    let m: RegExpExecArray | null

    while ((m = regex.exec(chapter.content)) !== null) {
      // 空匹配保护（理论上 escapeRegExp 后不会出现，但防御性处理）
      if (m[0].length === 0) {
        regex.lastIndex++
        continue
      }

      const matchStart = m.index
      const matchEnd = matchStart + m[0].length
      const { excerpt, matchOffset, matchLength } = buildExcerpt(
        chapter.content,
        matchStart,
        matchEnd,
        radius,
      )

      matches.push({
        bookId,
        chapterIndex: chapter.index,
        chapterTitle: chapter.title,
        chapterOffset: matchStart,
        globalOffset: chapter.start + matchStart,
        matchedText: m[0],
        excerpt,
        excerptMatchOffset: matchOffset,
        excerptMatchLength: matchLength,
      })

      total++

      if (matches.length >= maxPerChapter) break
      if (total >= maxResults) {
        truncated = true
        break
      }
    }

    if (matches.length > 0) {
      groups.push({ chapterIndex: chapter.index, chapterTitle: chapter.title, matches })
    }
    if (total >= maxResults) break
  }

  return {
    query: trimmed,
    total,
    chapterHits: groups.length,
    groups,
    truncated,
  }
}

/**
 * 只统计命中数量，不做摘录。用于在章节列表上显示「本章命中 N 处」，
 * 比完整搜索快得多。
 */
export function countMatches(chapters: Chapter[], query: string, caseSensitive = false): Map<number, number> {
  const result = new Map<number, number>()
  const trimmed = query.trim()
  if (trimmed.length === 0) return result

  const regex = new RegExp(escapeRegExp(trimmed), caseSensitive ? 'g' : 'gi')
  for (const chapter of chapters) {
    regex.lastIndex = 0
    let count = 0
    while (regex.exec(chapter.content) !== null) {
      count++
      if (count > 999) break
    }
    if (count > 0) result.set(chapter.index, count)
  }
  return result
}

/**
 * 在正文里标出所有命中区间，供阅读页做关键词高亮。
 * 返回右开区间的偏移数组。
 */
export function locateMatches(content: string, query: string, caseSensitive = false): Array<[number, number]> {
  const trimmed = query.trim()
  if (trimmed.length === 0) return []
  const regex = new RegExp(escapeRegExp(trimmed), caseSensitive ? 'g' : 'gi')
  const spans: Array<[number, number]> = []
  let m: RegExpExecArray | null
  while ((m = regex.exec(content)) !== null) {
    if (m[0].length === 0) {
      regex.lastIndex++
      continue
    }
    spans.push([m.index, m.index + m[0].length])
  }
  return spans
}
