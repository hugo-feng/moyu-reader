/**
 * 分页引擎。
 *
 * 主流小说 App 的翻页观感依赖「按实际排版测量分页」，而不是按固定字数切。
 * 但逐字测量在移动端会卡顿，因此这里采用**可注入测量器 + 二分查找**的方案：
 *
 *   - 测量器是一个纯函数 `(text, style) => width`，Web 端由 Canvas `measureText`
 *     提供精确值，Android 端由 `StaticLayout` 提供；测试中注入确定性测量器，
 *     于是分页逻辑可以被完整单元测试，无需真实渲染。
 *   - 每行用二分查找求出「本行最多容纳多少字符」，把 O(字数) 次测量降到 O(行数 · log 行宽)。
 *   - 输出为「页码 → 字符区间」的索引表，任何全局字符偏移都能 O(1) 反查页码，
 *     这也是进度、书签、笔记、搜索结果能统一跳转的基础。
 */

import type { Typography } from './types'

export interface PageSlice {
  /** 从 0 开始的页码（章内） */
  index: number
  /** 页首字符在章内的偏移 */
  start: number
  /** 页尾字符在章内的偏移（右开区间） */
  end: number
}

export interface LayoutMetrics {
  /** 可用正文宽度（像素/dp） */
  contentWidth: number
  /** 可用正文高度 */
  contentHeight: number
  /** 单行高度 */
  lineHeight: number
}

export type MeasureText = (text: string) => number

/**
 * 从排版参数推导度量。行高按「字号 × 行距倍数」计算，
 * 这是中文阅读器的主流做法（避免西文式的行间额外留白）。
 */
export function metricsFromTypography(
  typography: Typography,
  viewportWidth: number,
  viewportHeight: number,
  /** 顶栏/底栏占用的高度，分页时扣除 */
  chromeHeight = 0,
  /** 屏幕密度缩放：字号 sp → px */
  density = 1,
): LayoutMetrics {
  const fontSizePx = typography.fontSize * density
  const marginPx = typography.margin * density
  return {
    contentWidth: Math.max(1, viewportWidth - marginPx * 2),
    contentHeight: Math.max(1, viewportHeight - chromeHeight - marginPx),
    lineHeight: Math.max(1, fontSizePx * typography.lineHeight),
  }
}

/** 单行最大字符数上限，防止病态测量器导致死循环。 */
const MAX_CHARS_PER_LINE = 4096

/**
 * 用二分查找求一行能容纳的最大字符数。
 * 返回值至少为 1，保证任何输入都能推进，不会死循环。
 */
function fitCharsInLine(text: string, start: number, limit: number, maxWidth: number, measure: MeasureText): number {
  const available = limit - start
  if (available <= 0) return 0

  const single = text.charCodeAt(start)
  // 换行符本身就是行边界，交给调用方处理
  if (single === 0x0a) return 0

  if (measure(text.substring(start, start + 1)) > maxWidth) {
    // 单个字符就超宽（极端窄屏或超大字号）：仍占一行，避免死循环
    return 1
  }

  let lo = 1
  let hi = Math.min(available, MAX_CHARS_PER_LINE)

  // 先快速探测 hi 是否可行，可行则直接返回，省掉二分
  if (measure(text.substring(start, start + hi)) <= maxWidth) return hi

  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (measure(text.substring(start, start + mid)) <= maxWidth) {
      lo = mid
    } else {
      hi = mid - 1
    }
  }
  return Math.max(1, lo)
}

/**
 * 把一章正文分页。
 *
 * 语义定义（这是正确性的关键，之前曾在这里出过 bug）：
 *   - 一个「行」是 `\n` 之前的内容；`\n` 是这一行的**终止符**，不是额外的一行。
 *     因此 `"A\nB"` 是 2 行，而不是 3 行。
 *   - 连续的多个 `\n`（空行）折叠为**一个段落间距**，只占 1 行。
 *     阅读器用 CSS 的段间距来表现留白，若按字面每个空行都占一行，
 *     页数会严重虚高（中文小说里每段后都有换行）。
 *   - 超宽的一行会跨越多页，页边界落在行中间。
 *
 * `maxLinesOverride` 用于让调用方强制每页行数（测试与「每页行数」设置项使用）。
 */
export function paginateChapter(
  content: string,
  metrics: LayoutMetrics,
  measure: MeasureText,
  maxLinesOverride?: number,
): PageSlice[] {
  const pages: PageSlice[] = []
  if (content.length === 0) {
    return [{ index: 0, start: 0, end: 0 }]
  }

  const maxLines =
    maxLinesOverride && maxLinesOverride > 0
      ? maxLinesOverride
      : Math.max(1, Math.floor(metrics.contentHeight / metrics.lineHeight))

  const len = content.length
  let cursor = 0
  let pageStart = 0
  let linesOnPage = 0

  /** 提交一页（右开区间），并重置行计数。 */
  const commit = (endExclusive: number) => {
    pages.push({ index: pages.length, start: pageStart, end: endExclusive })
    pageStart = endExclusive
    linesOnPage = 0
  }

  while (cursor < len) {
    if (content.charCodeAt(cursor) === 0x0a) {
      // 空行：折叠为一个段落间距，占 1 行
      linesOnPage++
      cursor++
      if (linesOnPage >= maxLines && cursor < len) commit(cursor)
      continue
    }

    let lineEnd = content.indexOf('\n', cursor)
    if (lineEnd === -1) lineEnd = len

    if (lineEnd === cursor) {
      // 行首即换行（空行），交给下一轮处理
      cursor++
      continue
    }

    // 逐段消费这一行，直到整行排完（超宽行会跨页）
    let segStart = cursor
    while (segStart < lineEnd) {
      const take = fitCharsInLine(content, segStart, lineEnd, metrics.contentWidth, measure)
      if (take <= 0) {
        // 测量器异常：强制推进一个字符，杜绝死循环
        segStart++
        continue
      }
      const segEnd = segStart + take
      linesOnPage++
      if (linesOnPage >= maxLines && segEnd < len) {
        commit(segEnd)
      }
      segStart = segEnd
    }

    cursor = segStart
    // 消费行终止符（若有）。它不额外占行，但要计入已消费范围。
    if (cursor < len && content.charCodeAt(cursor) === 0x0a) {
      cursor++
      if (linesOnPage >= maxLines && cursor < len) commit(cursor)
    }
  }

  if (pageStart < len || pages.length === 0) {
    pages.push({ index: pages.length, start: pageStart, end: len })
  }

  return pages
}

/**
 * 按固定「每页字符数」粗暴分页。
 * 仅作为测量不可用时的降级路径，或在超大章节上做快速预览。
 */
export function paginateByCharBudget(content: string, charsPerPage: number): PageSlice[] {
  const pages: PageSlice[] = []
  const budget = Math.max(1, Math.floor(charsPerPage))
  let start = 0
  while (start < content.length) {
    let end = Math.min(start + budget, content.length)
    // 尽量在换行处收尾，避免句子被切断
    if (end < content.length) {
      const nl = content.indexOf('\n', end)
      const prevNl = content.lastIndexOf('\n', end)
      if (prevNl > start) end = prevNl + 1
      else if (nl !== -1 && nl - end < budget * 0.2) end = nl + 1
    }
    pages.push({ index: pages.length, start, end })
    start = end
  }
  if (pages.length === 0) pages.push({ index: 0, start: 0, end: 0 })
  return pages
}

/** 二分查找：给定章内字符偏移，返回它所在的页序号。 */
export function pageIndexForOffset(pages: PageSlice[], offset: number): number {
  if (pages.length === 0) return 0
  if (offset <= 0) return 0
  let lo = 0
  let hi = pages.length - 1
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2)
    if (pages[mid].end <= offset) {
      lo = mid + 1
    } else {
      hi = mid
    }
  }
  return lo
}

/** 取指定页的正文切片。 */
export function pageText(content: string, page: PageSlice): string {
  return content.slice(page.start, page.end)
}

/** 章节分页结果的缓存键：排版参数任一变化都应导致缓存失效。 */
export function paginationCacheKey(typography: Typography, metrics: LayoutMetrics, extra = ''): string {
  return [
    typography.fontSize,
    typography.lineHeight,
    typography.paragraphSpacing,
    typography.margin,
    typography.fontFamily,
    typography.justify ? 1 : 0,
    typography.bold ? 1 : 0,
    typography.indent,
    Math.round(metrics.contentWidth),
    Math.round(metrics.contentHeight),
    extra,
  ].join('|')
}

/**
 * 估算「一屏大约多少字」，用于导入时预估页数与阅读时长。
 * 中日韩字符按 1 个宽度单位计，ASCII 按 0.5 计 —— 与主流阅读器的估算口径一致。
 */
export function estimateCharsPerScreen(metrics: LayoutMetrics, fontSize: number): number {
  const charsPerLine = metrics.contentWidth / fontSize
  const lines = metrics.contentHeight / metrics.lineHeight
  return Math.max(1, Math.floor(charsPerLine * lines))
}

/**
 * 中文文本的视觉宽度权重：CJK/全角记 1，其余记 0.5。
 * 供字数统计与阅读时长估算使用（比 length 更贴近真实阅读量）。
 */
export function visualWeight(text: string): number {
  let weight = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c === 0x0a || c === 0x0d || c === 0x20 || c === 0x09) continue
    if (c >= 0x1100 && c <= 0x115f) weight += 1
    else if (c >= 0x2e80 && c <= 0xa4cf) weight += 1
    else if (c >= 0xac00 && c <= 0xd7a3) weight += 1
    else if (c >= 0xf900 && c <= 0xfaff) weight += 1
    else if (c >= 0xfe30 && c <= 0xfe6f) weight += 1
    else if (c >= 0xff00 && c <= 0xff60) weight += 1
    else if (c >= 0xffe0 && c <= 0xffe6) weight += 1
    else weight += 0.5
  }
  return weight
}
