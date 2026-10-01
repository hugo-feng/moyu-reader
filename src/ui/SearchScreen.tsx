/**
 * 全文搜索页。
 *
 * 两种入口：
 *   - 书内搜索：直接在当前书的章节数组里搜；
 *   - 全局搜索：遍历书库，逐本加载章节后合并结果（受 500 条总量上限保护）。
 *
 * 关键取舍：
 *   - 结果按「章」分组（与 engine/search.ts 的输出结构一致），而不是平铺成几千条；
 *   - 摘录里的关键词高亮完全依赖引擎给出的 excerptMatchOffset / excerptMatchLength，
 *     UI 不做第二次查找 —— 否则「全词匹配 / 大小写敏感」的语义会在渲染层被破坏；
 *   - 查询防抖 250ms，避免每敲一个字就全库扫描（大书库下这是主要卡顿来源）。
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { Book, Chapter } from '../engine/types'
import { searchChapters } from '../engine/search'
import type { SearchMatch } from '../engine/search'
import * as db from '../storage'
import { useAppState } from '../store'
import { IconBack, IconClose, IconSearch } from './icons'

interface SearchScreenProps {
  onBack: () => void
  /** 指定书内搜索；不传则在全部书里搜索 */
  bookId?: string
  onJump: (bookId: string, chapterIndex: number, chapterOffset: number) => void
}

/** 全局搜索的总量硬上限，超出即截断并提示用户。 */
const GLOBAL_MAX_RESULTS = 500

/** 单章上限的候选值，0 表示不限。 */
const CAP_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 0, label: '不限' },
  { value: 20, label: '20' },
  { value: 50, label: '50' },
]

interface ResultGroup {
  key: string
  bookId: string
  bookTitle: string
  chapterIndex: number
  chapterTitle: string
  matches: SearchMatch[]
}

interface SearchResult {
  groups: ResultGroup[]
  /** 实际展示的匹配条数 */
  shown: number
  /** 命中的章节数（截断前的准确值） */
  chapters: number
  /** 命中总数（截断前的准确值） */
  total: number
  /** 是否因为总量上限而只展示了一部分 */
  truncated: boolean
  /** 因单章上限被裁掉匹配的书名（用于给出诚实提示） */
  cappedBooks: string[]
}

const EMPTY_RESULT: SearchResult = {
  groups: [],
  shown: 0,
  chapters: 0,
  total: 0,
  truncated: false,
  cappedBooks: [],
}

/** 把摘录切成「关键词前 / 关键词 / 关键词后」三段，只有中间那段包 mark。 */
function renderExcerpt(match: SearchMatch) {
  const text = match.excerpt
  const rawStart = match.excerptMatchOffset
  const rawLength = match.excerptMatchLength

  // 防御：引擎给出的偏移理论上总在范围内，但数据损坏时不能让它渲染出错误高亮
  if (!Number.isFinite(rawStart) || !Number.isFinite(rawLength) || rawLength <= 0) {
    return <>{text}</>
  }
  const start = Math.max(0, Math.min(Math.floor(rawStart), text.length))
  const end = Math.max(start, Math.min(start + Math.floor(rawLength), text.length))
  if (end === start) return <>{text}</>

  return (
    <>
      {text.slice(0, start)}
      <mark>{text.slice(start, end)}</mark>
      {text.slice(end)}
    </>
  )
}

export function SearchScreen({ onBack, bookId, onJump }: SearchScreenProps) {
  const { books } = useAppState()
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [wholeWord, setWholeWord] = useState(false)
  const [perChapter, setPerChapter] = useState(0)
  const [chaptersByBook, setChaptersByBook] = useState<Map<string, Chapter[]>>(new Map())
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<SearchResult>(EMPTY_RESULT)
  const inputRef = useRef<HTMLInputElement>(null)

  const targetBooks = useMemo<Book[]>(
    () => (bookId ? books.filter((b) => b.id === bookId) : books),
    [books, bookId],
  )

  // 搜索是纯同步计算，但章节要从 IndexedDB 读；这里一次性把候选书的章节读完
  useEffect(() => {
    let cancelled = false
    if (targetBooks.length === 0) {
      setChaptersByBook(new Map())
      setLoading(false)
      return
    }
    setLoading(true)
    void (async () => {
      const next = new Map<string, Chapter[]>()
      for (const book of targetBooks) {
        try {
          next.set(book.id, await db.getChapters(book.id))
        } catch {
          next.set(book.id, [])
        }
      }
      if (cancelled) return
      setChaptersByBook(next)
      setLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [targetBooks])

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query), 250)
    return () => clearTimeout(timer)
  }, [query])

  useEffect(() => {
    const trimmed = debounced.trim()
    if (!trimmed) {
      setResult(EMPTY_RESULT)
      return
    }

    const groups: ResultGroup[] = []
    const cappedBooks: string[] = []
    let shown = 0
    let total = 0
    let truncated = false
    let hitGlobalLimit = false
    const maxPerChapter = perChapter > 0 ? perChapter : undefined

    for (const book of targetBooks) {
      if (hitGlobalLimit) break
      const bookChapters = chaptersByBook.get(book.id)
      if (!bookChapters || bookChapters.length === 0) continue

      // 第一遍：不限单章条数，拿到「这本书到底命中多少」的准确值，供结果摘要与截断判断使用
      const full = searchChapters(book.id, bookChapters, trimmed, {
        caseSensitive,
        wholeWord,
        maxPerChapter: undefined,
      })
      if (full.total === 0) continue
      total += full.total

      // 第二遍：按单章上限裁剪；多取 1 条，用来发现「这一章是不是被上限截了」
      // 「不限」时不需要第二遍，直接用第一遍的结果，省掉一次全章扫描。
      const limited =
        maxPerChapter === undefined
          ? full
          : searchChapters(book.id, bookChapters, trimmed, {
              caseSensitive,
              wholeWord,
              maxPerChapter: maxPerChapter + 1,
            })

      let expectedKept = 0
      for (const group of full.groups) {
        expectedKept +=
          maxPerChapter === undefined
            ? group.matches.length
            : Math.min(group.matches.length, maxPerChapter)
      }
      if (expectedKept < full.total) cappedBooks.push(book.title)

      let finalKept = 0
      for (const group of limited.groups) {
        let matches = group.matches
        if (maxPerChapter !== undefined && matches.length > maxPerChapter) {
          matches = matches.slice(0, maxPerChapter)
        }
        if (matches.length === 0) continue

        const room = Math.max(0, GLOBAL_MAX_RESULTS - shown)
        const kept = matches.length > room ? matches.slice(0, room) : matches
        if (kept.length > 0) {
          groups.push({
            key: `${book.id}#${group.chapterIndex}`,
            bookId: book.id,
            bookTitle: book.title,
            chapterIndex: group.chapterIndex,
            chapterTitle: group.chapterTitle || `第 ${group.chapterIndex + 1} 章`,
            matches: kept,
          })
          shown += kept.length
          finalKept += kept.length
        }
        if (shown >= GLOBAL_MAX_RESULTS) {
          hitGlobalLimit = true
          break
        }
      }

      // 展示数少于上限定下的预期，说明剩下的命中被总量上限吃掉了
      if (finalKept < expectedKept) hitGlobalLimit = true
    }
    truncated = hitGlobalLimit

    setResult({
      groups,
      shown,
      chapters: groups.length,
      total,
      truncated,
      cappedBooks,
    })
  }, [debounced, caseSensitive, wholeWord, perChapter, targetBooks, chaptersByBook])

  const busy = loading || (query.trim() !== '' && query !== debounced)

  return (
    <div className="screen">
      <div className="topbar">
        <button
          type="button"
          aria-label="返回"
          onClick={onBack}
          style={{ background: 'transparent' }}
        >
          <IconBack />
        </button>
        <div className="topbar__title">{bookId ? '书内搜索' : '全书搜索'}</div>
        <div aria-hidden="true" style={{ width: 44, minWidth: 44, flexShrink: 0 }} />
      </div>

      <div style={{ padding: '10px 12px 6px', background: 'var(--paper-surface)' }}>
        <div
          className="row"
          style={{
            gap: 8,
            background: 'var(--paper-card)',
            border: '1px solid var(--line)',
            borderRadius: 'var(--radius-sm)',
            padding: '0 10px',
          }}
        >
          <IconSearch size={18} style={{ color: 'var(--ink-mute)', flexShrink: 0 }} />
          <input
            ref={inputRef}
            type="search"
            value={query}
            autoFocus
            onChange={(e) => setQuery(e.target.value)}
            placeholder="输入关键词，回车不必要"
            aria-label="搜索关键词"
            enterKeyHint="search"
            style={{
              border: 'none',
              background: 'transparent',
              boxShadow: 'none',
              padding: '10px 0',
            }}
          />
          {query ? (
            <button
              type="button"
              aria-label="清空关键词"
              onClick={() => {
                setQuery('')
                setDebounced('')
                inputRef.current?.focus()
              }}
              style={{ minWidth: 36, minHeight: 36, color: 'var(--ink-mute)' }}
            >
              <IconClose size={18} />
            </button>
          ) : null}
        </div>

        <div className="row" style={{ gap: 10, marginTop: 9, flexWrap: 'wrap' }}>
          <button
            type="button"
            className="chip"
            aria-pressed={caseSensitive}
            onClick={() => setCaseSensitive((v) => !v)}
            style={caseSensitive ? { borderColor: 'var(--accent-soft)' } : undefined}
          >
            <span className={`switch ${caseSensitive ? 'switch--on' : ''}`} aria-hidden="true" />
            区分大小写
          </button>
          <button
            type="button"
            className="chip"
            aria-pressed={wholeWord}
            onClick={() => setWholeWord((v) => !v)}
            style={wholeWord ? { borderColor: 'var(--accent-soft)' } : undefined}
          >
            <span className={`switch ${wholeWord ? 'switch--on' : ''}`} aria-hidden="true" />
            全词匹配
          </button>
          <span className="text-sm text-mute" style={{ marginLeft: 'auto' }}>
            单章上限
          </span>
          <span className="segmented">
            {CAP_OPTIONS.map((opt) => (
              <button
                type="button"
                key={opt.value}
                className={perChapter === opt.value ? 'segmented__item--active' : undefined}
                aria-pressed={perChapter === opt.value}
                onClick={() => setPerChapter(opt.value)}
              >
                {opt.label}
              </button>
            ))}
          </span>
        </div>
      </div>

      <div className="scroll-area">
        {!query.trim() ? (
          <div className="empty">
            <div className="empty__icon">
              <IconSearch size={34} />
            </div>
            <div className="empty__title">搜索正文</div>
            <div className="empty__desc">
              {bookId ? '在当前这本书里查找关键词。' : '在全部书里查找关键词，结果按章分组展示。'}
            </div>
          </div>
        ) : busy ? (
          <div className="search-summary">正在搜索…</div>
        ) : result.shown === 0 ? (
          <div className="empty">
            <div className="empty__icon">
              <IconSearch size={34} />
            </div>
            <div className="empty__title">没有找到「{debounced.trim()}」</div>
            <div className="empty__desc">
              换个关键词试试，或关闭「全词匹配」/「区分大小写」再搜一次。
            </div>
          </div>
        ) : (
          <>
            <div className="search-summary">
              在 {result.chapters} 章中找到 {result.shown} 处匹配
              {result.truncated ? (
                <span style={{ color: 'var(--danger)' }}>
                  {' '}
                  命中过多，仅展示前 {GLOBAL_MAX_RESULTS} 条（全书共 {result.total} 处）
                </span>
              ) : null}
              {result.cappedBooks.length > 0 ? (
                <span className="text-mute">
                  {' '}
                  ；《{result.cappedBooks.slice(0, 3).join('》《')}
                  {result.cappedBooks.length > 3 ? ' 等' : ''}》单章命中较多，已按上限截取
                </span>
              ) : null}
            </div>

            {result.groups.map((group) => (
              <div className="search-result-group" key={group.key}>
                <div className="search-result-group__head">
                  <span className="search-result-group__title">
                    {bookId ? group.chapterTitle : `${group.bookTitle}：${group.chapterTitle}`}
                  </span>
                  <span className="search-result-group__count">{group.matches.length} 处</span>
                </div>
                {group.matches.map((match, i) => (
                  <button
                    type="button"
                    key={`${match.chapterIndex}-${match.chapterOffset}-${i}`}
                    className="search-hit"
                    onClick={() => onJump(match.bookId, match.chapterIndex, match.chapterOffset)}
                  >
                    {renderExcerpt(match)}
                  </button>
                ))}
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  )
}
