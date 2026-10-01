/**
 * 书籍封面。
 *
 * 两种形态：
 *   1. 有 `book.cover`（用户上传或 EPUB 内嵌封面）→ 满幅图片，`object-fit: cover`；
 *   2. 没有封面 → 由书名哈希出**确定性**的双色渐变。
 *
 * 为什么强调确定性：书架每次渲染都会重新计算，如果渐变带随机数，
 * 用户每次返回书架都会看到封面变色，会显得整个应用不稳定。
 * 哈希只依赖标题字符串，因此同一本书永远得到同一组色相。
 */

import type { Book, BookFormat } from '../engine/types'

export interface BookCoverProps {
  book: Book
  /** 阅读进度 0..1 */
  percent?: number
  /** 是否已读完（叠加遮罩） */
  finished?: boolean
  /** 是否为未读书籍（右上角红点） */
  unread?: boolean
  /** 封面宽度（px），高度由 CSS 的 3:4.3 比例决定 */
  width?: number
}

/** 封面渐变的色相池：暖棕 → 橄榄绿 → 靛蓝，全部低饱和，与纸感基调一致。 */
const COVER_HUES = [26, 33, 38, 44, 52, 88, 112, 138, 158, 208, 232, 252] as const

const FORMAT_LABEL: Record<BookFormat, string> = {
  txt: 'TXT',
  epub: 'EPUB',
  pdf: 'PDF',
}

/**
 * 由书名生成确定性渐变。纯函数：同一书名永远返回同一字符串。
 *
 * 两个色相分別从「暖色段」与「冷色段」各取一个，保证渐变有层次，
 * 而不会出现两个几乎一样的颜色拼在一起。
 */
export function coverGradient(title: string): string {
  const key = title.length > 0 ? title : '未命名'
  let hash = 2166136261
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i)
    // FNV 素数乘法，用移位模拟 32 位溢出
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0
  }

  const warm = COVER_HUES[hash % 6]
  const cool = COVER_HUES[6 + ((hash >>> 8) % 6)]

  // 色相微扰 0..6 度，让不同书名之间的差异更细腻
  const jitter = (hash >>> 16) % 7
  const h1 = warm + jitter
  const h2 = cool + ((hash >>> 20) % 5)

  const s1 = 30 + ((hash >>> 4) % 12)
  const s2 = 24 + ((hash >>> 12) % 12)

  return `linear-gradient(150deg, hsl(${h1} ${s1}% 34%), hsl(${h2} ${s2}% 27%))`
}

/** 书名在书脊上竖排显示，最多 10 个字（再多会被 max-height 裁掉且显得杂乱）。 */
function spineText(title: string): string {
  const trimmed = title.trim()
  if (trimmed.length === 0) return '未命名'
  return trimmed.length <= 10 ? trimmed : `${trimmed.slice(0, 10)}…`
}

export function BookCover({ book, percent = 0, finished = false, unread = false, width = 104 }: BookCoverProps) {
  const safePercent = Math.min(1, Math.max(0, percent))

  return (
    <div
      className="cover"
      style={{ width }}
      role="img"
      aria-label={`《${book.title}》封面`}
      data-finished={finished ? 'true' : undefined}
    >
      {book.cover ? (
        /* 有封面图：满幅铺满，不渲染渐变 */
        <img
          src={book.cover}
          alt=""
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', zIndex: 0 }}
        />
      ) : (
        <div
          aria-hidden="true"
          style={{ position: 'absolute', inset: 0, background: coverGradient(book.title), zIndex: 0 }}
        />
      )}

      <span className="cover__text">{spineText(book.title)}</span>

      <span className="cover__badge">{FORMAT_LABEL[book.format] ?? book.format.toUpperCase()}</span>

      {unread ? <span className="cover__new" aria-label="未读" /> : null}

      {safePercent > 0 ? (
        <span className="cover__progress" aria-hidden="true">
          <i style={{ width: `${Math.round(safePercent * 100)}%` }} />
        </span>
      ) : null}

      {finished ? <span className="cover__finished">已读完</span> : null}
    </div>
  )
}
