/**
 * EPUB 解析（基于开源库 epubjs）。
 *
 * 这里刻意**不自己实现** EPUB 解析。EPUB 涉及 ZIP 解包、OPF 包文件、
 * manifest/spine 解析、EPUB2 的 NCX 与 EPUB3 的 nav 两套目录、
 * href 相对路径归一化与百分号解码、加密（DRM）探测等等，
 * 每一处都有大量兼容性坑。`epubjs` 是 Readium 生态里浏览器端的事实标准，
 * 这些工作它已经做全了；我们只做两件事：
 *
 *   1. 把 epubjs 的输出**映射到墨阅自己的领域模型**（Chapter / Book），
 *      使 EPUB 与 TXT 共用同一套「全局字符偏移」坐标系；
 *   2. 把 XHTML 转成纯文本 —— 用平台内建的 `DOMParser` 走 DOM，
 *      而不是用正则剥离标签（正则处理 HTML 必然在某些文档上出错）。
 *
 * 与 TXT 路径的关键一致性：EPUB 的章节是文件级的，但我们把各章正文
 * **顺序拼接**后计算 `start` 偏移，于是进度、书签、笔记、搜索
 * 在两种格式下共用完全相同的换算逻辑，无需分叉。
 */

import type { Book, Chapter } from './types'

/**
 * epubjs 按需加载。
 *
 * 它是一个完整的 EPUB 引擎（含 ZIP 解包、CFI 定位、渲染器），压缩后约占主包 300 KB。
 * 但绝大多数用户读的是 TXT —— 为了不让只看 TXT 的人白付这个体积，
 * 这里用动态 import 把 epubjs 拆成独立 chunk，只有真的导入 EPUB 时才拉取。
 */
type EpubBook = import('epubjs').Book
/** epubjs 的默认导出是一个工厂函数，返回 Book 实例。 */
type EpubFactory = (input?: unknown, options?: unknown) => EpubBook
type EpubModule = { default: EpubFactory }

let epubModulePromise: Promise<EpubModule> | null = null

function loadEpubJs(): Promise<EpubModule> {
  if (!epubModulePromise) {
    epubModulePromise = import('epubjs').then((mod) => mod as unknown as EpubModule)
  }
  return epubModulePromise
}

export interface EpubParseInput {
  /** EPUB 文件的原始字节 */
  bytes: Uint8Array | ArrayBuffer
  /** 书名兜底（通常取文件名） */
  fallbackTitle?: string
}

export interface EpubTocEntry {
  label: string
  /** 该目录项指向的章节序号 */
  chapterIndex: number
  /** 嵌套层级，0 为顶层 */
  level: number
}

export interface EpubParseResult {
  title: string
  author: string
  intro: string
  language: string
  publisher: string
  /** 封面 dataURL（已转成可持久化形式，可直接存入 IndexedDB；无封面时 undefined） */
  coverDataUrl?: string
  chapters: Chapter[]
  toc: EpubTocEntry[]
  /** 解析过程中的告警，供 UI 提示 */
  warnings: string[]
}

/** 需要产生换行的块级标签。 */
const BLOCK_TAGS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DIV', 'DL', 'DD', 'DT',
  'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3',
  'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE',
  'SECTION', 'TABLE', 'TR', 'UL',
])

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'HEAD', 'TITLE', 'META', 'LINK'])

/**
 * 把 XHTML 转成纯文本。
 *
 * 用 `DOMParser` 构造真实 DOM 再遍历，因此：
 *   - `<script>` / `<style>` 的内容不会被混进正文（正则方案最常见的翻车点）；
 *   - HTML 实体、注释、CDATA 由解析器按规定处理；
 *   - 未闭合标签由解析器的容错规则修复，不会让整章错乱。
 */
export function htmlToPlainText(html: string): string {
  if (typeof DOMParser === 'undefined') {
    // 极简降级：仅用于没有 DOMParser 的环境（纯 Node 单元测试）
    return html
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  }

  const doc = new DOMParser().parseFromString(html, 'text/html')
  const body = doc.body
  if (!body) return ''

  const out: string[] = []

  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      out.push(node.nodeValue ?? '')
      return
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return

    const el = node as Element
    const tag = el.tagName.toUpperCase()
    if (SKIP_TAGS.has(tag)) return

    if (tag === 'BR' || tag === 'HR') {
      out.push('\n')
      return
    }
    if (tag === 'IMG') {
      const alt = el.getAttribute('alt')
      out.push(alt ? `［图：${alt}］` : '［图片］')
      return
    }

    const isBlock = BLOCK_TAGS.has(tag)
    if (isBlock) out.push('\n')
    for (const child of Array.from(el.childNodes)) walk(child)
    if (isBlock) out.push('\n')
  }

  walk(body)

  return out
    .join('')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t\f\v]+/g, ' ')
    // 逐行 trim：必须放在「全角空格 → 普通空格」之后，否则行首的 　 会残留，
    // 叠加阅读器自身的首行缩进后就会变成两格缩进（实测截图里出现过）。
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 该 spine 项是否是可读的正文文档。 */
function isContentDocument(href: string | undefined, mediaType?: string): boolean {
  if (mediaType) return /xhtml|html|xml/i.test(mediaType)
  return !!href && /\.x?html?$/i.test(href)
}

/** 把 blob URL / data URL 的封面转成可持久化的 dataURL。 */
async function toDataUrl(url: string | null): Promise<string | undefined> {
  if (!url) return undefined
  // epubjs 在浏览器里返回 blob URL；Node 环境可能给文件路径，后者无法 fetch
  if (!url.startsWith('blob:') && !url.startsWith('data:') && !/^https?:/i.test(url)) return undefined

  try {
    const response = await fetch(url)
    const blob = await response.blob()
    return await new Promise<string | undefined>((resolve) => {
      const reader = new FileReader()
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : undefined)
      reader.onerror = () => resolve(undefined)
      reader.readAsDataURL(blob)
    })
  } catch {
    return undefined
  }
}

/** 扁平化 epubjs 的嵌套目录，保留层级。 */
function flattenToc(
  items: Array<{ href: string; label: string; subitems?: unknown[] }>,
  level = 0,
): Array<{ href: string; label: string; level: number }> {
  const result: Array<{ href: string; label: string; level: number }> = []
  for (const item of items) {
    if (item && typeof item.href === 'string') {
      result.push({ href: item.href, label: (item.label ?? '').trim(), level })
    }
    const children = item?.subitems
    if (Array.isArray(children) && children.length > 0) {
      result.push(
        ...flattenToc(children as Array<{ href: string; label: string; subitems?: unknown[] }>, level + 1),
      )
    }
  }
  return result
}

/** 归一化 href 用于匹配目录项与章节：去掉 fragment 与查询串。 */
function baseHref(href: string): string {
  return href.split('#')[0].split('?')[0]
}

/**
 * 剥掉正文开头与章节标题重复的那一行。
 *
 * 为什么需要：EPUB 的章节文档通常把标题也写在正文里（`<h1>` 属于 body 内容），
 * 于是 `htmlToPlainText` 会把标题变成正文第一行。而阅读器渲染时会把
 * `chapter.title` 单独画成标题，两者叠加就会出现「标题显示两遍」。
 *
 * 判定有意保守：只比较首行，并且只在**标题是首行的前缀**时才剥离
 * （即首行 = 标题，或首行 = 标题 + 副标题）。
 *
 * 反过来不成立：如果正文首行只是标题的一小段（例如首行「剑冢」而标题是
 * 「第三章 剑冢」），那更可能是正文而非标题，此时不动它。
 * 宁可偶尔留下一个重复标题，也不要误删真实正文 —— 删错的代价大得多。
 */
export function stripLeadingHeading(text: string, title: string): string {
  const trimmedTitle = title.replace(/[\s\u3000]+/g, '').trim()
  if (!trimmedTitle || !text) return text

  const newlineIndex = text.indexOf('\n')
  const firstLine = (newlineIndex === -1 ? text : text.slice(0, newlineIndex)).replace(/[\s\u3000]+/g, '')
  if (!firstLine) return text

  if (!firstLine.startsWith(trimmedTitle)) return text

  if (newlineIndex === -1) return ''
  return text.slice(newlineIndex + 1).replace(/^\n+/, '')
}

/**
 * 解析一个 EPUB 文件。
 *
 * @throws 当文件不是有效 EPUB 或没有可读正文时抛出，错误信息面向用户可读
 */
export async function parseEpub(input: EpubParseInput): Promise<EpubParseResult> {
  const warnings: string[] = []
  const bytes = input.bytes instanceof Uint8Array ? input.bytes : new Uint8Array(input.bytes)

  const { default: ePub } = await loadEpubJs()
  const book = ePub()
  let opened = false

  try {
    await book.ready
    // 复制到独立 ArrayBuffer：epubjs 需要 ArrayBuffer，
    // 而直接传 bytes.buffer 在 bytes 是子视图（byteOffset 非 0）时会读到错误内容。
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    await book.open(buffer, 'binary')
    await book.loaded.metadata
    await book.loaded.navigation
    opened = true

    const metadata = await book.loaded.metadata
    const navigation = await book.loaded.navigation

    // —— 章节：按 spine 顺序，每个正文文档一章 ——
    const chapters: Chapter[] = []
    const hrefToIndex = new Map<string, number>()
    let globalOffset = 0

    // 用 spine.length + spine.get(i) 遍历。
    //
    // 说明：epubjs 的实现里 Spine 有 `length` 与 `spineItems` 两个实例属性，
    // 但官方类型声明（types/spine.d.ts）只声明了 `each/get/first/last`，
    // 没有把这两个属性写进去。因此这里用交叉类型**显式**补上 length，
    // 而不是退化成 any —— 一旦 epubjs 改了内部结构，这里会立刻报错而非静默出错。
    type SpineWithLength = typeof book.spine & { length?: number }
    const spine = book.spine as SpineWithLength
    const spineLength = spine.length ?? 0

    for (let i = 0; i < spineLength; i++) {
      const section = book.spine.get(i)
      // get() 对非正文项（封面、样式表等）可能返回 null
      if (!section) continue

      const href = section.href ?? ''
      if (!isContentDocument(href)) continue

      let doc: Document | null = null
      try {
        doc = section.load(book.load.bind(book)) as unknown as Document
      } catch {
        warnings.push(`章节加载失败：${href}`)
        continue
      }
      if (!doc) {
        warnings.push(`章节内容为空：${href}`)
        continue
      }

      const text = htmlToPlainText(doc.documentElement?.outerHTML ?? '')
      // 空文档（封面页、版权页）跳过，但仍记录映射，避免目录项指向丢失
      if (text.length === 0) {
        hrefToIndex.set(baseHref(href), Math.max(0, chapters.length - 1))
        continue
      }

      // 标题优先取文档内首个 h1-h3，其次 <title>
      let chapterTitle = ''
      const heading = doc.querySelector('h1, h2, h3')
      if (heading?.textContent) chapterTitle = heading.textContent.replace(/\s+/g, ' ').trim()
      if (!chapterTitle && doc.title) chapterTitle = doc.title.replace(/\s+/g, ' ').trim()

      // 关键：正文里往往以标题开头（因为标题本身是文档内的一个块级元素），
      // 而阅读器渲染时会把 chapter.title 单独画成标题，若不去掉就会**重复显示两遍**。
      // 因此这里剥掉正文首行与标题相同的内容。
      const body = stripLeadingHeading(text, chapterTitle)
      if (body.length === 0) {
        hrefToIndex.set(baseHref(href), Math.max(0, chapters.length - 1))
        continue
      }

      const index = chapters.length
      chapters.push({
        bookId: '',
        index,
        title: chapterTitle || `第 ${index + 1} 节`,
        content: body,
        start: globalOffset,
        length: body.length,
        detected: true,
      })
      globalOffset += body.length
      hrefToIndex.set(baseHref(href), index)
      hrefToIndex.set(href, index)
    }

    if (chapters.length === 0) {
      throw new Error('这个 EPUB 里没有可读的正文内容（可能只有图片，或受 DRM 保护）')
    }

    // —— 目录 ——
    const rawToc = flattenToc(
      (navigation?.toc ?? []) as Array<{ href: string; label: string; subitems?: unknown[] }>,
    )
    const toc: EpubTocEntry[] = []
    for (const item of rawToc) {
      const index = hrefToIndex.get(baseHref(item.href)) ?? hrefToIndex.get(item.href)
      if (index === undefined) continue
      toc.push({ label: item.label, chapterIndex: index, level: item.level })
    }
    if (toc.length === 0) {
      warnings.push('这本 EPUB 没有可用的目录，已按文件顺序生成章节')
    }

    // 目录的顶层标题通常比文档内标题更规范，用它覆盖
    for (const entry of toc) {
      if (entry.level === 0 && entry.label) {
        const chapter = chapters[entry.chapterIndex]
        if (chapter) chapter.title = entry.label
      }
    }

    // —— 封面 ——
    let coverDataUrl: string | undefined
    try {
      coverDataUrl = await toDataUrl(await book.coverUrl())
    } catch {
      warnings.push('封面读取失败')
    }

    const author = String(metadata.creator ?? '').trim()
    const language = String(metadata.language ?? '').trim()

    return {
      title: String(metadata.title ?? '').trim() || input.fallbackTitle || '未命名',
      author: author || '佚名',
      intro: String(metadata.description ?? '').trim(),
      language,
      publisher: String(metadata.publisher ?? '').trim(),
      coverDataUrl,
      chapters,
      toc,
      warnings,
    }
  } catch (error) {
    if (!opened) {
      const message = error instanceof Error ? error.message : String(error)
      // epubjs 对损坏文件抛出的错误偏技术化，这里翻译成用户能懂的话
      if (/not a valid|corrupt|invalid|unarchive|Cannot read|end of central directory/i.test(message)) {
        throw new Error('这个文件不是有效的 EPUB（无法解包或包文件已损坏）')
      }
      throw new Error(`EPUB 打开失败：${message}`)
    }
    throw error
  } finally {
    // 必须销毁：epubjs 会为封面与资源创建 blob URL，不释放会持续占用内存
    try {
      book.destroy()
    } catch {
      /* 忽略销毁异常 */
    }
  }
}

/** 把解析结果转成 Book 实体（id / 时间戳由调用方补齐）。 */
export function epubToBook(
  parsed: EpubParseResult,
  options: { id: string; groupId?: string; coverDataUrl?: string; addedAt: number },
): Book {
  const charCount = parsed.chapters.reduce((sum, c) => sum + c.length, 0)
  return {
    id: options.id,
    title: parsed.title,
    author: parsed.author,
    intro: parsed.intro,
    format: 'epub',
    encoding: 'utf-8',
    cover: options.coverDataUrl ?? parsed.coverDataUrl,
    charCount,
    chapterCount: parsed.chapters.length,
    sourceLength: charCount,
    groupId: options.groupId,
    finished: false,
    addedAt: options.addedAt,
    lastReadAt: options.addedAt,
  }
}
