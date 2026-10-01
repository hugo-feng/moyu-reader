/**
 * 持久化层（IndexedDB）。
 *
 * 为什么不只用 localStorage：一本 3 MB 的 TXT 分章后是上千条章节记录，
 * localStorage 有 5 MB 上限且是同步 API（会阻塞主线程），完全不适合。
 * IndexedDB 支持大容量、异步、按索引查询，是阅读器书库的正确选择。
 *
 * 设计要点：
 *   - 章节单独建表并用 `bookId` 建索引，使「只读当前章」成为可能，
 *     避免打开一本书就把整本加载进内存（大文件下这是致命的）；
 *   - 设置项走 localStorage（小、同步、要立刻读到以避免主题闪烁）；
 *   - 所有写入都是 upsert 语义，重复导入同一本书不会产生脏数据。
 */

import type {
  Book,
  BookGroup,
  Bookmark,
  Chapter,
  Highlight,
  ReadingPosition,
  ReadingSession,
  ReaderSettings,
} from './engine/types'
import { DEFAULT_SETTINGS } from './engine/types'
import { normalizeText } from './engine/encoding'
import { splitChapters } from './engine/chapters'
import { positionFromGlobalOffset } from './engine/progress'

const DB_NAME = 'moyu-reader'
const DB_VERSION = 1

export const STORE = {
  books: 'books',
  chapters: 'chapters',
  positions: 'positions',
  bookmarks: 'bookmarks',
  highlights: 'highlights',
  sessions: 'sessions',
  groups: 'groups',
  dictionary: 'dictionary',
} as const

export type StoreName = (typeof STORE)[keyof typeof STORE]

let dbPromise: Promise<IDBDatabase> | null = null

/** 是否支持 IndexedDB（隐私模式下可能不可用）。 */
export function isIndexedDbAvailable(): boolean {
  return typeof indexedDB !== 'undefined'
}

export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise

  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    if (!isIndexedDbAvailable()) {
      reject(new Error('当前环境不支持 IndexedDB'))
      return
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onupgradeneeded = () => {
      const db = request.result

      if (!db.objectStoreNames.contains(STORE.books)) {
        const books = db.createObjectStore(STORE.books, { keyPath: 'id' })
        books.createIndex('lastReadAt', 'lastReadAt')
        books.createIndex('addedAt', 'addedAt')
        books.createIndex('groupId', 'groupId')
        books.createIndex('title', 'title')
      }

      if (!db.objectStoreNames.contains(STORE.chapters)) {
        const chapters = db.createObjectStore(STORE.chapters, { keyPath: ['bookId', 'index'] })
        // 复合主键 + bookId 索引，使「取某本书的全部章节」是一次索引扫描
        chapters.createIndex('bookId', 'bookId')
      }

      if (!db.objectStoreNames.contains(STORE.positions)) {
        db.createObjectStore(STORE.positions, { keyPath: 'bookId' })
      }

      if (!db.objectStoreNames.contains(STORE.bookmarks)) {
        const bookmarks = db.createObjectStore(STORE.bookmarks, { keyPath: 'id' })
        bookmarks.createIndex('bookId', 'bookId')
        bookmarks.createIndex('createdAt', 'createdAt')
      }

      if (!db.objectStoreNames.contains(STORE.highlights)) {
        const highlights = db.createObjectStore(STORE.highlights, { keyPath: 'id' })
        highlights.createIndex('bookId', 'bookId')
        highlights.createIndex('createdAt', 'createdAt')
      }

      if (!db.objectStoreNames.contains(STORE.sessions)) {
        const sessions = db.createObjectStore(STORE.sessions, { keyPath: 'id' })
        sessions.createIndex('bookId', 'bookId')
        sessions.createIndex('startedAt', 'startedAt')
      }

      if (!db.objectStoreNames.contains(STORE.groups)) {
        db.createObjectStore(STORE.groups, { keyPath: 'id' })
      }

      if (!db.objectStoreNames.contains(STORE.dictionary)) {
        db.createObjectStore(STORE.dictionary, { keyPath: 'id' })
      }
    }

    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB 打开失败'))
    request.onblocked = () => reject(new Error('IndexedDB 被其他标签页阻塞，请关闭其他页面后重试'))
  })

  return dbPromise
}

/** 通用事务封装。 */
async function tx<T>(store: StoreName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | null): Promise<T | undefined> {
  const db = await openDb()
  return new Promise<T | undefined>((resolve, reject) => {
    const transaction = db.transaction(store, mode)
    const objectStore = transaction.objectStore(store)
    let result: T | undefined
    const request = fn(objectStore)
    if (request) {
      request.onsuccess = () => {
        result = request.result
      }
    }
    transaction.oncomplete = () => resolve(result)
    transaction.onerror = () => reject(transaction.error ?? new Error('事务失败'))
    transaction.onabort = () => reject(transaction.error ?? new Error('事务被中止'))
  })
}

/** 取全部记录（可带索引与范围）。 */
async function getAllBy<T>(store: StoreName, indexName?: string, query?: IDBValidKey | IDBKeyRange): Promise<T[]> {
  const db = await openDb()
  return new Promise<T[]>((resolve, reject) => {
    const transaction = db.transaction(store, 'readonly')
    const objectStore = transaction.objectStore(store)
    const source = indexName ? objectStore.index(indexName) : objectStore
    const request = query !== undefined ? source.getAll(query) : source.getAll()
    request.onsuccess = () => resolve(request.result as T[])
    request.onerror = () => reject(request.error ?? new Error('读取失败'))
  })
}

/** 批量写入（单事务，比逐条快一个数量级）。 */
async function putMany<T>(store: StoreName, items: T[]): Promise<void> {
  if (items.length === 0) return
  const db = await openDb()
  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(store, 'readwrite')
    const objectStore = transaction.objectStore(store)
    for (const item of items) objectStore.put(item)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error('批量写入失败'))
    transaction.onabort = () => reject(transaction.error ?? new Error('批量写入被中止'))
  })
}

// ============================================================
// 书籍
// ============================================================

export async function putBook(book: Book): Promise<void> {
  await tx(STORE.books, 'readwrite', (s) => s.put(book))
}

export async function getBook(id: string): Promise<Book | undefined> {
  return tx<Book>(STORE.books, 'readonly', (s) => s.get(id))
}

export async function getAllBooks(): Promise<Book[]> {
  const books = await getAllBy<Book>(STORE.books)
  return books.sort((a, b) => b.lastReadAt - a.lastReadAt)
}

export async function deleteBook(id: string): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(
      [STORE.books, STORE.chapters, STORE.positions, STORE.bookmarks, STORE.highlights, STORE.sessions],
      'readwrite',
    )
    transaction.objectStore(STORE.books).delete(id)
    transaction.objectStore(STORE.positions).delete(id)

    // 章节按 bookId 索引游标删除
    const chapterIndex = transaction.objectStore(STORE.chapters).index('bookId')
    chapterIndex.openCursor(IDBKeyRange.only(id)).onsuccess = (e) => {
      const cursor = (e.target as IDBRequest<IDBCursorWithValue | null>).result
      if (cursor) {
        cursor.delete()
        cursor.continue()
      }
    }

    for (const store of [STORE.bookmarks, STORE.highlights, STORE.sessions]) {
      const idx = transaction.objectStore(store).index('bookId')
      idx.openCursor(IDBKeyRange.only(id)).onsuccess = (e) => {
        const cursor = (e.target as IDBRequest<IDBCursorWithValue | null>).result
        if (cursor) {
          cursor.delete()
          cursor.continue()
        }
      }
    }

    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error('删除书籍失败'))
  })
}

// ============================================================
// 章节
// ============================================================

export async function putChapters(chapters: Chapter[]): Promise<void> {
  await putMany(STORE.chapters, chapters)
}

export async function putChapter(chapter: Chapter): Promise<void> {
  await tx(STORE.chapters, 'readwrite', (s) => s.put(chapter))
}

export async function getChapters(bookId: string): Promise<Chapter[]> {
  const chapters = await getAllBy<Chapter>(STORE.chapters, 'bookId', IDBKeyRange.only(bookId))
  return chapters.sort((a, b) => a.index - b.index)
}

export async function getChapter(bookId: string, index: number): Promise<Chapter | undefined> {
  return tx<Chapter>(STORE.chapters, 'readonly', (s) => s.get([bookId, index]))
}

export async function getChapterCount(bookId: string): Promise<number> {
  const db = await openDb()
  return new Promise<number>((resolve, reject) => {
    const transaction = db.transaction(STORE.chapters, 'readonly')
    const request = transaction.objectStore(STORE.chapters).index('bookId').count(IDBKeyRange.only(bookId))
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('统计章节失败'))
  })
}

// ============================================================
// 阅读位置
// ============================================================

export async function putPosition(bookId: string, position: ReadingPosition): Promise<void> {
  await tx(STORE.positions, 'readwrite', (s) => s.put({ ...position, bookId }))
}

export async function getPosition(bookId: string): Promise<ReadingPosition | undefined> {
  return tx<ReadingPosition & { bookId: string }>(STORE.positions, 'readonly', (s) => s.get(bookId))
}

export async function putPositions(items: Array<{ bookId: string; position: ReadingPosition }>): Promise<void> {
  await putMany(
    STORE.positions,
    items.map((i) => ({ ...i.position, bookId: i.bookId })),
  )
}

// ============================================================
// 书签 / 划线 / 会话 / 分组
// ============================================================

export async function putBookmark(bookmark: Bookmark): Promise<void> {
  await tx(STORE.bookmarks, 'readwrite', (s) => s.put(bookmark))
}

export async function getBookmarks(bookId?: string): Promise<Bookmark[]> {
  const items = bookId
    ? await getAllBy<Bookmark>(STORE.bookmarks, 'bookId', IDBKeyRange.only(bookId))
    : await getAllBy<Bookmark>(STORE.bookmarks)
  return items.sort((a, b) => b.createdAt - a.createdAt)
}

export async function deleteBookmark(id: string): Promise<void> {
  await tx(STORE.bookmarks, 'readwrite', (s) => s.delete(id))
}

export async function putHighlight(highlight: Highlight): Promise<void> {
  await tx(STORE.highlights, 'readwrite', (s) => s.put(highlight))
}

export async function getHighlights(bookId?: string): Promise<Highlight[]> {
  const items = bookId
    ? await getAllBy<Highlight>(STORE.highlights, 'bookId', IDBKeyRange.only(bookId))
    : await getAllBy<Highlight>(STORE.highlights)
  return items.sort((a, b) => b.createdAt - a.createdAt)
}

export async function deleteHighlight(id: string): Promise<void> {
  await tx(STORE.highlights, 'readwrite', (s) => s.delete(id))
}

export async function putSession(session: ReadingSession & { id: string }): Promise<void> {
  await tx(STORE.sessions, 'readwrite', (s) => s.put(session))
}

export async function getSessions(): Promise<ReadingSession[]> {
  return getAllBy<ReadingSession>(STORE.sessions)
}

export async function putGroup(group: BookGroup): Promise<void> {
  await tx(STORE.groups, 'readwrite', (s) => s.put(group))
}

export async function getGroups(): Promise<BookGroup[]> {
  const groups = await getAllBy<BookGroup>(STORE.groups)
  return groups.sort((a, b) => a.createdAt - b.createdAt)
}

export async function deleteGroup(id: string): Promise<void> {
  await tx(STORE.groups, 'readwrite', (s) => s.delete(id))
}

// ============================================================
// 用户词典
// ============================================================

export interface StoredDictionary {
  id: string
  name: string
  zh: Record<string, { phonetic?: string; senses: Array<{ definition: string }> }>
  en: Record<string, { phonetic?: string; senses: Array<{ definition: string }> }>
  importedAt: number
}

export async function putDictionary(dict: StoredDictionary): Promise<void> {
  await tx(STORE.dictionary, 'readwrite', (s) => s.put(dict))
}

export async function getDictionaries(): Promise<StoredDictionary[]> {
  return getAllBy<StoredDictionary>(STORE.dictionary)
}

export async function deleteDictionary(id: string): Promise<void> {
  await tx(STORE.dictionary, 'readwrite', (s) => s.delete(id))
}

// ============================================================
// 设置（localStorage：小、同步，避免首屏主题闪烁）
// ============================================================

const SETTINGS_KEY = 'moyu.settings.v1'

export function loadSettings(): ReaderSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (!raw) return { ...DEFAULT_SETTINGS }
    const parsed = JSON.parse(raw) as Partial<ReaderSettings>
    // 与默认值深合并：升级新增字段时不会因为旧数据缺字段而崩溃
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      typography: { ...DEFAULT_SETTINGS.typography, ...(parsed.typography ?? {}) },
    }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export function saveSettings(settings: ReaderSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
  } catch {
    /* 隐私模式下可能失败，静默忽略：设置丢失不影响阅读 */
  }
}

// ============================================================
// 全量导出 / 导入（备份与跨设备迁移）
// ============================================================

export interface BackupPayload {
  version: number
  exportedAt: number
  books: Book[]
  chapters: Chapter[]
  positions: Array<ReadingPosition & { bookId: string }>
  bookmarks: Bookmark[]
  highlights: Highlight[]
  sessions: ReadingSession[]
  groups: BookGroup[]
  settings: ReaderSettings
}

export async function exportBackup(settings: ReaderSettings): Promise<BackupPayload> {
  const [books, chapters, bookmarks, highlights, sessions, groups] = await Promise.all([
    getAllBooks(),
    getAllBy<Chapter>(STORE.chapters),
    getBookmarks(),
    getHighlights(),
    getSessions(),
    getGroups(),
  ])
  const positions: Array<ReadingPosition & { bookId: string }> = await getAllBy(STORE.positions)

  return {
    version: 1,
    exportedAt: Date.now(),
    books,
    chapters,
    positions,
    bookmarks,
    highlights,
    sessions,
    groups,
    settings,
  }
}

export async function importBackup(payload: BackupPayload): Promise<void> {
  await putMany(STORE.books, payload.books ?? [])
  await putMany(STORE.chapters, payload.chapters ?? [])
  await putMany(STORE.positions, payload.positions ?? [])
  await putMany(STORE.bookmarks, payload.bookmarks ?? [])
  await putMany(STORE.highlights, payload.highlights ?? [])
  await putMany(STORE.sessions, payload.sessions ?? [])
  await putMany(STORE.groups, payload.groups ?? [])
  if (payload.settings) saveSettings(payload.settings)
}

/** 清空全部数据（设置页的「清除数据」）。 */
export async function clearAll(): Promise<void> {
  const db = await openDb()
  const stores: StoreName[] = [
    STORE.books,
    STORE.chapters,
    STORE.positions,
    STORE.bookmarks,
    STORE.highlights,
    STORE.sessions,
    STORE.groups,
    STORE.dictionary,
  ]
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(stores, 'readwrite')
    for (const s of stores) transaction.objectStore(s).clear()
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error('清除数据失败'))
  })
  try {
    localStorage.removeItem(SETTINGS_KEY)
  } catch {
    /* 忽略 */
  }
}

/**
 * 从纯文本构建书籍与章节（导入 TXT 的核心流程）。
 *
 * 抽成独立函数是为了让它可被单元测试，并且让「导入」这个副作用
 * 与「解析」这个纯计算分离。
 */
export function buildBookFromText(options: {
  id: string
  fileName: string
  text: string
  encoding: Book['encoding']
  groupId?: string
}): { book: Book; chapters: Chapter[] } {
  const text = normalizeText(options.text)
  const baseName = options.fileName.replace(/\.[^.]+$/, '')
  const chapters = splitChapters(text).map((c) => ({ ...c, bookId: options.id }))

  // 书名优先取首个章节标题前的书名行；否则用文件名
  let title = baseName
  const firstLines = text.slice(0, 300).split('\n').filter((l) => l.trim())
  if (firstLines.length > 0 && firstLines[0].length <= 40 && /《|书名|作者/.test(firstLines[0])) {
    const m = /《([^》]+)》/.exec(firstLines[0])
    title = m ? m[1] : firstLines[0]
  }

  // 作者：从「作者：xxx」提取
  let author = '佚名'
  const authorMatch = /作\s*者\s*[:：]\s*(\S{1,20})/.exec(text.slice(0, 1000))
  if (authorMatch) author = authorMatch[1]

  const now = Date.now()
  const chapterCount = chapters.length
  const charCount = text.length

  const book: Book = {
    id: options.id,
    title: title.trim() || baseName,
    author,
    intro: '',
    format: 'txt',
    encoding: options.encoding,
    charCount,
    chapterCount,
    sourceLength: charCount,
    groupId: options.groupId,
    finished: false,
    addedAt: now,
    lastReadAt: now,
  }

  return { book, chapters }
}

/** 保存一本书及其章节，并初始化阅读位置。 */
export async function saveBookWithChapters(book: Book, chapters: Chapter[]): Promise<void> {
  await putBook({ ...book, chapterCount: chapters.length })
  await putChapters(chapters)
  await putPosition(book.id, positionFromGlobalOffset(book.id, chapters, 0))
}
