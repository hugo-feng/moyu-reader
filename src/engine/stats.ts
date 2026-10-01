/**
 * 阅读统计。
 *
 * 参照主流阅读 App 的「周报 / 月报 / 热力图」三件套设计：
 *   - 以「天」为最小聚合单元（本地时区，避免 UTC 跨日错位）；
 *   - 热力图固定 7 行 × N 列（周日起算），与 GitHub / 微信读书一致；
 *   - 连续天数（streak）区分「当前连续」与「历史最长」，两者都要展示。
 *
 * 关键细节：日期键必须按**本地时区**生成，否则用户晚上 11 点读的书
 * 会被算到第二天，热力图会串列。
 */

import type { ReadingSession } from './types'

/** 一天的阅读聚合。 */
export interface DailyStat {
  /** YYYY-MM-DD（本地时区） */
  date: string
  /** 阅读秒数 */
  seconds: number
  /** 阅读字数（视觉字数） */
  chars: number
  /** 涉及的书本数 */
  bookCount: number
  /** 会话次数 */
  sessions: number
}

export interface HeatmapCell {
  date: string
  /** 0..4 强度等级，0 表示无阅读 */
  level: number
  seconds: number
  /** 是否属于未来日期（用于渲染占位，不显示为缺失） */
  future: boolean
  /** 是否为本月之外（跨月显示时淡化） */
  outsideRange: boolean
}

export interface HeatmapWeek {
  /** 该周的 7 天（周日起） */
  days: HeatmapCell[]
  /** 该周所属月份，用于跨月标签 */
  monthLabel: string
}

export interface ReadingStats {
  totalSeconds: number
  totalChars: number
  totalSessions: number
  totalDays: number
  /** 当前连续阅读天数 */
  currentStreak: number
  /** 历史最长连续天数 */
  longestStreak: number
  /** 日均阅读秒数（只按有阅读的天数平均，避免被空白天拉低） */
  averageSecondsPerActiveDay: number
  /** 最近 7 天总秒数 */
  last7DaysSeconds: number
  /** 最近 30 天总秒数 */
  last30DaysSeconds: number
  daily: DailyStat[]
  /** 连续等级阈值（秒），供 UI 图例显示 */
  levelThresholds: number[]
}

/** 本地时区的 YYYY-MM-DD。 */
export function localDateKey(input: Date | number): string {
  const d = typeof input === 'number' ? new Date(input) : input
  const y = d.getFullYear()
  const m = `${d.getMonth() + 1}`.padStart(2, '0')
  const day = `${d.getDate()}`.padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** 解析 YYYY-MM-DD 为本地时区当天 00:00 的时间戳。 */
export function parseDateKey(key: string): number {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y, (m ?? 1) - 1, d ?? 1, 0, 0, 0, 0).getTime()
}

/** 在日期键上加减天数。 */
export function shiftDateKey(key: string, days: number): string {
  const t = parseDateKey(key)
  const d = new Date(t)
  d.setDate(d.getDate() + days)
  return localDateKey(d)
}

/** 两个日期键之间相差的天数。 */
export function daysBetween(a: string, b: string): number {
  const ms = parseDateKey(b) - parseDateKey(a)
  return Math.round(ms / 86400000)
}

export const HEATMAP_LEVEL_THRESHOLDS = [1, 600, 1800, 3600] as const

/** 依据秒数给出热力等级：0 无，1 极少，2 半小时内，3 一小时，4 一小时以上。 */
export function heatLevel(seconds: number, thresholds: readonly number[] = HEATMAP_LEVEL_THRESHOLDS): number {
  if (seconds <= 0) return 0
  let level = 1
  for (let i = 1; i < thresholds.length; i++) {
    if (seconds >= thresholds[i]) level = i + 1
  }
  return Math.min(4, level)
}

/**
 * 聚合会话为每日统计。
 *
 * 会话可能跨天（用户挂着读），这里按 `startedAt` 归属，
 * 但若单次会话超过 4 小时，判定为「挂机」并截断到 4 小时 ——
 * 这是主流阅读器的通行防作弊口径。
 */
export const MAX_SESSION_SECONDS = 4 * 3600

export function aggregateDaily(sessions: ReadingSession[]): DailyStat[] {
  const map = new Map<string, { seconds: number; chars: number; books: Set<string>; sessions: number }>()

  for (const s of sessions) {
    if (!s.startedAt || s.durationSec <= 0) continue
    const key = localDateKey(s.startedAt)
    const bucket = map.get(key) ?? { seconds: 0, chars: 0, books: new Set<string>(), sessions: 0 }
    bucket.seconds += Math.min(s.durationSec, MAX_SESSION_SECONDS)
    bucket.chars += Math.max(0, s.charCount)
    bucket.books.add(s.bookId)
    bucket.sessions += 1
    map.set(key, bucket)
  }

  return [...map.entries()]
    .map(([date, b]) => ({
      date,
      seconds: Math.round(b.seconds),
      chars: Math.round(b.chars),
      bookCount: b.books.size,
      sessions: b.sessions,
    }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
}

/** 计算连续阅读天数。 */
export function computeStreaks(daily: DailyStat[], referenceKey = localDateKey(Date.now())): { current: number; longest: number } {
  const active = daily.filter((d) => d.seconds > 0).map((d) => d.date)
  if (active.length === 0) return { current: 0, longest: 0 }

  const sorted = [...new Set(active)].sort()
  let longest = 1
  let run = 1
  for (let i = 1; i < sorted.length; i++) {
    if (daysBetween(sorted[i - 1], sorted[i]) === 1) {
      run++
    } else {
      run = 1
    }
    if (run > longest) longest = run
  }

  // 当前连续：从今天或昨天往回数。今天还没读不算断（否则白天打开 App 会显示中断）
  const has = new Set(sorted)
  let current = 0
  let cursor = referenceKey
  if (!has.has(cursor)) {
    cursor = shiftDateKey(cursor, -1)
    if (!has.has(cursor)) return { current: 0, longest }
  }
  while (has.has(cursor)) {
    current++
    cursor = shiftDateKey(cursor, -1)
  }

  return { current, longest }
}

/**
 * 生成热力图。
 *
 * @param daily 每日统计
 * @param weeks 显示多少周（默认 26 周 ≈ 半年）
 * @param endKey 结束日期，默认今天
 */
export function buildHeatmap(daily: DailyStat[], weeks = 26, endKey = localDateKey(Date.now())): HeatmapWeek[] {
  const byDate = new Map(daily.map((d) => [d.date, d]))

  // 对齐到本周周日
  const endTime = parseDateKey(endKey)
  const endDate = new Date(endTime)
  const endDow = endDate.getDay() // 0=周日
  const gridEnd = shiftDateKey(endKey, 6 - endDow)
  const totalDays = weeks * 7
  const gridStart = shiftDateKey(gridEnd, -(totalDays - 1))

  const result: HeatmapWeek[] = []
  let cursor = gridStart

  for (let w = 0; w < weeks; w++) {
    const days: HeatmapCell[] = []
    let monthLabel = ''
    for (let d = 0; d < 7; d++) {
      const stat = byDate.get(cursor)
      const seconds = stat?.seconds ?? 0
      const future = parseDateKey(cursor) > endTime
      if (!monthLabel) monthLabel = `${Number(cursor.slice(5, 7))}月`
      days.push({
        date: cursor,
        level: future ? 0 : heatLevel(seconds),
        seconds,
        future,
        outsideRange: false,
      })
      cursor = shiftDateKey(cursor, 1)
    }
    result.push({ days, monthLabel })
  }

  return result
}

/** 汇总出统计总览。 */
export function buildStats(sessions: ReadingSession[], referenceKey = localDateKey(Date.now())): ReadingStats {
  const daily = aggregateDaily(sessions)
  const { current, longest } = computeStreaks(daily, referenceKey)

  const totalSeconds = daily.reduce((a, d) => a + d.seconds, 0)
  const totalChars = daily.reduce((a, d) => a + d.chars, 0)
  const totalSessions = daily.reduce((a, d) => a + d.sessions, 0)
  const activeDays = daily.filter((d) => d.seconds > 0).length

  const last7 = sumRange(daily, referenceKey, 7)
  const last30 = sumRange(daily, referenceKey, 30)

  return {
    totalSeconds,
    totalChars,
    totalSessions,
    totalDays: activeDays,
    currentStreak: current,
    longestStreak: longest,
    averageSecondsPerActiveDay: activeDays > 0 ? Math.round(totalSeconds / activeDays) : 0,
    last7DaysSeconds: last7,
    last30DaysSeconds: last30,
    daily,
    levelThresholds: [...HEATMAP_LEVEL_THRESHOLDS],
  }
}

function sumRange(daily: DailyStat[], referenceKey: string, days: number): number {
  const from = shiftDateKey(referenceKey, -(days - 1))
  return daily
    .filter((d) => d.date >= from && d.date <= referenceKey)
    .reduce((a, d) => a + d.seconds, 0)
}

/** 把秒数格式化为「1 小时 24 分」「23 分钟」「48 秒」。 */
export function formatSeconds(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds))
  if (s < 60) return `${s} 秒`
  const minutes = Math.floor(s / 60)
  if (minutes < 60) return `${minutes} 分钟`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m === 0 ? `${h} 小时` : `${h} 小时 ${m} 分`
}

/**
 * 阅读速度（字/分钟）。用于「读书速度」这个偏趣味的数据展示。
 * 过滤掉异常值，避免挂机导致速度离谱。
 */
export function readingSpeedCharsPerMinute(sessions: ReadingSession[]): number {
  let chars = 0
  let seconds = 0
  for (const s of sessions) {
    const dur = Math.min(s.durationSec, MAX_SESSION_SECONDS)
    if (dur < 30) continue // 太短的会话不计入，采样噪声大
    chars += s.charCount
    seconds += dur
  }
  if (seconds <= 0) return 0
  return Math.round((chars / seconds) * 60)
}

/** 生成统计页需要的洞察文案（例如「你读得最多的是周三」）。 */
export function buildInsights(daily: DailyStat[]): string[] {
  const insights: string[] = []
  if (daily.length === 0) return ['还没有阅读记录，开始读一本吧']

  // 最活跃的星期
  const byDow = new Array(7).fill(0)
  for (const d of daily) {
    const dow = new Date(parseDateKey(d.date)).getDay()
    byDow[dow] += d.seconds
  }
  const names = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
  let bestDow = 0
  for (let i = 1; i < 7; i++) if (byDow[i] > byDow[bestDow]) bestDow = i
  if (byDow[bestDow] > 0) insights.push(`你读得最多的是${names[bestDow]}`)

  // 单日最高
  const best = daily.reduce((a, b) => (b.seconds > a.seconds ? b : a), daily[0])
  if (best.seconds > 0) {
    insights.push(`单日最长 ${formatSeconds(best.seconds)}（${best.date.slice(5)}）`)
  }

  // 时段偏好：按会话开始时间统计
  return insights
}
