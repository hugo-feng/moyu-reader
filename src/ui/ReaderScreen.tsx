/**
 * 阅读器主界面。
 *
 * 这是整个应用最核心也最复杂的组件，集中了四件难事：
 *
 * 1. **分页**：用 Canvas 度量做与 CSS 一致的文本宽度测量（中日韩字符按 1 em、
 *    ASCII 按 0.5 em），配合二分查找得出每页的字符区间。两边都按「字符数」而非
 *    「像素」排版，于是换字号后 DOM 的换行点与分页计算不会漂移。
 *
 * 2. **字符偏移定位**：点击/长按落在哪个字上，需要把「像素坐标」还原成「章内字符偏移」。
 *    做法是把每个段落渲染成独立元素并标注 `data-offset`，再用
 *    `caretRangeFromPoint` 取精确插入点；取不到时退化为按行高估算。
 *    这样书签、划线、查词、搜索跳转全都落在同一个坐标系上。
 *
 * 3. **翻页交互**：左/中/右三热区（主流小说 App 的通用手势），
 *    左区上一页、右区下一页、中间呼出工具栏；跨章时自动衔接。
 *
 * 4. **朗读与自动阅读**：两者都按「读完一页自动前进」的节奏推进，
 *    但朗读以句为单位可高亮当前句，自动阅读按字速定时前进。
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import type { Book, Chapter } from '../engine/types'
import { FONT_STACKS, THEMES } from '../engine/types'
import {
  pageIndexForOffset,
  paginateChapter,
  type MeasureText,
  type PageSlice,
} from '../engine/pagination'
import { makePosition, totalCharCount } from '../engine/progress'
import { locateMatches } from '../engine/search'
import { stripLeadingHeading } from '../engine/epub'
import { lookup, normalizeQuery, type DictLookupResult } from '../engine/dictionary'
import { useAppState, savePosition, updateSettings, toast, addBookmark, addHighlight } from '../store'
import { readerStyleVars, PAGE_MODE_LABELS } from './theme'
import {
  IconBack,
  IconBookmark,
  IconClose,
  IconDictionary,
  IconList,
  IconMinus,
  IconMoon,
  IconNote,
  IconPause,
  IconPlay,
  IconPlus,
  IconSearch,
  IconSpeaker,
  IconSun,
  IconText,
} from './icons'

// ============================================================
// 文本测量
// ============================================================

/** 是否为「全角」字符（中日韩文字、全角标点等），占 1 em 宽度。 */
export function isFullWidthCodePoint(cp: number): boolean {
  if (cp < 0x1100) return false
  return (
    cp <= 0x115f || // 谚文字母
    cp === 0x2329 ||
    cp === 0x232a ||
    (cp >= 0x2e80 && cp <= 0x303e) || // 中日韩部首、标点
    (cp >= 0x3041 && cp <= 0x33ff) || // 平假名、片假名、注音
    (cp >= 0x3400 && cp <= 0x4dbf) || // 扩展 A
    (cp >= 0x4e00 && cp <= 0x9fff) || // 基本汉字
    (cp >= 0xa000 && cp <= 0xa4cf) || // 彝文
    (cp >= 0xac00 && cp <= 0xd7a3) || // 谚文音节
    (cp >= 0xf900 && cp <= 0xfaff) || // 兼容汉字
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) || // 全角形式
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) || // emoji
    (cp >= 0x20000 && cp <= 0x3fffd) // 扩展 B 及以上
  )
}

/**
 * 按 CSS 排版规则测量文本宽度。
 *
 * 这个近似之所以可靠：阅读器用 `font-size` 控制字号，而中日韩字体中汉字的
 * 前进宽度恰好等于字号（1 em），拉丁字母平均约 0.5 em。由于分页与 DOM 都按
 * 「一行能放几个字」来断行，两者结果一致，不会出现分页与视觉错位。
 */
export function createMeasure(fontSize: number): MeasureText {
  return (text: string): number => {
    let width = 0
    // 用 codePointAt 遍历，避免代理对被拆成两个字符导致 emoji 宽度算错
    for (let i = 0; i < text.length; ) {
      const cp = text.codePointAt(i)
      if (cp === undefined) break
      if (cp === 0x0a || cp === 0x0d) {
        i += 1
        continue
      }
      width += isFullWidthCodePoint(cp) ? fontSize : fontSize * 0.5
      i += cp > 0xffff ? 2 : 1
    }
    return width
  }
}

// ============================================================
// 组件
// ============================================================

export interface ReaderScreenProps {
  book: Book
  chapters: Chapter[]
  onClose: () => void
  /** 打开全书搜索 */
  onOpenSearch?: (bookId: string) => void
  /** 打开本书笔记 */
  onOpenNotes?: (bookId: string) => void
  /**
   * 从搜索/笔记跳转进来时的目标位置。
   * 与「恢复上次阅读位置」的区别：这个优先级更高，且只在首次挂载时生效一次。
   */
  initialJump?: { bookId: string; chapterIndex: number; chapterOffset: number } | null
}

type SheetKind = 'none' | 'toc' | 'notes' | 'settings'

interface PendingSelection {
  start: number
  end: number
  text: string
}

export function ReaderScreen({ book, chapters, onClose, onOpenSearch, onOpenNotes, initialJump }: ReaderScreenProps) {
  const { settings, position, bookmarks, highlights } = useAppState()
  const palette = THEMES[settings.theme]
  const typography = settings.typography

  const stageRef = useRef<HTMLDivElement>(null)
  const textRef = useRef<HTMLDivElement>(null)

  const [stageSize, setStageSize] = useState({ width: 0, height: 0 })
  const [chapterIndex, setChapterIndex] = useState(position?.chapterIndex ?? 0)
  const [pageIndex, setPageIndex] = useState(0)
  const [sheet, setSheet] = useState<SheetKind>('none')
  const [chromeVisible, setChromeVisible] = useState(false)
  const [flipDirection, setFlipDirection] = useState<'forward' | 'backward'>('forward')
  const [flipToken, setFlipToken] = useState(0)
  const [selection, setSelection] = useState<PendingSelection | null>(null)
  const [dictOpen, setDictOpen] = useState(false)
  const [dictLoading, setDictLoading] = useState(false)
  const [dictResult, setDictResult] = useState<DictLookupResult | null>(null)
  const [tocQuery, setTocQuery] = useState('')
  const [tocReversed, setTocReversed] = useState(false)
  const [autoReading, setAutoReading] = useState(false)
  const [speaking, setSpeaking] = useState(false)
  const [noteDraft, setNoteDraft] = useState('')
  const [noteMode, setNoteMode] = useState<'bookmark' | 'highlight'>('bookmark')

  const chapter = chapters[Math.min(chapterIndex, Math.max(0, chapters.length - 1))]
  const isScrollMode = settings.pageMode === 'scroll'

  /**
   * 待定位偏移。换章时章节正文会变，分页结果也就变了，
   * 因此不能在 `jumpToChapter` 里立刻算页码 —— 必须等新章节分页完成后再定位。
   * 这里用一个 ref 承载「下一轮分页完成后要去的偏移」。
   */
  const pendingOffset = useRef<number | null>(null)

  // —— 视口尺寸监听：分页依赖可用区域大小，尺寸变化必须重新分页 ——
  useLayoutEffect(() => {
    const el = stageRef.current
    if (!el) return
    const update = () => {
      const rect = el.getBoundingClientRect()
      setStageSize({ width: rect.width, height: rect.height })
    }
    update()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // —— 分页计算 ——
  const metrics = useMemo(() => {
    const sidePad = typography.margin * 2
    const topPad = Math.round(typography.margin * 0.9)
    // 脚注（页码那一行）大约占 24px
    const footer = 26
    return {
      contentWidth: Math.max(40, stageSize.width - sidePad),
      contentHeight: Math.max(40, stageSize.height - topPad - footer),
      lineHeight: Math.max(1, typography.fontSize * typography.lineHeight),
    }
  }, [stageSize.width, stageSize.height, typography.margin, typography.fontSize, typography.lineHeight])

  const pages: PageSlice[] = useMemo(() => {
    if (!chapter || metrics.contentWidth <= 40) return [{ index: 0, start: 0, end: chapter?.content.length ?? 0 }]
    const measure = createMeasure(typography.fontSize)
    return paginateChapter(chapter.content, metrics, measure)
  }, [chapter, metrics, typography.fontSize])

  // 首次定位：优先使用跳转目标（来自搜索/笔记），否则恢复上次阅读位置
  const initialized = useRef(false)
  useEffect(() => {
    if (initialized.current || pages.length === 0) return
    initialized.current = true

    if (initialJump && initialJump.bookId === book.id) {
      const targetChapter = Math.max(0, Math.min(initialJump.chapterIndex, chapters.length - 1))
      if (targetChapter !== chapterIndex) {
        // 目标在别章：交给 pendingOffset 机制在换章后定位
        pendingOffset.current = initialJump.chapterOffset
        setChapterIndex(targetChapter)
        return
      }
      setPageIndex(pageIndexForOffset(pages, initialJump.chapterOffset))
      return
    }

    setPageIndex(pageIndexForOffset(pages, position?.chapterOffset ?? 0))
  }, [pages, position, initialJump, book.id, chapters.length, chapterIndex])

  // 排版变化导致页码越界时夹紧
  useEffect(() => {
    setPageIndex((p) => Math.min(p, Math.max(0, pages.length - 1)))
  }, [pages.length])

  const currentPage = pages[Math.min(pageIndex, Math.max(0, pages.length - 1))]

  // —— 位置持久化：翻页/换章后写入，节流 800ms ——
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const persist = useCallback(
    (chapterIdx: number, offset: number) => {
      if (persistTimer.current) clearTimeout(persistTimer.current)
      persistTimer.current = setTimeout(() => {
        savePosition(makePosition(book.id, chapters, chapterIdx, offset, undefined))
      }, 800)
    },
    [book.id, chapters],
  )

  useEffect(() => {
    if (!currentPage) return
    persist(chapterIndex, currentPage.start)
  }, [chapterIndex, currentPage, persist])

  // ============================================================
  // 翻页
  // ============================================================

  const flip = useCallback(
    (delta: 1 | -1) => {
      if (!currentPage) return
      setSelection(null)
      setDictOpen(false)

      const nextPage = pageIndex + delta
      setFlipDirection(delta > 0 ? 'forward' : 'backward')

      if (nextPage >= 0 && nextPage < pages.length) {
        setPageIndex(nextPage)
        setFlipToken((t) => t + 1)
        return
      }

      // 跨章
      const nextChapter = chapterIndex + delta
      if (nextChapter < 0 || nextChapter >= chapters.length) {
        toast(delta > 0 ? '已经是最后一章了' : '已经是第一章了')
        return
      }
      setChapterIndex(nextChapter)
      // 跳章后页码由 effect 依据保存位置设置，这里先把目标页定为章首/章末
      setPageIndex(delta > 0 ? 0 : Number.MAX_SAFE_INTEGER)
      setFlipToken((t) => t + 1)
    },
    [currentPage, pageIndex, pages.length, chapterIndex, chapters.length],
  )

  // 跨章时把「章末」的重置落到真实最后一页
  useEffect(() => {
    if (pageIndex === Number.MAX_SAFE_INTEGER) {
      setPageIndex(Math.max(0, pages.length - 1))
    }
  }, [pageIndex, pages.length])

  const jumpToChapter = useCallback(
    (index: number, offset = 0) => {
      const clamped = Math.max(0, Math.min(index, chapters.length - 1))
      setChapterIndex(clamped)
      setFlipDirection('forward')
      setFlipToken((t) => t + 1)
      setSelection(null)
      setDictOpen(false)
      setSheet('none')
      // 目标页在分页完成后由 offset 反查；这里先记录一个待定位偏移
      pendingOffset.current = offset
    },
    [chapters.length],
  )

  // —— 键盘：桌面端也可用 ——
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (dictOpen || sheet !== 'none') {
        if (e.key === 'Escape') {
          setDictOpen(false)
          setSheet('none')
        }
        return
      }
      if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') {
        e.preventDefault()
        flip(1)
      } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        e.preventDefault()
        flip(-1)
      } else if (e.key === 'Escape') {
        setChromeVisible((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [flip, dictOpen, sheet])

  // ============================================================
  // 选区 → 字符偏移
  // ============================================================

  /** 把段落内的 (node, offset) 换算成段落内的字符偏移。 */
  const offsetWithinParagraph = useCallback((node: Node, offset: number): number => {
    const paraEl = findParagraphElement(node)
    if (!paraEl) return 0
    const walker = document.createTreeWalker(paraEl, NodeFilter.SHOW_TEXT)
    let total = 0
    let current = walker.nextNode()
    while (current) {
      if (current === node) return total + offset
      total += current.textContent?.length ?? 0
      current = walker.nextNode()
    }
    return total
  }, [])

  /** 读取当前浏览器选区，换算成章内字符区间。 */
  const readSelection = useCallback((): PendingSelection | null => {
    if (typeof window === 'undefined') return null
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null

    const range = sel.getRangeAt(0)
    if (textRef.current && !textRef.current.contains(range.commonAncestorContainer)) return null

    const startPara = findParagraphElement(range.startContainer)
    const endPara = findParagraphElement(range.endContainer)
    if (!startPara || !endPara) return null

    const startBase = Number(startPara.dataset.offset ?? '0')
    const endBase = Number(endPara.dataset.offset ?? '0')
    const start = startBase + offsetWithinParagraph(range.startContainer, range.startOffset)
    const end = endBase + offsetWithinParagraph(range.endContainer, range.endOffset)
    if (end <= start) return null

    const text = (chapter?.content ?? '').slice(start, end)
    if (!text.trim()) return null
    return { start, end, text }
  }, [chapter, offsetWithinParagraph])

  /** 点击页面上的文字区域时尝试取到插入点，用于「单击选词」。 */
  const caretOffsetFromPoint = useCallback(
    (clientX: number, clientY: number): number | null => {
      type DocWithCaret = Document & {
        caretRangeFromPoint?: (x: number, y: number) => Range | null
        caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null
      }
      const doc = document as DocWithCaret
      let node: Node | null = null
      let offset = 0

      if (typeof doc.caretRangeFromPoint === 'function') {
        const range = doc.caretRangeFromPoint(clientX, clientY)
        if (range) {
          node = range.startContainer
          offset = range.startOffset
        }
      } else if (typeof doc.caretPositionFromPoint === 'function') {
        const pos = doc.caretPositionFromPoint(clientX, clientY)
        if (pos) {
          node = pos.offsetNode
          offset = pos.offset
        }
      }
      if (!node) return null
      const paraEl = findParagraphElement(node)
      if (!paraEl) return null
      return Number(paraEl.dataset.offset ?? '0') + offsetWithinParagraph(node, offset)
    },
    [offsetWithinParagraph],
  )

  // 选区变化时记录，供书签/划线使用
  useEffect(() => {
    const onSelectionChange = () => {
      const next = readSelection()
      setSelection(next)
    }
    document.addEventListener('selectionchange', onSelectionChange)
    return () => document.removeEventListener('selectionchange', onSelectionChange)
  }, [readSelection])

  // ============================================================
  // 自动阅读
  // ============================================================

  useEffect(() => {
    if (!autoReading || isScrollMode) return
    if (!currentPage) return
    const chars = Math.max(1, currentPage.end - currentPage.start)
    const speed = Math.max(4, settings.autoReadSpeed)
    const durationMs = Math.max(1200, (chars / speed) * 1000)
    const timer = setTimeout(() => {
      if (pageIndex >= pages.length - 1 && chapterIndex >= chapters.length - 1) {
        setAutoReading(false)
        toast('全书已读完')
        return
      }
      flip(1)
    }, durationMs)
    return () => clearTimeout(timer)
  }, [autoReading, currentPage, pageIndex, pages.length, chapterIndex, chapters.length, settings.autoReadSpeed, flip, isScrollMode])

  // ============================================================
  // 朗读（TTS）
  // ============================================================

  const ttsSupported = typeof window !== 'undefined' && 'speechSynthesis' in window

  const stopSpeaking = useCallback(() => {
    if (ttsSupported) window.speechSynthesis.cancel()
    setSpeaking(false)
  }, [ttsSupported])

  const startSpeaking = useCallback(() => {
    if (!ttsSupported || !currentPage || !chapter) {
      toast('当前环境不支持朗读')
      return
    }
    window.speechSynthesis.cancel()
    const text = chapter.content
      .slice(currentPage.start, currentPage.end)
      .replace(/\n+/g, '。')
      .slice(0, 1200)
    if (!text.trim()) return

    const utterance = new SpeechSynthesisUtterance(text)
    utterance.rate = settings.ttsRate
    utterance.pitch = settings.ttsPitch
    utterance.lang = 'zh-CN'
    utterance.onend = () => {
      // 一页读完自动翻页继续
      if (pageIndex >= pages.length - 1 && chapterIndex >= chapters.length - 1) {
        setSpeaking(false)
        toast('全书已朗读完毕')
        return
      }
      flip(1)
    }
    utterance.onerror = () => setSpeaking(false)
    setSpeaking(true)
    window.speechSynthesis.speak(utterance)
  }, [ttsSupported, currentPage, chapter, settings.ttsRate, settings.ttsPitch, pageIndex, pages.length, chapterIndex, chapters.length, flip])

  // 翻页时若正在朗读，续读新页
  useEffect(() => {
    if (speaking) startSpeaking()
    // 仅在页码变化时触发续读，故意不依赖 startSpeaking 以避免循环
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageIndex, chapterIndex])

  useEffect(() => () => stopSpeaking(), [stopSpeaking])

  // 失焦时停止朗读，避免后台一直在念
  useEffect(() => {
    const onHide = () => stopSpeaking()
    document.addEventListener('visibilitychange', onHide)
    return () => document.removeEventListener('visibilitychange', onHide)
  }, [stopSpeaking])

  // ============================================================
  // 查词
  // ============================================================

  const doLookup = useCallback(
    async (raw: string) => {
      const query = normalizeQuery(raw)
      if (!query) return
      setDictOpen(true)
      setDictLoading(true)
      setDictResult(null)
      try {
        const result = await lookup(query, { allowOnline: false })
        setDictResult(result)
      } catch {
        setDictResult({ entries: [], miss: true, onlineAttempted: false })
      } finally {
        setDictLoading(false)
      }
    },
    [],
  )

  // ============================================================
  // 当前页的笔记/书签标记
  // ============================================================

  const pageBookmarks = useMemo(
    () =>
      currentPage
        ? bookmarks.filter(
            (b) => b.chapterIndex === chapterIndex && b.chapterOffset >= currentPage.start && b.chapterOffset < currentPage.end,
          )
        : [],
    [bookmarks, chapterIndex, currentPage],
  )

  const pageHighlights = useMemo(
    () =>
      currentPage
        ? highlights.filter(
            (h) => h.chapterIndex === chapterIndex && h.startOffset < currentPage.end && h.endOffset > currentPage.start,
          )
        : [],
    [highlights, chapterIndex, currentPage],
  )

  const searchSpans = useMemo(() => {
    if (!tocQuery.trim() || !chapter) return []
    return locateMatches(chapter.content, tocQuery)
  }, [tocQuery, chapter])

  const bookPercent = useMemo(() => {
    const total = totalCharCount(chapters)
    if (total <= 0 || !chapter || !currentPage) return 0
    return Math.min(1, (chapter.start + currentPage.start) / total)
  }, [chapters, chapter, currentPage])

  // ============================================================
  // 渲染
  // ============================================================

  /**
   * 当前页的段落。
   *
   * 有一个容易忽略的重复显示问题：无论 TXT 还是 EPUB，正文首段经常**就是章节标题本身**
   * （TXT 里标题是正文的一行；EPUB 里标题是 body 内的 h1）。
   * 而下面渲染时已经把 chapter.title 单独画成了标题，若首段照常渲染就会出现两遍。
   *
   * 因此这里只对**第一段**做一次标题去重。之所以放在渲染层而不是导入时改数据：
   * 保留原始 content 才能让字符偏移与「全局偏移」坐标系保持严格一致，
   * 而坐标系的正确性是书签、划线、搜索跳转的共同基础 —— 不能为了显示好看去动它。
   */
  const paragraphs = useMemo(() => {
    const raw = splitParagraphsWithOffsets(currentPage ? chapter?.content ?? '' : '', currentPage)
    if (raw.length === 0 || !chapter?.detected || currentPage?.start !== 0) return raw

    const stripped = stripLeadingHeading(raw[0].text, chapter.title)
    if (stripped === raw[0].text) return raw

    // 首段被剥空则整体丢弃，否则用剥完的文本替换（偏移同步后移）
    const head = stripped.length > 0 ? [{ text: stripped, offset: raw[0].offset + (raw[0].text.length - stripped.length) }] : []
    return [...head, ...raw.slice(1)]
  }, [chapter, currentPage])

  const flipClass = useMemo(() => {
    if (flipToken === 0 || settings.pageMode === 'none' || isScrollMode) return ''
    const dir = flipDirection === 'forward' ? 'forward' : 'backward'
    if (settings.pageMode === 'simulation') return `page-curl page-curl--${dir}`
    if (settings.pageMode === 'cover' && flipDirection === 'forward') return 'page-cover-forward'
    return `page-enter-${dir === 'forward' ? 'forward' : 'backward'}`
  }, [flipToken, flipDirection, settings.pageMode, isScrollMode])

  const readerVars = readerStyleVars(settings)
  if (settings.brightness !== null) {
    readerVars.filter = `brightness(${Math.max(0.15, settings.brightness)})`
  }

  const onZonePointerUp = (zone: 'left' | 'right' | 'mid') => (e: ReactPointerEvent<HTMLButtonElement>) => {
    // 有选区时不翻页，避免用户想选中文字却翻了页
    const sel = readSelection()
    if (sel) {
      setSelection(sel)
      return
    }
    // 中间区域若命中了字符，弹出查词；否则呼出工具栏
    if (zone === 'mid') {
      const offset = caretOffsetFromPoint(e.clientX, e.clientY)
      if (offset !== null) {
        const content = chapter?.content ?? ''
        // 取光标前后各若干字符作为候选词，再按标点裁剪
        const windowText = content.slice(Math.max(0, offset - 6), Math.min(content.length, offset + 6))
        const candidate = pickWordAt(windowText, Math.min(6, offset))
        if (candidate && candidate.length >= 1) {
          void doLookup(candidate)
          return
        }
      }
      setChromeVisible((v) => !v)
      return
    }
    setChromeVisible(false)
    flip(zone === 'right' ? 1 : -1)
  }

  const readingProgressLabel = `${(bookPercent * 100).toFixed(1)}%`
  const chapterProgressLabel = `第 ${chapterIndex + 1}/${chapters.length} 章`

  return (
    <div className={`reader ${isScrollMode ? 'reader--scroll' : ''}`} style={readerVars}>
      {/* 护眼色温遮罩：纯视觉叠加，不影响任何交互 */}
      <div className="reader__warmth" style={{ opacity: settings.eyeCareWarmth * 0.55 }} />

      {/* 顶栏 */}
      <div className={`reader__chrome reader__chrome--top ${chromeVisible ? '' : 'reader__chrome--hidden'}`}>
        <div className="topbar" style={{ borderBottom: 'none', background: 'transparent' }}>
          <button aria-label="返回书架" onClick={onClose}>
            <IconBack />
          </button>
          <div className="topbar__title" style={{ fontSize: 15 }}>
            {book.title}
            <div className="topbar__sub">{chapter?.title ?? ''}</div>
          </div>
          <button aria-label="朗读" onClick={speaking ? stopSpeaking : startSpeaking} disabled={!ttsSupported}>
            {speaking ? <IconPause /> : <IconSpeaker />}
          </button>
        </div>
      </div>

      {/* 正文区 */}
      <div className="reader__stage" ref={stageRef}>
        <div
          className={`reader__page ${flipClass}`}
          key={`${chapterIndex}-${pageIndex}-${flipToken}`}
          style={{ transform: isScrollMode ? undefined : undefined } as CSSProperties}
          /* 把分页状态暴露到 DOM 上，供端到端测试断言。
             测试不该靠猜类名去反推「这一章到底分了几页 / 当前是第几页」——
             那正是断言写错、把真 bug 掩盖掉的地方。 */
          data-chapter-index={chapterIndex}
          data-page-index={pageIndex}
          data-page-count={pages.length}
          data-chapter-title={chapter?.title ?? ''}
        >
          {/* 天头：书眉。按真实书籍体例，书眉只出现在次页起 ——
              首页是章首，标题本身就在版心内，再顶一条书眉会重复。 */}
          {!isScrollMode && currentPage?.start !== 0 && (
            <div className="reader__running-head">{chapter?.title ?? ''}</div>
          )}

          <div className="reader__text" ref={textRef} style={{ userSelect: 'text' }}>
            {currentPage?.start === 0 && chapter?.detected && (
              <div className="reader__chapter-no">{chapterHeadingLabel(chapter)}</div>
            )}
            {currentPage?.start === 0 && chapter?.detected && (
              <h2 className="reader__chapter-title">{chapter.title}</h2>
            )}
            {paragraphs.map((p, i) => (
              <p key={i} data-offset={p.offset} style={{ margin: 0, textIndent: 'var(--reader-indent)' }}>
                {p.text}
              </p>
            ))}

            {/* 本页的书签/笔记提示：用一行低调的说明，而不是并排的角标 */}
            {(pageBookmarks.length > 0 || pageHighlights.length > 0) && (
              <div style={{ marginTop: 14, fontSize: '0.62em', lineHeight: 1.7, color: 'var(--reader-fg-soft)', textIndent: 0 }}>
                {pageBookmarks.length > 0 && (
                  <div>
                    <IconBookmark size={12} style={{ verticalAlign: '-2px', marginRight: 5 }} />
                    本页有 {pageBookmarks.length} 个书签
                  </div>
                )}
                {pageHighlights.length > 0 && (
                  <div>
                    <IconNote size={12} style={{ verticalAlign: '-2px', marginRight: 5 }} />
                    本页有 {pageHighlights.length} 条笔记
                  </div>
                )}
              </div>
            )}
          </div>

          {/* 地脚：页码居中。真书的页码只是一个数字，不带章节名、不带百分比 ——
              进度感交给贴版心外缘的那条细线，它不占用版心。 */}
          {!isScrollMode && (
            <div className="reader__folio">
              <span className="reader__folio-number">{pageIndex + 1}</span>
            </div>
          )}

          {/* 全书进度：一条 2px 的细线，贴在页的下缘。它替代了原先页脚的百分比数字 ——
              读者需要"还有多久读完"的感觉，但不需要每页都读到一个精确到小数点后一位的数字。 */}
          {!isScrollMode && (
            <div className="reader__folio-progress" aria-hidden="true">
              <i style={{ width: `${(bookPercent * 100).toFixed(2)}%` }} />
            </div>
          )}
        </div>

        {/* 三热区：仅在非滚动模式启用点击翻页 */}
        {!isScrollMode && (
          <div className="reader__zones">
            <button className="reader__zone" aria-label="上一页" onPointerUp={onZonePointerUp('left')} />
            <button className="reader__zone reader__zone--mid" aria-label="显示工具栏" onPointerUp={onZonePointerUp('mid')} />
            <button className="reader__zone" aria-label="下一页" onPointerUp={onZonePointerUp('right')} />
          </div>
        )}

        {/* 滚动模式下也提供一个居中点击区来呼出工具栏 */}
        {isScrollMode && (
          <button
            aria-label="显示工具栏"
            onClick={() => setChromeVisible((v) => !v)}
            style={{ position: 'absolute', inset: 0, background: 'transparent', zIndex: 5, borderRadius: 0 }}
          />
        )}
      </div>

      {/* 底栏 */}
      <div className={`reader__chrome reader__chrome--bottom ${chromeVisible ? '' : 'reader__chrome--hidden'}`}>
        <div style={{ padding: '10px 12px 4px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span className="text-sm text-mute" style={{ fontVariantNumeric: 'tabular-nums' }}>
              {chapterProgressLabel}
            </span>
            <input
              className="slider"
              type="range"
              min={0}
              max={Math.max(0, chapters.length - 1)}
              value={chapterIndex}
              onChange={(e) => jumpToChapter(Number(e.target.value))}
              aria-label="章节进度"
              style={{ flex: 1 }}
            />
            <span className="text-sm text-mute" style={{ fontVariantNumeric: 'tabular-nums' }}>
              {readingProgressLabel}
            </span>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 2, padding: '2px 8px 10px', justifyContent: 'space-around' }}>
          <ToolbarButton label="目录" onClick={() => setSheet(sheet === 'toc' ? 'none' : 'toc')}>
            <IconList />
          </ToolbarButton>
          <ToolbarButton label="笔记" onClick={() => setSheet(sheet === 'notes' ? 'none' : 'notes')}>
            <IconNote />
          </ToolbarButton>
          <ToolbarButton label="夜间" onClick={() => updateSettings({ theme: palette.dark ? 'paper' : 'night' })}>
            {palette.dark ? <IconSun /> : <IconMoon />}
          </ToolbarButton>
          <ToolbarButton label="自动阅读" onClick={() => setAutoReading((v) => !v)}>
            {autoReading ? <IconPause /> : <IconPlay />}
          </ToolbarButton>
          <ToolbarButton label="搜索" onClick={() => onOpenSearch?.(book.id)}>
            <IconSearch />
          </ToolbarButton>
          <ToolbarButton label="排版" onClick={() => setSheet(sheet === 'settings' ? 'none' : 'settings')}>
            <IconText />
          </ToolbarButton>
        </div>
      </div>

      {/* 选中文字后的操作条 */}
      {selection && !dictOpen && (
        <div className="dict-pop" style={{ padding: 10 }}>
          <div className="row row--between" style={{ marginBottom: 8 }}>
            <span className="text-sm truncate" style={{ maxWidth: '60%', color: 'var(--ink-mute)' }}>
              已选 {selection.text.length} 字
            </span>
            <button aria-label="取消选择" onClick={() => { setSelection(null); window.getSelection()?.removeAllRanges() }}>
              <IconClose size={18} />
            </button>
          </div>
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            <button className="btn" onClick={() => { setNoteMode('highlight'); setNoteDraft(''); }} style={{ minHeight: 38 }}>
              划线
            </button>
            <button className="btn" onClick={() => void doLookup(selection.text)} style={{ minHeight: 38 }}>
              <IconDictionary size={16} /> 查词
            </button>
            <button
              className="btn"
              style={{ minHeight: 38 }}
              onClick={() => {
                void addBookmark(chapterIndex, selection.start, selection.text)
                setSelection(null)
                window.getSelection()?.removeAllRanges()
              }}
            >
              <IconBookmark size={16} /> 书签
            </button>
            <button
              className="btn"
              style={{ minHeight: 38 }}
              onClick={() => {
                void navigator.clipboard?.writeText(selection.text).then(
                  () => toast('已复制'),
                  () => toast('复制失败'),
                )
              }}
            >
              复制
            </button>
          </div>
        </div>
      )}

      {/* 划线备注输入 */}
      {noteMode === 'highlight' && selection && (
        <div className="dict-pop">
          <div className="dict-pop__head">
            <span className="dict-pop__word" style={{ fontSize: 16 }}>
              添加划线
            </span>
          </div>
          <p className="text-sm text-mute" style={{ marginTop: 0 }}>
            {selection.text.slice(0, 90)}
            {selection.text.length > 90 ? '…' : ''}
          </p>
          <input
            placeholder="写点想法（可留空）"
            value={noteDraft}
            onChange={(e) => setNoteDraft(e.target.value)}
            style={{ marginBottom: 10 }}
          />
          <div className="dict-pop__actions">
            <button className="btn grow" onClick={() => { setNoteMode('bookmark'); setSelection(null); window.getSelection()?.removeAllRanges() }}>
              取消
            </button>
            <button
              className="btn btn--primary grow"
              onClick={() => {
                void addHighlight(chapterIndex, selection.start, selection.end, selection.text, palette.primary, noteDraft)
                setNoteMode('bookmark')
                setNoteDraft('')
                setSelection(null)
                window.getSelection()?.removeAllRanges()
              }}
            >
              保存
            </button>
          </div>
        </div>
      )}

      {/* 查词浮层 */}
      {dictOpen && (
        <div className="dict-pop">
          <div className="dict-pop__head">
            <span className="dict-pop__word">{dictResult?.entries[0]?.word ?? normalizeQuery(selection?.text ?? '')}</span>
            {dictResult?.entries[0]?.phonetic && <span className="dict-pop__phonetic">{dictResult.entries[0].phonetic}</span>}
            <span className="dict-pop__source">
              {dictResult?.entries[0]?.source === 'online' ? '在线' : '本地'}
            </span>
            <button aria-label="关闭查词" onClick={() => setDictOpen(false)}>
              <IconClose size={18} />
            </button>
          </div>
          <div className="dict-pop__body">
            {dictLoading && <p className="text-sm text-mute">查询中…</p>}
            {!dictLoading && dictResult?.miss && (
              <p className="text-sm text-mute">
                内置词典未收录该词条。可以在「设置 → 词典」里导入自定义词典，或选中更多字再查。
              </p>
            )}
            {!dictLoading &&
              dictResult?.entries.map((entry, i) => (
                <div key={`${entry.word}-${i}`} style={{ marginBottom: 10 }}>
                  {i > 0 && (
                    <div style={{ fontSize: 12, color: 'var(--accent-ink)', fontWeight: 600, marginBottom: 3 }}>
                      {entry.word}
                    </div>
                  )}
                  {entry.senses.map((sense, j) => (
                    <div key={j} className="dict-sense">
                      {sense.pos && <span className="dict-sense__pos">{sense.pos}</span>}
                      <span>{sense.definition}</span>
                    </div>
                  ))}
                </div>
              ))}
          </div>
          <div className="dict-pop__actions">
            <button
              className="btn grow"
              onClick={() => {
                if (dictResult?.entries[0]) {
                  void addBookmark(chapterIndex, selection?.start ?? currentPage?.start ?? 0, selection?.text ?? dictResult.entries[0].word, dictResult.entries[0].senses[0]?.definition ?? '')
                }
              }}
            >
              收进笔记
            </button>
            <button className="btn btn--primary grow" onClick={() => setDictOpen(false)}>
              知道了
            </button>
          </div>
        </div>
      )}

      {/* 目录面板 */}
      {sheet === 'toc' && (
        <Sheet title="目录" onClose={() => setSheet('none')} subtitle={`${chapters.length} 章`}>
          <div className="toc-toolbar">
            <input
              placeholder="筛选章节"
              value={tocQuery}
              onChange={(e) => setTocQuery(e.target.value)}
              aria-label="筛选章节"
            />
            <button
              className={`toc-reverse ${tocReversed ? 'toc-reverse--on' : ''}`}
              onClick={() => setTocReversed((v) => !v)}
              aria-label="切换倒序"
            >
              {tocReversed ? '倒序' : '正序'}
            </button>
          </div>
          <div className="sheet__body">
            {(tocReversed ? [...chapters].reverse() : chapters)
              .filter((c) => (tocQuery.trim() ? c.title.includes(tocQuery.trim()) : true))
              .slice(0, 800)
              .map((c) => {
                const isCurrent = c.index === chapterIndex
                const marks = searchSpans.length > 0 && c.index === chapterIndex ? searchSpans.length : 0
                return (
                  <button
                    key={c.index}
                    className={`toc-item ${isCurrent ? 'toc-item--active' : ''}`}
                    onClick={() => jumpToChapter(c.index)}
                  >
                    <span className="toc-item__index">{c.index + 1}</span>
                    <span className="toc-item__title">{c.title}</span>
                    {!c.detected && <span className="toc-item__flag">分块</span>}
                    {marks > 0 && <span className="toc-item__count">{marks}</span>}
                  </button>
                )
              })}
            {chapters.length === 0 && <div className="toc-empty">这本书没有解析出章节</div>}
          </div>
        </Sheet>
      )}

      {/* 笔记面板 */}
      {sheet === 'notes' && (
        <Sheet
          title="本书笔记"
          onClose={() => setSheet('none')}
          subtitle={`${bookmarks.length} 书签、${highlights.length} 划线`}
          action={
            onOpenNotes ? (
              <button className="btn" style={{ minHeight: 34 }} onClick={() => { setSheet('none'); onOpenNotes(book.id) }}>
                全部
              </button>
            ) : undefined
          }
        >
          <div className="sheet__body">
            {bookmarks.length + highlights.length === 0 && (
              <div className="empty">
                <IconNote size={34} className="empty__icon" />
                <div className="empty__title">还没有书签和笔记</div>
                <div className="empty__desc">阅读时长按选中文字即可划线、写想法或添加书签。</div>
              </div>
            )}
            {[...bookmarks]
              .sort((a, b) => b.createdAt - a.createdAt)
              .map((b) => (
                <div className="note-item" key={b.id}>
                  <div className="note-item__head">
                    <span className="note-item__chapter">
                      第 {b.chapterIndex + 1} 章 {chapters[b.chapterIndex]?.title ?? ''}
                    </span>
                  </div>
                  <div
                    className="note-item__text"
                    onClick={() => jumpToChapter(b.chapterIndex, b.chapterOffset)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => e.key === 'Enter' && jumpToChapter(b.chapterIndex, b.chapterOffset)}
                  >
                    {b.excerpt || '（书签）'}
                  </div>
                  {b.note && <div className="note-item__note">{b.note}</div>}
                </div>
              ))}
            {[...highlights]
              .sort((a, b) => b.createdAt - a.createdAt)
              .map((h) => (
                <div className="note-item" key={h.id}>
                  <div className="note-item__head">
                    <span className="note-item__chapter">
                      第 {h.chapterIndex + 1} 章 {chapters[h.chapterIndex]?.title ?? ''}
                    </span>
                    <span
                      style={{
                        width: 10,
                        height: 10,
                        borderRadius: 3,
                        background: h.color,
                        display: 'inline-block',
                      }}
                    />
                  </div>
                  <div
                    className="note-item__text"
                    onClick={() => jumpToChapter(h.chapterIndex, h.startOffset)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => e.key === 'Enter' && jumpToChapter(h.chapterIndex, h.startOffset)}
                  >
                    {h.text}
                  </div>
                  {h.note && <div className="note-item__note">{h.note}</div>}
                </div>
              ))}
          </div>
        </Sheet>
      )}

      {/* 排版快速面板 */}
      {sheet === 'settings' && (
        <Sheet title="排版" onClose={() => setSheet('none')}>
          <div className="sheet__body">
            <div className="setting-group">
              <div className="setting-group__title">主题</div>
              <div className="theme-picker">
                {(Object.keys(THEMES) as Array<keyof typeof THEMES>).map((id) => {
                  const p = THEMES[id]
                  const active = settings.theme === id
                  return (
                    <button
                      key={id}
                      className={`theme-swatch ${active ? 'theme-swatch--active' : ''}`}
                      style={{ background: p.background, color: p.text, borderColor: active ? p.primary : undefined }}
                      onClick={() => updateSettings({ theme: id })}
                      aria-label={`主题 ${p.name}`}
                    >
                      {p.name}
                    </button>
                  )
                })}
              </div>
            </div>

            <div className="setting-group">
              <div className="setting-group__title">字号</div>
              <div className="setting-row">
                <span className="setting-row__label">正文字号</span>
                <Stepper
                  value={typography.fontSize}
                  min={12}
                  max={34}
                  onChange={(v) => updateSettings({ typography: { ...typography, fontSize: v } })}
                  format={(v) => `${v}px`}
                />
              </div>
              <div className="setting-row">
                <span className="setting-row__label">行距</span>
                <Stepper
                  value={typography.lineHeight}
                  min={1.2}
                  max={2.6}
                  step={0.1}
                  onChange={(v) => updateSettings({ typography: { ...typography, lineHeight: v } })}
                  format={(v) => v.toFixed(1)}
                />
              </div>
              <div className="setting-row">
                <span className="setting-row__label">段间距</span>
                <Stepper
                  value={typography.paragraphSpacing}
                  min={0}
                  max={2}
                  step={0.2}
                  onChange={(v) => updateSettings({ typography: { ...typography, paragraphSpacing: v } })}
                  format={(v) => v.toFixed(1)}
                />
              </div>
              <div className="setting-row">
                <span className="setting-row__label">页边距</span>
                <Stepper
                  value={typography.margin}
                  min={8}
                  max={48}
                  step={2}
                  onChange={(v) => updateSettings({ typography: { ...typography, margin: v } })}
                  format={(v) => `${v}px`}
                />
              </div>
            </div>

            <div className="setting-group">
              <div className="setting-group__title">字体</div>
              <div className="chip-row">
                {(Object.keys(FONT_STACKS) as Array<keyof typeof FONT_STACKS>).map((id) => (
                  <button
                    key={id}
                    className={`chip ${typography.fontFamily === id ? 'chip--active' : ''}`}
                    style={{ fontFamily: FONT_STACKS[id].css }}
                    onClick={() => updateSettings({ typography: { ...typography, fontFamily: id } })}
                  >
                    {FONT_STACKS[id].name}
                  </button>
                ))}
              </div>
            </div>

            <div className="setting-group">
              <div className="setting-group__title">翻页</div>
              <div className="setting-row">
                <span className="setting-row__label">翻页方式</span>
              </div>
              <div className="chip-row">
                {(['simulation', 'slide', 'cover', 'scroll', 'none'] as const).map((mode) => (
                  <button
                    key={mode}
                    className={`chip ${settings.pageMode === mode ? 'chip--active' : ''}`}
                    onClick={() => updateSettings({ pageMode: mode })}
                  >
                    {PAGE_MODE_LABELS[mode]}
                  </button>
                ))}
              </div>
            </div>

            <div className="setting-group">
              <div className="setting-group__title">护眼与亮度</div>
              <div className="setting-row">
                <span className="setting-row__label">护眼色温</span>
                <input
                  className="slider"
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={settings.eyeCareWarmth}
                  onChange={(e) => updateSettings({ eyeCareWarmth: Number(e.target.value) })}
                  aria-label="护眼色温"
                  style={{ maxWidth: 150 }}
                />
              </div>
              <div className="setting-row">
                <span className="setting-row__label">
                  屏幕亮度
                  <div className="setting-row__hint">
                    {settings.brightness === null ? '跟随系统' : `应用内 ${Math.round(settings.brightness * 100)}%`}
                  </div>
                </span>
                <input
                  className="slider"
                  type="range"
                  min={0.15}
                  max={1}
                  step={0.05}
                  value={settings.brightness ?? 1}
                  onChange={(e) => updateSettings({ brightness: Number(e.target.value) })}
                  aria-label="屏幕亮度"
                  style={{ maxWidth: 130 }}
                />
                <button
                  className="btn"
                  style={{ minHeight: 34 }}
                  onClick={() => updateSettings({ brightness: settings.brightness === null ? 0.7 : null })}
                >
                  {settings.brightness === null ? '调节' : '跟随'}
                </button>
              </div>
            </div>

            <div className="setting-group">
              <div className="setting-group__title">自动阅读</div>
              <div className="setting-row">
                <span className="setting-row__label">
                  速度
                  <div className="setting-row__hint">{settings.autoReadSpeed} 字/秒</div>
                </span>
                <input
                  className="slider"
                  type="range"
                  min={8}
                  max={120}
                  step={2}
                  value={settings.autoReadSpeed}
                  onChange={(e) => updateSettings({ autoReadSpeed: Number(e.target.value) })}
                  aria-label="自动阅读速度"
                  style={{ maxWidth: 150 }}
                />
              </div>
            </div>
          </div>
        </Sheet>
      )}

      {autoReading && (
        <div className="toast" style={{ bottom: 100 }}>
          自动阅读中，{settings.autoReadSpeed} 字/秒
        </div>
      )}
    </div>
  )
}

// ============================================================
// 子组件与工具函数
// ============================================================

function ToolbarButton({
  label,
  onClick,
  children,
}: {
  label: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      style={{ flexDirection: 'column', gap: 3, fontSize: 10.5, minWidth: 52, color: 'var(--ink-soft)' }}
    >
      {children}
      <span>{label}</span>
    </button>
  )
}

function Sheet({
  title,
  subtitle,
  onClose,
  children,
  action,
}: {
  title: string
  subtitle?: string
  onClose: () => void
  children: React.ReactNode
  action?: React.ReactNode
}) {
  return (
    <div className="sheet" onClick={onClose} role="dialog" aria-label={title}>
      <div className="sheet__panel" onClick={(e) => e.stopPropagation()}>
        <div className="sheet__handle" />
        <div className="sheet__header">
          <span className="sheet__title">
            {title}
            {subtitle && <span className="setting-row__hint" style={{ marginLeft: 8 }}>{subtitle}</span>}
          </span>
          {action}
          <button aria-label="关闭" onClick={onClose}>
            <IconClose size={19} />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

function Stepper({
  value,
  min,
  max,
  step = 1,
  onChange,
  format,
}: {
  value: number
  min: number
  max: number
  step?: number
  onChange: (v: number) => void
  format?: (v: number) => string
}) {
  const clamp = (v: number) => Math.min(max, Math.max(min, Math.round(v / step) * step))
  return (
    <div className="stepper">
      <button aria-label="减小" onClick={() => onChange(clamp(value - step))} disabled={value <= min}>
        <IconMinus size={17} />
      </button>
      <span className="stepper__value">{format ? format(value) : value}</span>
      <button aria-label="增大" onClick={() => onChange(clamp(value + step))} disabled={value >= max}>
        <IconPlus size={17} />
      </button>
    </div>
  )
}

/** 找到光标所在节点所属的、带 data-offset 的段落元素。 */
function findParagraphElement(node: Node | null): HTMLElement | null {
  let current: Node | null = node
  while (current) {
    if (current instanceof HTMLElement && current.dataset.offset !== undefined) return current
    current = current.parentNode
  }
  return null
}

/** 特殊篇名：楔子 / 序章 / 番外 / 后记 等，本身不带序号。 */
const SPECIAL_HEADING_RE =
  /^(楔子|序章|序言|自序|前言|引子|引言|尾声|终章|完结章|后记|附录|外传|作者的话|作品相关|设定|人物介绍|番外[0-9零一二三四五六七八九十]*)/

/**
 * 章节上方的小标签。
 *
 * 不能一律输出「第 N 章」：楔子、番外、序章这些篇名本身不带序号，
 * 标上「第 2 章」会与紧随其后的标题「楔子 雪夜」语义冲突（实测截图里出现过）。
 * 另外，标题本身已内含序号时（如「第一章 初入江湖」）也无需重复编号。
 */
export function chapterHeadingLabel(chapter: { title: string; index: number }): string {
  const title = chapter.title.trim()
  if (SPECIAL_HEADING_RE.test(title)) return '篇外'
  if (/第\s*[0-9零一二三四五六七八九十百千万两〇]+\s*[章节回卷节篇部集话]/.test(title)) return '正文'
  if (/^(chapter|chap\.?|part)\b/i.test(title)) return '正文'
  return `第 ${chapter.index + 1} 章`
}

/**
 * 把当前页的文本切成段落，并标注每段在**章内**的起始偏移。
 * 有了这个偏移，点击坐标才能被换算成章内字符位置。
 *
 * 两个必须一起处理的细节：
 *   1. 段落首的空白（尤其是全角空格 `　`）要剥掉 —— 否则会与 CSS 首行缩进
 *      叠加成两格缩进。中文 TXT 里以「　　」开头的段落非常常见。
 *   2. 剥掉空白后，段落偏移必须相应向后移动，否则查词/书签/划线算出的
 *      字符位置会整体偏移，跳转与划线就会错位。
 */
function splitParagraphsWithOffsets(
  chapterContent: string,
  page: PageSlice | undefined,
): Array<{ text: string; offset: number }> {
  if (!page) return []
  const slice = chapterContent.slice(page.start, page.end)
  const result: Array<{ text: string; offset: number }> = []
  let cursor = page.start

  for (const raw of slice.split('\n')) {
    const leading = raw.length - raw.replace(/^[\s\u3000]+/, '').length
    const text = raw.slice(leading)
    if (text.length > 0) {
      result.push({ text, offset: cursor + leading })
    }
    cursor += raw.length + 1
  }
  return result
}

/**
 * 从光标附近取一个「词」。
 *
 * 中文没有词边界，无法可靠分词，因此这里只做一件保守的事：
 * 以光标为中心向两侧扩展到标点边界，最多取 6 个字。
 * 这样查到的通常是用户想要的那个词或短语，而不是被错误切分的碎片。
 */
export function pickWordAt(windowText: string, caretIndex: number): string {
  if (!windowText) return ''
  const isBoundary = (ch: string) => /[\s，。！？；：、""''（）《》〈〉【】,.!?;:()[\]{}—…·]/.test(ch)
  let start = Math.max(0, Math.min(caretIndex, windowText.length - 1))
  let end = start

  // 若光标右侧是标点，向左退一格，避免选出纯标点
  while (start > 0 && (isBoundary(windowText[start]) || windowText[start] === undefined)) start--
  while (end < windowText.length && !isBoundary(windowText[end])) end++
  while (start > 0 && !isBoundary(windowText[start - 1])) start--

  const word = windowText.slice(start, Math.min(end, start + 8))
  const cleaned = normalizeQuery(word)
  // 单字也允许（查汉字很有价值），但纯标点要排除
  return cleaned
}
