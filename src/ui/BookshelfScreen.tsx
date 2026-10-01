/**
 * 书架首页。
 *
 * 结构参照主流中文阅读 App（顶部问候 + 继续阅读 + 工具栏 + 网格/列表），
 * 但视觉全部落在项目既有的纸感设计系统上：只使用 styles.css 里已有的类名，
 * 需要微调的地方用极小的内联 style，避免另外造一套视觉语言。
 *
 * 交互取舍：
 *   - 长按 / 右键 / 「⋯」三条路径都能打开上下文操作面板，
 *     因为桌面端长按反直觉、移动端右键不存在；
 *   - 长按用 Pointer Events 实现：pointerdown 起 500ms 计时，
 *     位移超过 10px、抬起或取消都立即中止，避免滑动书架时误触发。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Book, BookGroup } from '../engine/types'
import { formatSeconds } from '../engine/stats'
import { buildDemoBookText, DEMO_BOOK_TITLE } from '../demo'
import { buildBookFromText, getPosition, getSessions, saveBookWithChapters } from '../storage'
import {
  createGroup,
  formatRelativeTime,
  refreshBooks,
  removeBook,
  setActiveFilter,
  setShelfLayout,
  setShelfSort,
  toast,
  updateBookMeta,
  useAppState,
  useShelfItems,
  type ShelfSort,
} from '../store'
import { BookCover } from './BookCover'
import { BookMetaDialog } from './BookMetaDialog'
import {
  IconArrowRight,
  IconCheck,
  IconEdit,
  IconFolder,
  IconGrid,
  IconList,
  IconNotes,
  IconPlus,
  IconSearch,
  IconShelf,
  IconTrash,
  IconUpload,
} from './icons'

export interface BookshelfScreenProps {
  onOpenBook: (bookId: string) => void
  onOpenStats: () => void
  onOpenNotes: (bookId: string) => void
  /** 打开搜索。传空字符串表示在全部书里搜索 */
  onOpenSearch: (bookId: string) => void
  onOpenImport: () => void
}

/** 顶部筛选 chip 的固定项。 */
const STATUS_FILTERS: Array<{ key: 'all' | 'reading' | 'unread' | 'finished'; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'reading', label: '在读' },
  { key: 'unread', label: '未读' },
  { key: 'finished', label: '已读完' },
]

/** 排序项，value 与 store 的 ShelfSort 一一对应。 */
const SORT_OPTIONS: Array<{ value: ShelfSort; label: string }> = [
  { value: 'recent', label: '最近' },
  { value: 'added', label: '加入' },
  { value: 'title', label: '书名' },
  { value: 'author', label: '作者' },
  { value: 'progress', label: '进度' },
]

/** 新建分组时可选的固定色板（与 --cat-1..5 同族）。 */
const GROUP_COLORS = ['#8a6a46', '#4e7a4a', '#7c5c8a', '#3f6f8a', '#a5453a'] as const

const LONG_PRESS_MS = 500
const LONG_PRESS_MOVE_TOLERANCE = 10

/** 今天（本地日 00:00 起）的阅读秒数。 */
function todaySeconds(sessions: Array<{ startedAt: number; durationSec: number }>): number {
  const now = new Date()
  const since = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  let total = 0
  for (const s of sessions) {
    if (s.startedAt >= since && s.startedAt <= Date.now()) total += Math.max(0, s.durationSec)
  }
  return total
}

/** 本周（近 7 天，按本地日 00:00 为界）的阅读秒数。 */
function weekSeconds(sessions: Array<{ startedAt: number; durationSec: number }>): number {
  const now = new Date()
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const since = dayStart - 6 * 86_400_000
  let total = 0
  for (const s of sessions) {
    if (s.startedAt >= since && s.startedAt <= Date.now()) total += Math.max(0, s.durationSec)
  }
  return total
}

/** 把字节数按本地时区格式化成「刚刚 / 昨天 / 3 天前」。 */
function lastReadText(book: Book): string {
  return formatRelativeTime(book.lastReadAt)
}

export function BookshelfScreen(props: BookshelfScreenProps) {
  const { onOpenBook, onOpenStats, onOpenNotes, onOpenSearch, onOpenImport } = props
  const { books, groups, shelfSort, shelfLayout, activeFilter } = useAppState()
  const items = useShelfItems()

  const [progressMap, setProgressMap] = useState<Map<string, number>>(new Map())
  const [weekSec, setWeekSec] = useState(0)
  const [todaySec, setTodaySec] = useState(0)
  const [statsLoaded, setStatsLoaded] = useState(false)
  const [busy, setBusy] = useState(false)

  const [sheetBook, setSheetBook] = useState<Book | null>(null)
  const [sheetMode, setSheetMode] = useState<'actions' | 'groups' | 'remove'>('actions')
  const [editingBook, setEditingBook] = useState<Book | null>(null)

  /** 长按已触发时置位，用于吞掉随后的 click，避免长按后又跳进阅读器。 */
  const longPressFired = useRef<Set<string>>(new Set())
  const pressTimer = useRef<number | null>(null)
  const pressOrigin = useRef<{ x: number; y: number } | null>(null)

  /**
   * 顶部那行小字。
   *
   * 这里原本是「早上好 / 下午好」这类按时段变化的问候。
   * 换掉的理由：问候是通用应用的套话，它说的是「时间」，而书架上最该被说的是「读」。
   * 现在它显示真实读数：今天读了多少；今天还没读但本周读过，就报本周；
   * 一周都没读，就直说「本周尚未开卷」。
   */
  const shelfStatus = useMemo(() => {
    if (!statsLoaded && books.length > 0) return '正在整理书架…'
    if (todaySec > 0) return `今天已读 ${formatSeconds(todaySec)}`
    if (weekSec > 0) return `本周已读 ${formatSeconds(weekSec)}`
    return '本周尚未开卷'
  }, [statsLoaded, books.length, todaySec, weekSec])

  const finishedCount = useMemo(() => items.filter((i) => i.finished).length, [items])

  /** 各书的阅读进度：继续阅读卡片与「按进度排序」都需要。 */
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const map = new Map<string, number>()
      for (const book of books) {
        try {
          const pos = await dbGetPercent(book.id)
          if (pos !== null) map.set(book.id, pos)
        } catch {
          /* 单本失败不影响整架 */
        }
      }
      if (!cancelled) setProgressMap(map)
    })()
    return () => {
      cancelled = true
    }
  }, [books])

  /** 本周与今日阅读时长（同一个查询里一起算，避免读两遍会话表）。 */
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const sessions = await dbGetSessions()
        if (cancelled) return
        setWeekSec(weekSeconds(sessions))
        setTodaySec(todaySeconds(sessions))
      } catch {
        if (cancelled) return
        setWeekSec(0)
        setTodaySec(0)
      } finally {
        if (!cancelled) setStatsLoaded(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [books])

  /** 继续阅读：最近读过且未读完的一本；全部读完则退回最近读过的第一本。 */
  const continueItem = useMemo(() => {
    const sorted = [...items].sort((a, b) => b.book.lastReadAt - a.book.lastReadAt)
    return sorted.find((i) => !i.finished) ?? sorted[0] ?? null
  }, [items])

  const continueLabel = useMemo(() => {
    if (!continueItem) return ''
    const { percent, finished, book } = continueItem
    if (finished) return `已读完、共 ${book.chapterCount} 章`
    if (percent <= 0) return `第 1 章、0%`
    // 书架不加载章节表，无法反推精确章号；按全书百分比线性近似到章节序号
    const approx = Math.min(book.chapterCount, Math.max(1, Math.ceil(percent * book.chapterCount)))
    return `第 ${approx} 章、${Math.round(percent * 100)}%`
  }, [continueItem])

  /** 按进度排序需要自己的排序副本；其余排序由 store 的 useShelfItems 处理。 */
  const displayItems = useMemo(() => {
    if (shelfSort !== 'progress') return items
    return [...items].sort((a, b) => (progressMap.get(b.book.id) ?? 0) - (progressMap.get(a.book.id) ?? 0))
  }, [items, shelfSort, progressMap])

  const clearPress = useCallback(() => {
    if (pressTimer.current !== null) {
      window.clearTimeout(pressTimer.current)
      pressTimer.current = null
    }
    pressOrigin.current = null
  }, [])

  useEffect(() => clearPress, [clearPress])

  const openSheet = useCallback((book: Book) => {
    setSheetBook(book)
    setSheetMode('actions')
  }, [])

  const onPointerDown = (book: Book) => (e: React.PointerEvent<HTMLElement>) => {
    // 鼠标右键由 contextmenu 处理；这里只处理主键
    if (e.pointerType === 'mouse' && e.button !== 0) return
    clearPress()
    pressOrigin.current = { x: e.clientX, y: e.clientY }
    pressTimer.current = window.setTimeout(() => {
      longPressFired.current.add(book.id)
      pressTimer.current = null
      pressOrigin.current = null
      openSheet(book)
    }, LONG_PRESS_MS)
  }

  const onPointerMove = (e: React.PointerEvent<HTMLElement>) => {
    const origin = pressOrigin.current
    if (!origin || pressTimer.current === null) return
    if (Math.abs(e.clientX - origin.x) > LONG_PRESS_MOVE_TOLERANCE || Math.abs(e.clientY - origin.y) > LONG_PRESS_MOVE_TOLERANCE) {
      clearPress()
    }
  }

  const consumeLongPress = (bookId: string): boolean => {
    if (longPressFired.current.has(bookId)) {
      longPressFired.current.delete(bookId)
      return true
    }
    return false
  }

  const handleOpen = (bookId: string) => {
    if (consumeLongPress(bookId)) return
    onOpenBook(bookId)
  }

  const handleLoadDemo = async () => {
    if (busy) return
    setBusy(true)
    try {
      const id = `demo_${Date.now().toString(36)}`
      const text = buildDemoBookText()
      const { book, chapters } = buildBookFromText({
        id,
        fileName: `${DEMO_BOOK_TITLE}.txt`,
        text,
        encoding: 'utf-8',
      })
      await saveBookWithChapters(book, chapters)
      await refreshBooks()
      toast('示例书已加入书架')
    } catch (e) {
      toast(`加载示例书失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  const handleRemove = async (book: Book) => {
    setSheetBook(null)
    try {
      await removeBook(book.id)
      toast('已移出书架')
    } catch (e) {
      toast(`移出失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const handleToggleFinished = async (book: Book) => {
    setSheetBook(null)
    try {
      await updateBookMeta(book.id, { finished: !book.finished })
      toast(book.finished ? '已标记为未读' : '已标记为已读完')
    } catch (e) {
      toast(`保存失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const handleMoveToGroup = async (book: Book, groupId: string | undefined) => {
    setSheetBook(null)
    try {
      await updateBookMeta(book.id, { groupId })
      toast('已更新分组')
    } catch (e) {
      toast(`保存失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const renderCardInner = (item: (typeof items)[number]) => (
    <>
      <div className="book-card__cover-wrap">
        <BookCover book={item.book} percent={item.percent} finished={item.finished} unread={item.unread} />
      </div>
      <span className="book-card__title">{item.book.title}</span>
      <span className="book-card__sub">{item.book.author || lastReadText(item.book)}</span>
    </>
  )

  return (
    <div className="screen">
      <div className="scroll-area">
        <div className="shelf">
          {/* —— 顶部问候与统计 —— */}
          <header className="shelf__hero">
            <div className="row row--between" style={{ alignItems: 'flex-start' }}>
              <div className="grow">
                <div className="shelf__status">{shelfStatus}</div>
                <h1 className="shelf__headline">我的书架</h1>
              </div>
              <button type="button" className="btn btn--ghost" aria-label="阅读统计" onClick={onOpenStats}>
                <IconArrowRight size={18} />
              </button>
            </div>
            <div className="shelf__stats">
              <div>
                <div className="shelf__stat-value">{books.length}</div>
                <div className="shelf__stat-label">书籍数</div>
              </div>
              <div>
                <div className="shelf__stat-value">{finishedCount}</div>
                <div className="shelf__stat-label">已读完</div>
              </div>
              <div>
                <div className="shelf__stat-value">{formatSeconds(weekSec)}</div>
                <div className="shelf__stat-label">本周阅读时长</div>
              </div>
            </div>
          </header>

          {/* —— 继续阅读 —— */}
          {continueItem ? (
            <button
              type="button"
              className="continue-card"
              onClick={() => onOpenBook(continueItem.book.id)}
              aria-label={`继续阅读《${continueItem.book.title}》`}
            >
              <BookCover book={continueItem.book} percent={continueItem.percent} finished={continueItem.finished} width={52} />
              <span className="continue-card__body">
                <span className="continue-card__label">继续阅读</span>
                <span className="continue-card__title">{continueItem.book.title}</span>
                <span className="continue-card__meta">{continueLabel}</span>
              </span>
              <IconArrowRight size={18} className="text-mute" />
            </button>
          ) : null}

          {/* —— 工具栏：布局 / 排序 / 导入 —— */}
          <div className="row row--between" style={{ marginTop: 18, gap: 10, flexWrap: 'wrap' }}>
            <div className="segmented" role="group" aria-label="书架布局">
              <button
                type="button"
                className={shelfLayout === 'grid' ? 'segmented__item--active' : undefined}
                aria-label="网格布局"
                aria-pressed={shelfLayout === 'grid'}
                onClick={() => setShelfLayout('grid')}
              >
                <IconGrid size={17} />
              </button>
              <button
                type="button"
                className={shelfLayout === 'list' ? 'segmented__item--active' : undefined}
                aria-label="列表布局"
                aria-pressed={shelfLayout === 'list'}
                onClick={() => setShelfLayout('list')}
              >
                <IconList size={17} />
              </button>
            </div>
            {/* 搜索入口放在书架上（而不是只藏在长按菜单里）：
                主流小说 App 都有显眼的搜索按钮，用户也确实会想「搜我书库里的一句话」。 */}
            <button
              type="button"
              className="btn"
              onClick={() => onOpenSearch('')}
              aria-label="搜索全书内容"
              title="搜索全部书籍的正文"
            >
              <IconSearch size={17} />
              搜索
            </button>
            <button type="button" className="btn" onClick={onOpenImport} aria-label="导入本地书籍">
              <IconUpload size={17} />
              导入
            </button>
          </div>

          <div className="chip-row" style={{ padding: '12px 0 4px' }} role="group" aria-label="排序方式">
            {SORT_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                className={`chip${shelfSort === opt.value ? ' chip--active' : ''}`}
                aria-pressed={shelfSort === opt.value}
                onClick={() => setShelfSort(opt.value)}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {/* —— 筛选与分组 —— */}
          <FilterChips activeFilter={activeFilter} groups={groups} />

          {/* —— 书列表 —— */}
          {displayItems.length === 0 ? (
            <EmptyShelf busy={busy} onOpenImport={onOpenImport} onLoadDemo={handleLoadDemo} hasFilter={activeFilter !== 'all'} />
          ) : shelfLayout === 'list' ? (
            <div className="stack" style={{ gap: 10, marginTop: 14 }}>
              {displayItems.map((item) => (
                <div
                  key={item.book.id}
                  className="card"
                  style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 10, position: 'relative' }}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    openSheet(item.book)
                  }}
                  onPointerDown={onPointerDown(item.book)}
                  onPointerMove={onPointerMove}
                  onPointerUp={clearPress}
                  onPointerCancel={clearPress}
                >
                  <button
                    type="button"
                    onClick={() => handleOpen(item.book.id)}
                    aria-label={`打开《${item.book.title}》`}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 12,
                      flex: 1,
                      minWidth: 0,
                      justifyContent: 'flex-start',
                      textAlign: 'left',
                      minHeight: 'auto',
                    }}
                  >
                    <BookCover
                      book={item.book}
                      percent={item.percent}
                      finished={item.finished}
                      unread={item.unread}
                      width={46}
                    />
                    <span className="grow" style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                      <span className="book-card__title" style={{ WebkitLineClamp: 1 }}>
                        {item.book.title}
                      </span>
                      <span className="book-card__sub">{item.book.author || item.lastReadLabel}</span>
                      <span className="book-card__sub" style={{ color: 'var(--accent-ink)' }}>
                        {item.finished ? '已读完' : `已读 ${Math.round(item.percent * 100)}%`}
                      </span>
                    </span>
                  </button>
                  <button
                    type="button"
                    aria-label={`《${item.book.title}》的更多操作`}
                    onClick={() => openSheet(item.book)}
                    style={{ flexShrink: 0 }}
                  >
                    ⋯
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div className="book-grid">
              {displayItems.map((item) => (
                <div
                  key={item.book.id}
                  className="book-card"
                  onContextMenu={(e) => {
                    e.preventDefault()
                    openSheet(item.book)
                  }}
                  onPointerDown={onPointerDown(item.book)}
                  onPointerMove={onPointerMove}
                  onPointerUp={clearPress}
                  onPointerCancel={clearPress}
                >
                  <button
                    type="button"
                    onClick={() => handleOpen(item.book.id)}
                    aria-label={`打开《${item.book.title}》`}
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 7,
                      alignItems: 'stretch',
                      textAlign: 'left',
                      minHeight: 'auto',
                      padding: 0,
                    }}
                  >
                    {renderCardInner(item)}
                  </button>
                  <button
                    type="button"
                    aria-label={`《${item.book.title}》的更多操作`}
                    onClick={() => openSheet(item.book)}
                    style={{
                      position: 'absolute',
                      top: 4,
                      right: -4,
                      minWidth: 26,
                      minHeight: 26,
                      borderRadius: 99,
                      background: 'rgba(0,0,0,0.34)',
                      color: '#fff',
                      fontSize: 14,
                      lineHeight: 1,
                    }}
                  >
                    ⋯
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* —— 上下文操作面板 —— */}
      {sheetBook ? (
        <div
          className="sheet"
          role="dialog"
          aria-modal="true"
          aria-label={`《${sheetBook.title}》操作`}
          onClick={() => setSheetBook(null)}
        >
          <div className="sheet__panel" onClick={(e) => e.stopPropagation()}>
            <div className="sheet__handle" />
            <div className="sheet__header">
              <span className="sheet__title truncate">{sheetBook.title}</span>
              <button type="button" className="btn btn--ghost" onClick={() => setSheetBook(null)} aria-label="关闭">
                关闭
              </button>
            </div>
            <div className="sheet__body">
              {sheetMode === 'actions' ? (
                <>
                  <SheetAction
                    icon={<IconEdit size={18} />}
                    label="编辑信息"
                    onClick={() => {
                      setEditingBook(sheetBook)
                      setSheetBook(null)
                    }}
                  />
                  <SheetAction
                    icon={<IconFolder size={18} />}
                    label="移到分组"
                    onClick={() => setSheetMode('groups')}
                  />
                  <SheetAction
                    icon={<IconCheck size={18} />}
                    label={sheetBook.finished ? '标记为未读' : '标记为已读完'}
                    onClick={() => void handleToggleFinished(sheetBook)}
                  />
                  <SheetAction
                    icon={<IconNotes size={18} />}
                    label="查看笔记"
                    onClick={() => {
                      const id = sheetBook.id
                      setSheetBook(null)
                      onOpenNotes(id)
                    }}
                  />
                  <SheetAction
                    icon={<IconSearch size={18} />}
                    label="全书搜索"
                    onClick={() => {
                      const id = sheetBook.id
                      setSheetBook(null)
                      onOpenSearch(id)
                    }}
                  />
                  <SheetAction
                    icon={<IconTrash size={18} />}
                    label="移出书架"
                    danger
                    onClick={() => setSheetMode('remove')}
                  />
                </>
              ) : null}

              {sheetMode === 'groups' ? (
                <div style={{ padding: '6px 0' }}>
                  <div className="section-title" style={{ padding: '4px 16px 8px' }}>
                    选择分组
                  </div>
                  <SheetAction
                    icon={<IconCheck size={18} />}
                    label="不分组"
                    selected={!sheetBook.groupId}
                    onClick={() => void handleMoveToGroup(sheetBook, undefined)}
                  />
                  {groups.map((g) => (
                    <SheetAction
                      key={g.id}
                      icon={<span style={{ width: 12, height: 12, borderRadius: 3, background: g.color }} />}
                      label={g.name}
                      selected={sheetBook.groupId === g.id}
                      onClick={() => void handleMoveToGroup(sheetBook, g.id)}
                    />
                  ))}
                  {groups.length === 0 ? <div className="toc-empty">还没有分组，可在书架筛选栏新建</div> : null}
                </div>
              ) : null}

              {sheetMode === 'remove' ? (
                <div style={{ padding: '18px 16px 24px', textAlign: 'center' }}>
                  <div className="modal__title">移出书架？</div>
                  <div className="modal__desc">
                    《{sheetBook.title}》的章节、书签与阅读记录都会被删除，此操作无法撤销。
                  </div>
                  <div className="modal__actions" style={{ justifyContent: 'center' }}>
                    <button type="button" className="btn" onClick={() => setSheetMode('actions')}>
                      取消
                    </button>
                    <button type="button" className="btn btn--danger" onClick={() => void handleRemove(sheetBook)}>
                      移出书架
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {/* —— 编辑信息对话框（由书架触发，交由 shared 组件渲染） —— */}
      {editingBook ? <BookMetaDialog book={editingBook} onClose={() => setEditingBook(null)} /> : null}
    </div>
  )
}

// ============================================================
// 子组件
// ============================================================

interface SheetActionProps {
  icon: React.ReactNode
  label: string
  onClick: () => void
  danger?: boolean
  selected?: boolean
}

function SheetAction({ icon, label, onClick, danger, selected }: SheetActionProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        width: '100%',
        padding: '12px 16px',
        minHeight: 48,
        justifyContent: 'flex-start',
        borderRadius: 0,
        color: danger ? 'var(--danger)' : selected ? 'var(--accent-ink)' : 'var(--ink-soft)',
        background: selected ? 'var(--accent-wash)' : 'transparent',
        fontWeight: selected ? 600 : 400,
      }}
    >
      <span style={{ display: 'inline-flex', width: 20, justifyContent: 'center' }}>{icon}</span>
      <span className="grow truncate" style={{ textAlign: 'left' }}>
        {label}
      </span>
    </button>
  )
}

interface FilterChipsProps {
  activeFilter: string
  groups: BookGroup[]
}

function FilterChips({ activeFilter, groups }: FilterChipsProps) {
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')

  const submit = async () => {
    const trimmed = name.trim()
    if (trimmed.length === 0) {
      setCreating(false)
      return
    }
    const color = GROUP_COLORS[groups.length % GROUP_COLORS.length]
    try {
      const group = await createGroup(trimmed, color)
      setActiveFilter(group.id)
      toast(`已创建分组「${trimmed}」`)
    } catch (e) {
      toast(`创建分组失败：${e instanceof Error ? e.message : String(e)}`)
    }
    setName('')
    setCreating(false)
  }

  return (
    <div className="chip-row" style={{ padding: '8px 0 0' }} role="group" aria-label="筛选与分组">
      {STATUS_FILTERS.map((f) => (
        <button
          key={f.key}
          type="button"
          className={`chip${activeFilter === f.key ? ' chip--active' : ''}`}
          aria-pressed={activeFilter === f.key}
          onClick={() => setActiveFilter(f.key)}
        >
          {f.label}
        </button>
      ))}

      {groups.map((g) => (
        <button
          key={g.id}
          type="button"
          className={`chip${activeFilter === g.id ? ' chip--active' : ''}`}
          aria-pressed={activeFilter === g.id}
          onClick={() => setActiveFilter(g.id)}
        >
          <span style={{ width: 8, height: 8, borderRadius: 99, background: g.color }} aria-hidden="true" />
          {g.name}
        </button>
      ))}

      {creating ? (
        <span className="row" style={{ gap: 6, flexShrink: 0 }}>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit()
              if (e.key === 'Escape') {
                setName('')
                setCreating(false)
              }
            }}
            placeholder="分组名称"
            aria-label="新分组名称"
            style={{ minHeight: 30, padding: '3px 9px', fontSize: 12.5, width: 110 }}
          />
          <button type="button" className="chip chip--active" onClick={() => void submit()}>
            确定
          </button>
        </span>
      ) : (
        <button type="button" className="chip" onClick={() => setCreating(true)} aria-label="新建分组">
          <IconPlus size={13} /> 新建分组
        </button>
      )}
    </div>
  )
}

interface EmptyShelfProps {
  busy: boolean
  hasFilter: boolean
  onOpenImport: () => void
  onLoadDemo: () => void
}

function EmptyShelf({ busy, hasFilter, onOpenImport, onLoadDemo }: EmptyShelfProps) {
  if (hasFilter) {
    return (
      <div className="empty">
        <IconShelf size={46} className="empty__icon" />
        <div className="empty__title">这里还没有书</div>
        <div className="empty__desc">当前筛选条件下没有匹配的书籍，换一个筛选试试。</div>
      </div>
    )
  }

  return (
    <div className="empty">
      <IconShelf size={46} className="empty__icon" />
      <div className="empty__title">书架还空着</div>
      <div className="empty__desc">导入本地 TXT / EPUB 文件，或先加载一本示例书开始体验。</div>
      <div className="modal__actions" style={{ justifyContent: 'center', marginTop: 6 }}>
        <button type="button" className="btn btn--primary" onClick={onOpenImport}>
          <IconUpload size={17} />
          导入本地书籍
        </button>
        <button type="button" className="btn" onClick={onLoadDemo} disabled={busy}>
          {busy ? '正在准备…' : '加载示例书'}
        </button>
      </div>
    </div>
  )
}

// ============================================================
// 数据访问小工具
// ============================================================

/** 取某本书的阅读进度（0..1）；没有位置记录时返回 null。 */
async function dbGetPercent(bookId: string): Promise<number | null> {
  const pos = await getPosition(bookId)
  return pos ? pos.percent : null
}

/** 取全部阅读会话（统计本周时长用）。 */
async function dbGetSessions(): Promise<Array<{ startedAt: number; durationSec: number }>> {
  return getSessions()
}
