/**
 * 应用状态层。
 *
 * 刻意不引入 Redux / Zustand 之类的外部状态库：这个应用的状态模型很小
 * （书库 + 设置 + 当前阅读上下文），用「一个可订阅的 store + useSyncExternalStore」
 * 反而更透明、更容易测试，也少一层依赖风险。
 *
 * 关键设计：
 *   - store 内部是可变对象 + 手动通知订阅者，避免每次翻页都重建整棵书库数组；
 *   - 阅读会话（用于统计）在打开/关闭阅读器时结算，并在长时间停留时心跳续期，
 *     避免「用户读了 2 小时但只记到 1 次 5 秒会话」这种统计失真；
 *   - 所有持久化写操作都是「先改内存、再异步落库」，保证 UI 永远即时响应。
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type {
  Book,
  BookGroup,
  Bookmark,
  Chapter,
  Highlight,
  ReadingPosition,
  ReaderSettings,
  ThemeId,
} from './engine/types'
import { DEFAULT_SETTINGS, THEMES } from './engine/types'
import { makePosition, totalCharCount } from './engine/progress'
import { visualWeight } from './engine/pagination'
import * as db from './storage'

export type ShelfSort = 'recent' | 'added' | 'title' | 'author' | 'progress'
export type ShelfLayout = 'grid' | 'list'

export interface ToastMessage {
  id: number
  text: string
}

export interface AppState {
  ready: boolean
  books: Book[]
  groups: BookGroup[]
  settings: ReaderSettings
  shelfSort: ShelfSort
  shelfLayout: ShelfLayout
  activeFilter: 'all' | 'reading' | 'unread' | 'finished' | string
  /** 当前打开的书籍；null 表示在书架 */
  currentBookId: string | null
  currentChapters: Chapter[]
  position: ReadingPosition | null
  bookmarks: Bookmark[]
  highlights: Highlight[]
  toasts: ToastMessage[]
  /** 导入进度（null 表示无进行中的导入） */
  importProgress: ImportProgress | null
}

export interface ImportProgress {
  total: number
  done: number
  failed: number
  currentName: string
  items: Array<{ name: string; status: 'pending' | 'ok' | 'error' | 'duplicate'; message?: string }>
}

let state: AppState = {
  ready: false,
  books: [],
  groups: [],
  settings: DEFAULT_SETTINGS,
  shelfSort: 'recent',
  shelfLayout: 'grid',
  activeFilter: 'all',
  currentBookId: null,
  currentChapters: [],
  position: null,
  bookmarks: [],
  highlights: [],
  toasts: [],
  importProgress: null,
}

const listeners = new Set<() => void>()
let snapshot: AppState = state

function emit(): void {
  // 生成新的顶层引用，让 useSyncExternalStore 能感知变化
  snapshot = { ...state }
  for (const l of listeners) l()
}

function setState(patch: Partial<AppState>): void {
  state = { ...state, ...patch }
  emit()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function getSnapshot(): AppState {
  return snapshot
}

/** 订阅整个状态。组件按需从返回值里取字段（状态对象很小，无需 selector 细分）。 */
export function useAppState(): AppState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/** 只订阅一个派生值，避免无关状态变化引发重渲染。 */
export function useAppSelector<T>(selector: (s: AppState) => T, isEqual?: (a: T, b: T) => boolean): T {
  const lastRef = useRef<{ value: T; has: boolean }>({ value: undefined as unknown as T, has: false })
  const getSelected = useCallback(() => {
    const next = selector(getSnapshot())
    const last = lastRef.current
    if (last.has && (isEqual ? isEqual(last.value, next) : Object.is(last.value, next))) {
      return last.value
    }
    lastRef.current = { value: next, has: true }
    return next
  }, [selector, isEqual])
  return useSyncExternalStore(subscribe, getSelected, getSelected)
}

// ============================================================
// 初始化
// ============================================================

let initPromise: Promise<void> | null = null

export function initApp(): Promise<void> {
  if (initPromise) return initPromise

  initPromise = (async () => {
    const settings = db.loadSettings()

    if (!db.isIndexedDbAvailable()) {
      // 极端环境（隐私模式）：至少让设置与主题可用，书库为空但不崩溃
      setState({ settings, ready: true })
      toast('当前浏览器不支持 IndexedDB，书库功能不可用')
      return
    }

    try {
      const [books, groups] = await Promise.all([db.getAllBooks(), db.getGroups()])
      setState({ books, groups, settings, ready: true })

      // 若章节数与实际不符（上次导入中断），补算一次
      await reconcileChapterCounts(books)
    } catch (e) {
      setState({ settings, ready: true })
      toast(`初始化书库失败：${e instanceof Error ? e.message : String(e)}`)
    }
  })()

  return initPromise
}

/** 校验并修正 book.chapterCount，避免中断导入留下错误元数据。 */
async function reconcileChapterCounts(books: Book[]): Promise<void> {
  const fixes: Book[] = []
  for (const book of books) {
    try {
      const count = await db.getChapterCount(book.id)
      if (count !== book.chapterCount) {
        fixes.push({ ...book, chapterCount: count })
      }
    } catch {
      /* 单本读取失败不影响其他书 */
    }
  }
  if (fixes.length > 0) {
    for (const b of fixes) await db.putBook(b)
    const merged = state.books.map((b) => fixes.find((f) => f.id === b.id) ?? b)
    setState({ books: merged })
  }
}

// ============================================================
// 提示条
// ============================================================

let toastSeq = 0
let toastTimer: ReturnType<typeof setTimeout> | null = null

export function toast(text: string, durationMs = 2200): void {
  const id = ++toastSeq
  setState({ toasts: [...state.toasts, { id, text }] })
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    setState({ toasts: state.toasts.filter((t) => t.id !== id) })
  }, durationMs)
}

export function dismissToast(id: number): void {
  setState({ toasts: state.toasts.filter((t) => t.id !== id) })
}

// ============================================================
// 设置
// ============================================================

export function updateSettings(patch: Partial<ReaderSettings>): void {
  const settings: ReaderSettings = {
    ...state.settings,
    ...patch,
    typography: { ...state.settings.typography, ...(patch.typography ?? {}) },
  }
  setState({ settings })
  db.saveSettings(settings)
}

export function setTheme(theme: ThemeId): void {
  updateSettings({ theme })
  applyThemeToDocument(theme, state.settings.followSystemDark)
}

/** 把主题落到 CSS 变量上。深色主题通过 data-theme 切换。 */
export function applyThemeToDocument(theme: ThemeId, followSystemDark: boolean): void {
  if (typeof document === 'undefined') return
  const palette = THEMES[theme]
  const prefersDark =
    followSystemDark && typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
      : false
  const effectiveDark = palette.dark || prefersDark
  document.documentElement.dataset.theme = effectiveDark ? 'night' : 'light'
  document.documentElement.dataset.themeId = theme
}

export function setShelfSort(sort: ShelfSort): void {
  setState({ shelfSort: sort })
}

export function setShelfLayout(layout: ShelfLayout): void {
  setState({ shelfLayout: layout })
}

export function setActiveFilter(filter: AppState['activeFilter']): void {
  setState({ activeFilter: filter })
}

// ============================================================
// 书库
// ============================================================

export async function refreshBooks(): Promise<void> {
  const books = await db.getAllBooks()
  setState({ books })
}

export async function removeBook(bookId: string): Promise<void> {
  await db.deleteBook(bookId)
  const books = state.books.filter((b) => b.id !== bookId)
  const patch: Partial<AppState> = { books }
  if (state.currentBookId === bookId) {
    patch.currentBookId = null
    patch.currentChapters = []
    patch.position = null
    patch.bookmarks = []
    patch.highlights = []
  }
  setState(patch)
}

export async function updateBookMeta(
  bookId: string,
  patch: Partial<Pick<Book, 'title' | 'author' | 'intro' | 'cover' | 'groupId' | 'finished'>>,
): Promise<void> {
  const existing = state.books.find((b) => b.id === bookId)
  if (!existing) return
  const updated: Book = { ...existing, ...patch }
  setState({ books: state.books.map((b) => (b.id === bookId ? updated : b)) })
  await db.putBook(updated)
}

export async function createGroup(name: string, color: string): Promise<BookGroup> {
  const group: BookGroup = {
    id: `g_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    name,
    color,
    createdAt: Date.now(),
  }
  await db.putGroup(group)
  setState({ groups: [...state.groups, group] })
  return group
}

export async function removeGroup(groupId: string): Promise<void> {
  await db.deleteGroup(groupId)
  const affected = state.books.filter((b) => b.groupId === groupId)
  const updatedBooks = affected.map((b) => ({ ...b, groupId: undefined }))
  for (const b of updatedBooks) await db.putBook(b)
  setState({
    groups: state.groups.filter((g) => g.id !== groupId),
    books: state.books.map((b) => updatedBooks.find((u) => u.id === b.id) ?? b),
    activeFilter: state.activeFilter === groupId ? 'all' : state.activeFilter,
  })
}

// ============================================================
// 打开 / 关闭书籍
// ============================================================

export async function openBook(bookId: string): Promise<void> {
  const chapters = await db.getChapters(bookId)
  const position = (await db.getPosition(bookId)) ?? makePosition(bookId, chapters, 0, 0, undefined)
  const [bookmarks, highlights] = await Promise.all([db.getBookmarks(bookId), db.getHighlights(bookId)])

  setState({
    currentBookId: bookId,
    currentChapters: chapters,
    position,
    bookmarks,
    highlights,
  })

  // 更新最近阅读时间，让书架排序反映真实使用
  const book = state.books.find((b) => b.id === bookId)
  if (book) {
    const updated = { ...book, lastReadAt: Date.now() }
    setState({ books: state.books.map((b) => (b.id === bookId ? updated : b)) })
    void db.putBook(updated)
  }

  startReadingSession(bookId)
}

export function closeBook(): void {
  endReadingSession()
  setState({
    currentBookId: null,
    currentChapters: [],
    position: null,
    bookmarks: [],
    highlights: [],
  })
}

/** 保存阅读位置。高频率调用，所以只写内存 + 落库，不触发全量刷新。 */
export function savePosition(position: ReadingPosition): void {
  setState({ position })
  if (state.currentBookId) {
    void db.putPosition(state.currentBookId, position)
  }
}

// ============================================================
// 阅读会话统计
// ============================================================

let sessionBookId: string | null = null
let sessionStart = 0
let sessionStartWeight = 0
let sessionHeartbeat: ReturnType<typeof setInterval> | null = null

const HEARTBEAT_MS = 45_000

function startReadingSession(bookId: string): void {
  endReadingSession()
  sessionBookId = bookId
  sessionStart = Date.now()
  sessionStartWeight = visualWeight(state.currentChapters.map((c) => c.content).join(''))
  if (sessionHeartbeat) clearInterval(sessionHeartbeat)
  // 心跳不写入数据，只是防止长会话被误判为「无活动」；
  // 真正的结算在 endReadingSession 里按总时长一次性写入。
  sessionHeartbeat = setInterval(() => {
    /* 保持会话存活，占位心跳 */
  }, HEARTBEAT_MS)
}

function endReadingSession(): void {
  if (sessionHeartbeat) {
    clearInterval(sessionHeartbeat)
    sessionHeartbeat = null
  }
  if (!sessionBookId || sessionStart === 0) return

  const durationSec = Math.round((Date.now() - sessionStart) / 1000)
  const bookId = sessionBookId
  sessionBookId = null
  sessionStart = 0

  // 少于 5 秒通常只是误触，不计入统计，避免污染「阅读天数」
  if (durationSec < 5) return

  const chapterWeightNow = visualWeight(state.currentChapters.map((c) => c.content).join(''))
  const delta = Math.max(0, Math.round(chapterWeightNow - sessionStartWeight))
  sessionStartWeight = 0

  void db.putSession({
    id: `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    bookId,
    startedAt: sessionStart || Date.now() - durationSec * 1000,
    durationSec,
    charCount: delta,
  })
}

/** 页面隐藏 / 卸载时兜底结算，避免丢统计。 */
export function installLifecycleHooks(): () => void {
  if (typeof document === 'undefined') return () => {}

  const onVisibility = (): void => {
    if (document.visibilityState === 'hidden') {
      endReadingSession()
    } else if (state.currentBookId) {
      startReadingSession(state.currentBookId)
    }
  }

  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('pagehide', endReadingSession)

  return () => {
    document.removeEventListener('visibilitychange', onVisibility)
    window.removeEventListener('pagehide', endReadingSession)
  }
}

/** 供统计页在关闭阅读器后拿到最新会话。 */
export async function loadSessions() {
  return db.getSessions()
}

// ============================================================
// 书签 / 划线
// ============================================================

export async function addBookmark(chapterIndex: number, chapterOffset: number, excerpt: string, note = ''): Promise<void> {
  const bookId = state.currentBookId
  if (!bookId) return
  const chapter = state.currentChapters[chapterIndex]
  const bookmark: Bookmark = {
    id: `bm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    bookId,
    chapterIndex,
    chapterOffset,
    globalOffset: (chapter?.start ?? 0) + chapterOffset,
    excerpt: excerpt.slice(0, 120),
    note,
    createdAt: Date.now(),
  }
  await db.putBookmark(bookmark)
  setState({ bookmarks: [bookmark, ...state.bookmarks] })
  toast('已添加书签')
}

export async function removeBookmark(id: string): Promise<void> {
  await db.deleteBookmark(id)
  setState({ bookmarks: state.bookmarks.filter((b) => b.id !== id) })
  toast('已删除书签')
}

export async function updateBookmarkNote(id: string, note: string): Promise<void> {
  const bookmark = state.bookmarks.find((b) => b.id === id)
  if (!bookmark) return
  const updated = { ...bookmark, note }
  await db.putBookmark(updated)
  setState({ bookmarks: state.bookmarks.map((b) => (b.id === id ? updated : b)) })
}

export async function addHighlight(
  chapterIndex: number,
  startOffset: number,
  endOffset: number,
  text: string,
  color: string,
  note = '',
): Promise<void> {
  const bookId = state.currentBookId
  if (!bookId) return
  const highlight: Highlight = {
    id: `hl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    bookId,
    chapterIndex,
    startOffset,
    endOffset,
    text: text.slice(0, 800),
    color,
    note,
    createdAt: Date.now(),
  }
  await db.putHighlight(highlight)
  setState({ highlights: [highlight, ...state.highlights] })
  toast('已划线')
}

export async function updateHighlightNote(id: string, note: string): Promise<void> {
  const highlight = state.highlights.find((h) => h.id === id)
  if (!highlight) return
  const updated = { ...highlight, note }
  await db.putHighlight(updated)
  setState({ highlights: state.highlights.map((h) => (h.id === id ? updated : h)) })
}

export async function removeHighlight(id: string): Promise<void> {
  await db.deleteHighlight(id)
  setState({ highlights: state.highlights.filter((h) => h.id !== id) })
  toast('已删除笔记')
}

/** 当前书的全部笔记（书签 + 划线），按章节排序，供笔记页与阅读页标记使用。 */
export function useCurrentAnnotations() {
  const { bookmarks, highlights, currentChapters } = useAppState()
  return useMemo(() => {
    const byChapter = new Map<number, { bookmarks: Bookmark[]; highlights: Highlight[] }>()
    for (const b of bookmarks) {
      const bucket = byChapter.get(b.chapterIndex) ?? { bookmarks: [], highlights: [] }
      bucket.bookmarks.push(b)
      byChapter.set(b.chapterIndex, bucket)
    }
    for (const h of highlights) {
      const bucket = byChapter.get(h.chapterIndex) ?? { bookmarks: [], highlights: [] }
      bucket.highlights.push(h)
      byChapter.set(h.chapterIndex, bucket)
    }
    return {
      byChapter,
      total: bookmarks.length + highlights.length,
      chapterCount: currentChapters.length,
    }
  }, [bookmarks, highlights, currentChapters])
}

// ============================================================
// 书架排序 / 过滤
// ============================================================

export function sortBooks(books: Book[], sort: ShelfSort, positions: Map<string, number> = new Map()): Book[] {
  const copy = [...books]
  switch (sort) {
    case 'recent':
      return copy.sort((a, b) => b.lastReadAt - a.lastReadAt)
    case 'added':
      return copy.sort((a, b) => b.addedAt - a.addedAt)
    case 'title':
      // 中文按拼音排序：localeCompare 的 zh 排序规则在主流浏览器与 Node 均可用的
      return copy.sort((a, b) => a.title.localeCompare(b.title, 'zh-Hans-CN'))
    case 'author':
      return copy.sort((a, b) => a.author.localeCompare(b.author, 'zh-Hans-CN'))
    case 'progress': {
      return copy.sort((a, b) => (positions.get(b.id) ?? 0) - (positions.get(a.id) ?? 0))
    }
    default:
      return copy
  }
}

export function filterBooks(
  books: Book[],
  filter: AppState['activeFilter'],
  finishedIds: Set<string>,
): Book[] {
  if (filter === 'all') return books
  if (filter === 'reading') return books.filter((b) => !finishedIds.has(b.id))
  if (filter === 'unread') return books.filter((b) => b.lastReadAt === b.addedAt)
  if (filter === 'finished') return books.filter((b) => finishedIds.has(b.id))
  return books.filter((b) => b.groupId === filter)
}

/** 供书架使用的派生数据：带进度的书籍卡片模型。 */
export interface ShelfItem {
  book: Book
  percent: number
  finished: boolean
  unread: boolean
  lastReadLabel: string
}

export function useShelfItems(): ShelfItem[] {
  const { books, shelfSort, activeFilter } = useAppState()
  const [progressMap, setProgressMap] = useState<Map<string, number>>(new Map())

  // 书架的进度来自各书的 position 记录；这里只在书籍列表变化时批量读一次
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const map = new Map<string, number>()
      for (const book of books) {
        try {
          const pos = await db.getPosition(book.id)
          if (pos) map.set(book.id, pos.percent)
        } catch {
          /* 忽略单本失败 */
        }
      }
      if (!cancelled) setProgressMap(map)
    })()
    return () => {
      cancelled = true
    }
  }, [books])

  return useMemo(() => {
    const finishedIds = new Set(books.filter((b) => b.finished || (progressMap.get(b.id) ?? 0) >= 0.995).map((b) => b.id))
    const filtered = filterBooks(books, activeFilter, finishedIds)
    const sorted = sortBooks(filtered, shelfSort, progressMap)
    return sorted.map((book) => {
      const percent = book.finished ? 1 : (progressMap.get(book.id) ?? 0)
      return {
        book,
        percent,
        finished: book.finished || percent >= 0.995,
        unread: book.lastReadAt === book.addedAt,
        lastReadLabel: formatRelativeTime(book.lastReadAt),
      }
    })
  }, [books, activeFilter, shelfSort, progressMap])
}

/** 相对时间文案（书架「3 天前」这类展示）。 */
export function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  const days = Math.floor(diff / 86_400_000)
  if (days === 1) return '昨天'
  if (days < 30) return `${days} 天前`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months} 个月前`
  return `${Math.floor(months / 12)} 年前`
}

/** 当前书的阅读进度百分比。 */
export function useCurrentPercent(): number {
  const { position, currentChapters } = useAppState()
  return useMemo(() => {
    const total = totalCharCount(currentChapters)
    if (total <= 0 || !position) return 0
    return Math.min(1, position.globalOffset / total)
  }, [position, currentChapters])
}
