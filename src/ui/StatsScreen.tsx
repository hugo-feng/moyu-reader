/**
 * 阅读统计页。
 *
 * 与 Android 端「周报 / 热力图」页共用同一套聚合口径（engine/stats.ts），
 * 因此这里只负责把算法输出排成可读的信息层级，不重复实现任何统计逻辑：
 *   总览卡片 → 半年热力图（可点选单日） → 洞察 → 最近阅读
 *
 * 关键取舍：
 *   - 会话按本地时区的日期键归属（localDateKey），跨日挂机由引擎截断到 4 小时；
 *   - 热力图固定 26 周（约半年），与 GitHub / 微信读书一致，横向可滚动；
 *   - 单元格标签里的 1/2/3 等数字是强度等级，等级阈值由引擎给出，不在 UI 里硬编码；
 *   - 「最近阅读」按天聚合，只取最近 10 次会话；书已删除时该行不可点击。
 */

import { useEffect, useMemo, useState } from 'react'
import type { ReadingSession } from '../engine/types'
import {
  buildHeatmap,
  buildInsights,
  buildStats,
  formatSeconds,
  localDateKey,
  readingSpeedCharsPerMinute,
} from '../engine/stats'
import type { HeatmapCell } from '../engine/stats'
import * as db from '../storage'
import { useAppState } from '../store'
import { IconBack, IconStats } from './icons'

interface StatsScreenProps {
  onBack: () => void
  onOpenBook: (bookId: string) => void
  /** 可选：指定只统计某本书；不传表示全部 */
  bookId?: string
}

/** 大于 1 万的字数改用「万」，避免总览卡片里的数字过长。 */
function formatChars(chars: number): string {
  if (chars >= 10000) return `${(chars / 10000).toFixed(1)} 万`
  return `${chars}`
}

function formatClock(timestamp: number): string {
  const d = new Date(timestamp)
  return `${`${d.getHours()}`.padStart(2, '0')}:${`${d.getMinutes()}`.padStart(2, '0')}`
}

/** 「6月1日 周六」这种便于人眼定位的日期文案。 */
function formatDayLabel(dateKey: string): string {
  const [y, m, d] = dateKey.split('-').map(Number)
  const date = new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1)
  const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][date.getDay()]
  return `${y}年${m}月${d}日 ${week}`
}

interface RecentRow {
  bookId: string
  title: string
  seconds: number
  chars: number
  sessions: number
  /** 该天内这本书最早一次会话的开始时间，用于显示「从几点开始读」 */
  firstStartedAt: number
}

interface RecentGroup {
  date: string
  seconds: number
  rows: RecentRow[]
}

export function StatsScreen({ onBack, onOpenBook, bookId }: StatsScreenProps) {
  const { books } = useAppState()
  const [sessions, setSessions] = useState<ReadingSession[]>([])
  const [loaded, setLoaded] = useState(false)
  const [selectedDate, setSelectedDate] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const all = await db.getSessions()
        if (!cancelled) setSessions(all)
      } catch {
        if (!cancelled) setSessions([])
      } finally {
        if (!cancelled) setLoaded(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const scoped = useMemo(
    () => (bookId ? sessions.filter((s) => s.bookId === bookId) : sessions),
    [sessions, bookId],
  )

  const stats = useMemo(() => buildStats(scoped), [scoped])
  const insights = useMemo(() => buildInsights(stats.daily), [stats.daily])
  const weeks = useMemo(() => buildHeatmap(stats.daily, 26), [stats.daily])

  const titleById = useMemo(() => {
    const map = new Map<string, string>()
    for (const b of books) map.set(b.id, b.title)
    return map
  }, [books])

  const dailyByDate = useMemo(() => {
    const map = new Map<string, (typeof stats.daily)[number]>()
    for (const d of stats.daily) map.set(d.date, d)
    return map
  }, [stats.daily])

  const recentGroups = useMemo<RecentGroup[]>(() => {
    const newest = [...scoped].sort((a, b) => b.startedAt - a.startedAt).slice(0, 10)
    const groups = new Map<string, RecentGroup>()
    for (const s of newest) {
      const key = localDateKey(s.startedAt)
      const group = groups.get(key) ?? { date: key, seconds: 0, rows: [] }
      let row = group.rows.find((r) => r.bookId === s.bookId)
      if (!row) {
        row = {
          bookId: s.bookId,
          title: titleById.get(s.bookId) ?? '已删除的书',
          seconds: 0,
          chars: 0,
          sessions: 0,
          firstStartedAt: s.startedAt,
        }
        group.rows.push(row)
      }
      row.seconds += s.durationSec
      row.chars += Math.max(0, s.charCount)
      row.sessions += 1
      row.firstStartedAt = Math.min(row.firstStartedAt, s.startedAt)
      group.seconds += s.durationSec
      groups.set(key, group)
    }
    return [...groups.values()].map((g) => ({
      ...g,
      rows: g.rows.sort((a, b) => b.seconds - a.seconds),
    }))
  }, [scoped, titleById])

  const selectedStat = selectedDate ? dailyByDate.get(selectedDate) : undefined
  const speed = readingSpeedCharsPerMinute(scoped)

  function handleCellClick(cell: HeatmapCell): void {
    if (cell.future) return
    setSelectedDate((prev) => (prev === cell.date ? null : cell.date))
  }

  return (
    <div className="screen">
      <div className="topbar">
        <button type="button" aria-label="返回" onClick={onBack} style={{ background: 'transparent' }}>
          <IconBack />
        </button>
        <div className="topbar__title">{bookId ? '阅读统计 · 本书' : '阅读统计'}</div>
        <div aria-hidden="true" style={{ width: 44, minWidth: 44, flexShrink: 0 }} />
      </div>

      <div className="scroll-area">
        {loaded && scoped.length === 0 ? (
          <div className="empty">
            <div className="empty__icon">
              <IconStats size={34} />
            </div>
            <div className="empty__title">还没有阅读记录</div>
            <div className="empty__desc">
              打开一本书读上一会儿，这里就会出现时长、字数、连续天数与热力图。
            </div>
          </div>
        ) : (
          <>
            <div className="section-title">总览</div>
            <div className="stat-grid">
              <StatTile label="累计阅读" value={formatSeconds(stats.totalSeconds)} />
              <StatTile label="阅读天数" value={`${stats.totalDays}`} />
              <StatTile
                label="连续天数"
                value={`${stats.currentStreak}`}
                sub={`最长 ${stats.longestStreak} 天`}
              />
              <StatTile label="阅读速度（字/分）" value={`${speed}`} />
              <StatTile label="累计字数" value={formatChars(stats.totalChars)} />
              <StatTile label="最近 7 天" value={formatSeconds(stats.last7DaysSeconds)} />
            </div>

            <div className="section-title">阅读热力图</div>
            <Heatmap
              weeks={weeks}
              thresholds={stats.levelThresholds}
              selectedDate={selectedDate}
              onCellClick={handleCellClick}
            />
            <div className="heatmap__legend">
              <span>少</span>
              <span className="heatmap__legend-cells">
                <i className="heatmap__cell" />
                <i className="heatmap__cell heatmap__cell--l1" />
                <i className="heatmap__cell heatmap__cell--l2" />
                <i className="heatmap__cell heatmap__cell--l3" />
                <i className="heatmap__cell heatmap__cell--l4" />
              </span>
              <span>多</span>
            </div>

            {selectedDate ? (
              <div className="card" style={{ margin: '0 16px 16px', padding: '12px 14px' }}>
                <div className="row row--between">
                  <div style={{ fontSize: 13.5, fontWeight: 600 }}>{formatDayLabel(selectedDate)}</div>
                  <button
                    type="button"
                    className="btn btn--ghost"
                    onClick={() => setSelectedDate(null)}
                    style={{ minHeight: 32, padding: '0 8px', fontSize: 12 }}
                  >
                    收起
                  </button>
                </div>
                <div className="row" style={{ gap: 18, marginTop: 8, flexWrap: 'wrap' }}>
                  <DayMetric label="时长" value={formatSeconds(selectedStat?.seconds ?? 0)} />
                  <DayMetric label="字数" value={formatChars(selectedStat?.chars ?? 0)} />
                  <DayMetric label="书本" value={`${selectedStat?.bookCount ?? 0}`} />
                  <DayMetric label="会话" value={`${selectedStat?.sessions ?? 0}`} />
                </div>
                <div className="setting-row__hint" style={{ marginTop: 8 }}>
                  {selectedStat
                    ? '这一天的阅读已计入总览与热力图。'
                    : '这一天没有阅读记录，热力图为空格。'}
                </div>
              </div>
            ) : null}

            <div className="section-title">洞察</div>
            <div className="card card--flat" style={{ margin: '0 16px' }}>
              {insights.map((text, i) => (
                <div className="insight-row" key={`${i}-${text}`}>
                  <span className="insight-row__dot" />
                  <span>{text}</span>
                </div>
              ))}
            </div>

            <div className="section-title">最近阅读</div>
            {recentGroups.length === 0 ? (
              <div className="empty" style={{ padding: '30px 28px' }}>
                <div className="empty__desc">最近还没有阅读会话。</div>
              </div>
            ) : (
              <div className="card" style={{ margin: '0 16px 28px', overflow: 'hidden' }}>
                {recentGroups.map((group) => (
                  <div key={group.date}>
                    <div className="insight-row" style={{ paddingBottom: 4 }}>
                      <span className="note-item__chapter">
                        {group.date === localDateKey(Date.now()) ? '今天' : formatDayLabel(group.date)}
                      </span>
                      <span className="note-item__time">{formatSeconds(group.seconds)}</span>
                    </div>
                    {group.rows.map((row) => {
                      const exists = titleById.has(row.bookId)
                      return (
                        <button
                          type="button"
                          key={`${group.date}-${row.bookId}`}
                          className="search-hit"
                          onClick={exists ? () => onOpenBook(row.bookId) : undefined}
                          disabled={!exists}
                          style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}
                        >
                          <span className="grow truncate" style={{ fontSize: 13.5 }}>
                            {row.title}
                          </span>
                          <span className="text-mute text-sm" style={{ flexShrink: 0 }}>
                            {formatClock(row.firstStartedAt)}
                          </span>
                          <span className="text-mute text-sm" style={{ flexShrink: 0 }}>
                            {formatSeconds(row.seconds)} · {formatChars(row.chars)} 字
                          </span>
                        </button>
                      )
                    })}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function StatTile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="stat-tile">
      <div className="stat-tile__value">{value}</div>
      <div className="stat-tile__label">
        {label}
        {sub ? <span style={{ marginLeft: 6, color: 'var(--ink-faint)' }}>{sub}</span> : null}
      </div>
    </div>
  )
}

function DayMetric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--accent-ink)' }}>{value}</div>
      <div className="setting-row__hint">{label}</div>
    </div>
  )
}

function Heatmap({
  weeks,
  thresholds,
  selectedDate,
  onCellClick,
}: {
  weeks: ReturnType<typeof buildHeatmap>
  thresholds: number[]
  selectedDate: string | null
  onCellClick: (cell: HeatmapCell) => void
}) {
  return (
    <div className="heatmap">
      <div className="heatmap__grid" style={{ alignItems: 'flex-start' }}>
        {weeks.map((week, wi) => (
          <div className="heatmap__week" key={`h-${wi}`} style={{ alignItems: 'flex-start' }}>
            <span
              style={{
                fontSize: 9.5,
                lineHeight: '12px',
                height: 12,
                color: 'var(--ink-faint)',
                whiteSpace: 'nowrap',
              }}
            >
              {wi === 0 || week.monthLabel !== weeks[wi - 1].monthLabel ? week.monthLabel : ''}
            </span>
            {week.days.map((cell) => {
              const level = Math.min(4, Math.max(0, cell.level))
              const classes = ['heatmap__cell']
              if (cell.future) classes.push('heatmap__cell--future')
              else if (level > 0) classes.push(`heatmap__cell--l${level}`)
              return (
                <button
                  type="button"
                  key={cell.date}
                  className={classes.join(' ')}
                  aria-label={`${cell.date} ${formatSeconds(cell.seconds)}`}
                  aria-pressed={selectedDate === cell.date}
                  title={`${cell.date} · ${formatSeconds(cell.seconds)}${
                    cell.future ? '（未到）' : ''
                  }`}
                  onClick={() => onCellClick(cell)}
                  style={
                    selectedDate === cell.date
                      ? { outline: '2px solid var(--accent)', outlineOffset: 1 }
                      : undefined
                  }
                />
              )
            })}
          </div>
        ))}
      </div>
      <div className="setting-row__hint" style={{ padding: '8px 0 0' }}>
        近 26 周，共 {weeks.length * 7} 天；竖列为一周（周日起），颜色越深读得越久。等级阈值：
        {thresholds.map((t, i) => `${i + 1}级 ≥ ${formatSeconds(t)}`).join('，')}
      </div>
    </div>
  )
}
