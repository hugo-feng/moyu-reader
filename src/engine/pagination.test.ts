import { describe, expect, it } from 'vitest'
import {
  chapterHeadingLabel,
  createMeasure,
  isFullWidthCodePoint,
  pickWordAt,
} from '../ui/ReaderScreen'
import {
  estimateCharsPerScreen,
  metricsFromTypography,
  pageIndexForOffset,
  pageText,
  paginateByCharBudget,
  paginateChapter,
  paginationCacheKey,
  visualWeight,
} from './pagination'
import { DEFAULT_TYPOGRAPHY } from './types'

describe('isFullWidthCodePoint — 全角判定', () => {
  it('汉字为全角', () => {
    expect(isFullWidthCodePoint('中'.codePointAt(0)!)).toBe(true)
    expect(isFullWidthCodePoint('龙'.codePointAt(0)!)).toBe(true)
  })

  it('中文标点为全角', () => {
    expect(isFullWidthCodePoint('，'.codePointAt(0)!)).toBe(true)
    expect(isFullWidthCodePoint('。'.codePointAt(0)!)).toBe(true)
    expect(isFullWidthCodePoint('《'.codePointAt(0)!)).toBe(true)
  })

  it('ASCII 字母数字为半角', () => {
    expect(isFullWidthCodePoint('a'.codePointAt(0)!)).toBe(false)
    expect(isFullWidthCodePoint('Z'.codePointAt(0)!)).toBe(false)
    expect(isFullWidthCodePoint('5'.codePointAt(0)!)).toBe(false)
    expect(isFullWidthCodePoint(' '.codePointAt(0)!)).toBe(false)
  })
})

describe('createMeasure — 文本宽度测量', () => {
  const measure = createMeasure(20)

  it('每个汉字宽 1 em', () => {
    expect(measure('中文')).toBeCloseTo(40, 5)
    expect(measure('中')).toBeCloseTo(20, 5)
  })

  it('ASCII 按 0.5 em 计', () => {
    expect(measure('ab')).toBeCloseTo(20, 5)
    expect(measure('a')).toBeCloseTo(10, 5)
  })

  it('中英混排按比例累加', () => {
    // 2 汉字 (40) + 4 字母 (40)
    expect(measure('中文abcd')).toBeCloseTo(80, 5)
  })

  it('换行符不占宽度', () => {
    expect(measure('中\n文')).toBeCloseTo(40, 5)
    expect(measure('中\r\n文')).toBeCloseTo(40, 5)
  })

  it('空串宽度为 0', () => {
    expect(measure('')).toBe(0)
  })

  it('代理对（emoji）不被拆成两个字符计宽', () => {
    // emoji 属全角范围，只应记 1 em
    expect(measure('😀')).toBeCloseTo(20, 5)
  })
})

describe('metricsFromTypography — 可用区域推导', () => {
  it('扣除左右页边距得到正文宽度', () => {
    const m = metricsFromTypography({ ...DEFAULT_TYPOGRAPHY, margin: 20 }, 400, 800, 0, 1)
    expect(m.contentWidth).toBe(360)
  })

  it('扣除顶栏高度', () => {
    const m = metricsFromTypography({ ...DEFAULT_TYPOGRAPHY, margin: 20 }, 400, 800, 100, 1)
    expect(m.contentHeight).toBe(680)
  })

  it('行高 = 字号 × 行距倍数', () => {
    const m = metricsFromTypography({ ...DEFAULT_TYPOGRAPHY, fontSize: 20, lineHeight: 1.5 }, 400, 800, 0, 1)
    expect(m.lineHeight).toBe(30)
  })

  it('密度缩放生效', () => {
    const m = metricsFromTypography({ ...DEFAULT_TYPOGRAPHY, fontSize: 20, margin: 10 }, 400, 800, 0, 2)
    expect(m.lineHeight).toBe(20 * 2 * DEFAULT_TYPOGRAPHY.lineHeight)
    expect(m.contentWidth).toBe(400 - 40)
  })

  it('极端小视口不会返回 0 或负数', () => {
    const m = metricsFromTypography({ ...DEFAULT_TYPOGRAPHY, margin: 50 }, 20, 20, 0, 1)
    expect(m.contentWidth).toBeGreaterThan(0)
    expect(m.contentHeight).toBeGreaterThan(0)
  })
})

describe('paginateChapter — 分页正确性', () => {
  const metrics = { contentWidth: 200, contentHeight: 100, lineHeight: 20 } // 每行 10 汉字，每页 5 行
  const measure = createMeasure(20)

  it('短内容只分一页', () => {
    const pages = paginateChapter('短文本', metrics, measure)
    expect(pages).toHaveLength(1)
    expect(pages[0].start).toBe(0)
    expect(pages[0].end).toBe(3)
  })

  it('空内容返回一个空页而不是空数组', () => {
    const pages = paginateChapter('', metrics, measure)
    expect(pages).toHaveLength(1)
    expect(pages[0].start).toBe(0)
    expect(pages[0].end).toBe(0)
  })

  it('页区间连续且无缝无重叠', () => {
    const content = Array.from({ length: 40 }, (_, i) => `第${i}行的正文内容`).join('\n')
    const pages = paginateChapter(content, metrics, measure)
    expect(pages.length).toBeGreaterThan(1)
    expect(pages[0].start).toBe(0)
    for (let i = 1; i < pages.length; i++) {
      expect(pages[i].start).toBe(pages[i - 1].end)
    }
    expect(pages[pages.length - 1].end).toBe(content.length)
  })

  it('页序号从 0 连续递增', () => {
    const content = Array.from({ length: 30 }, (_, i) => `内容${i}`).join('\n')
    const pages = paginateChapter(content, metrics, measure)
    pages.forEach((p, i) => expect(p.index).toBe(i))
  })

  it('拼接所有页可还原原文', () => {
    const content = Array.from({ length: 25 }, (_, i) => `这是第${i}段，用来测试分页不会丢字。`).join('\n')
    const pages = paginateChapter(content, metrics, measure)
    const rebuilt = pages.map((p) => pageText(content, p)).join('')
    expect(rebuilt).toBe(content)
  })

  it('每页最多放 maxLines 行（行 = 换行符前的内容）', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `第${i}行`)
    const content = lines.join('\n')
    const pages = paginateChapter(content, metrics, measure)
    // 每页 5 行 → 10 行应恰好 2 页
    expect(pages).toHaveLength(2)
    // 直接断言每页行数，比断言页数更能反映真实语义
    for (const page of pages) {
      const lineCount = pageText(content, page)
        .split('\n')
        .filter((s) => s.length > 0).length
      expect(lineCount).toBeLessThanOrEqual(5)
    }
  })

  it('换行符是行终止符，不是额外一行（"A\\nB" 是 2 行）', () => {
    const content = 'A\nB'
    // 每页 2 行 → 恰好 1 页
    const pages = paginateChapter(content, { ...metrics, contentHeight: 40 }, measure)
    expect(pages).toHaveLength(1)
    expect(pages[0].end).toBe(content.length)
  })

  it('maxLinesOverride 强制每页行数', () => {
    const fiveLines = Array.from({ length: 5 }, (_, i) => `第${i}行`).join('\n')
    // 5 行 / 每页 3 行 → 2 页
    const pages = paginateChapter(fiveLines, metrics, measure, 3)
    expect(pages).toHaveLength(2)
    expect(pages.map((p) => pageText(fiveLines, p)).join('')).toBe(fiveLines)
  })

  it('超长单行（跨多页）不会死循环且不丢字', () => {
    // 一行 500 个汉字，远超一页容量
    const longLine = '中'.repeat(500)
    const pages = paginateChapter(longLine, metrics, measure)
    expect(pages.length).toBeGreaterThan(1)
    expect(pages.map((p) => pageText(longLine, p)).join('')).toBe(longLine)
  })

  it('单个字符就超宽时仍能推进（不死循环）', () => {
    const tinyMetrics = { contentWidth: 1, contentHeight: 60, lineHeight: 20 }
    const pages = paginateChapter('中文字符测试', tinyMetrics, measure)
    expect(pages.length).toBeGreaterThan(1)
    expect(pages.map((p) => pageText('中文字符测试', p)).join('')).toBe('中文字符测试')
  })

  it('maxLinesOverride 强制每页行数', () => {
    const content = Array.from({ length: 10 }, (_, i) => `第${i}行`).join('\n')
    const pages = paginateChapter(content, metrics, measure, 3)
    // 5 行内容 / 每页 3 行 → 2 页
    const fiveLines = Array.from({ length: 5 }, (_, i) => `第${i}行`).join('\n')
    expect(paginateChapter(fiveLines, metrics, measure, 3)).toHaveLength(2)
    expect(pages.length).toBeGreaterThan(1)
  })

  it('连续换行会占多行（段落间距的近似）', () => {
    const content = 'A\n\n\n\nB'
    const pages = paginateChapter(content, { ...metrics, contentHeight: 60 }, measure) // 3 行/页
    expect(pages.map((p) => pageText(content, p)).join('')).toBe(content)
  })

  it('测量器返回 0（病态输入）也不会死循环', () => {
    const zero = () => 0
    const pages = paginateChapter('测试文本', metrics, zero)
    expect(pages.length).toBeGreaterThan(0)
    expect(pages[pages.length - 1].end).toBeLessThanOrEqual('测试文本'.length)
  })
})

describe('pageIndexForOffset — 偏移反查页码', () => {
  const pages = [
    { index: 0, start: 0, end: 10 },
    { index: 1, start: 10, end: 20 },
    { index: 2, start: 20, end: 30 },
  ]

  it('页首偏移落在该页', () => {
    expect(pageIndexForOffset(pages, 0)).toBe(0)
    expect(pageIndexForOffset(pages, 10)).toBe(1)
    expect(pageIndexForOffset(pages, 20)).toBe(2)
  })

  it('页中间偏移落在该页', () => {
    expect(pageIndexForOffset(pages, 5)).toBe(0)
    expect(pageIndexForOffset(pages, 15)).toBe(1)
    expect(pageIndexForOffset(pages, 25)).toBe(2)
  })

  it('页尾偏移（右开区间）落在下一页', () => {
    expect(pageIndexForOffset(pages, 9)).toBe(0)
    expect(pageIndexForOffset(pages, 19)).toBe(1)
  })

  it('负偏移夹到第一页', () => {
    expect(pageIndexForOffset(pages, -5)).toBe(0)
  })

  it('超出末尾夹到最后一页', () => {
    expect(pageIndexForOffset(pages, 999)).toBe(2)
  })

  it('空页数组返回 0 而不抛异常', () => {
    expect(pageIndexForOffset([], 5)).toBe(0)
  })

  it('与 paginateChapter 联用：任意偏移都能反查到包含它的页', () => {
    const content = Array.from({ length: 60 }, (_, i) => `第${i}段的内容文字`).join('\n')
    const metrics = { contentWidth: 160, contentHeight: 80, lineHeight: 20 }
    const measure = createMeasure(20)
    const built = paginateChapter(content, metrics, measure)
    for (let offset = 0; offset < content.length; offset += 7) {
      const pageIdx = pageIndexForOffset(built, offset)
      const page = built[pageIdx]
      expect(page.start).toBeLessThanOrEqual(offset)
      expect(page.end).toBeGreaterThan(offset)
    }
  })
})

describe('paginateByCharBudget — 降级分页', () => {
  it('按字数切分且可还原', () => {
    const content = Array.from({ length: 50 }, (_, i) => `第${i}行内容`).join('\n')
    const pages = paginateByCharBudget(content, 40)
    expect(pages.length).toBeGreaterThan(1)
    expect(pages.map((p) => pageText(content, p)).join('')).toBe(content)
  })

  it('尽量在换行处收尾', () => {
    const content = 'A'.repeat(30) + '\n' + 'B'.repeat(30) + '\n' + 'C'.repeat(30)
    const pages = paginateByCharBudget(content, 40)
    // 第一页应在换行后结束
    expect(content[pages[0].end - 1]).toBe('\n')
  })

  it('空内容返回一个空页', () => {
    const pages = paginateByCharBudget('', 10)
    expect(pages).toHaveLength(1)
    expect(pages[0].end).toBe(0)
  })

  it('预算小于 1 时被夹到 1，不会死循环', () => {
    const pages = paginateByCharBudget('abcdef', 0)
    expect(pages.length).toBe(6)
  })
})

describe('paginationCacheKey — 缓存失效', () => {
  const metrics = { contentWidth: 300, contentHeight: 500, lineHeight: 30 }

  it('相同参数得到相同键', () => {
    expect(paginationCacheKey(DEFAULT_TYPOGRAPHY, metrics)).toBe(paginationCacheKey(DEFAULT_TYPOGRAPHY, metrics))
  })

  it('字号变化导致键变化', () => {
    const a = paginationCacheKey(DEFAULT_TYPOGRAPHY, metrics)
    const b = paginationCacheKey({ ...DEFAULT_TYPOGRAPHY, fontSize: DEFAULT_TYPOGRAPHY.fontSize + 1 }, metrics)
    expect(a).not.toBe(b)
  })

  it('行距/边距/字重/对齐变化都导致键变化', () => {
    const base = paginationCacheKey(DEFAULT_TYPOGRAPHY, metrics)
    expect(paginationCacheKey({ ...DEFAULT_TYPOGRAPHY, lineHeight: 2 }, metrics)).not.toBe(base)
    expect(paginationCacheKey({ ...DEFAULT_TYPOGRAPHY, margin: 30 }, metrics)).not.toBe(base)
    expect(paginationCacheKey({ ...DEFAULT_TYPOGRAPHY, bold: !DEFAULT_TYPOGRAPHY.bold }, metrics)).not.toBe(base)
    expect(paginationCacheKey({ ...DEFAULT_TYPOGRAPHY, justify: !DEFAULT_TYPOGRAPHY.justify }, metrics)).not.toBe(base)
  })

  it('视口尺寸变化导致键变化（旋转屏幕必须重新分页）', () => {
    const a = paginationCacheKey(DEFAULT_TYPOGRAPHY, metrics)
    const b = paginationCacheKey(DEFAULT_TYPOGRAPHY, { ...metrics, contentWidth: 600 })
    expect(a).not.toBe(b)
  })
})

describe('estimateCharsPerScreen — 每屏字数估算', () => {
  it('估算值与几何容量一致', () => {
    const metrics = { contentWidth: 300, contentHeight: 600, lineHeight: 30 }
    // 300/20 = 15 字/行，600/30 = 20 行 → 300 字
    expect(estimateCharsPerScreen(metrics, 20)).toBe(300)
  })

  it('极小视口至少返回 1', () => {
    expect(estimateCharsPerScreen({ contentWidth: 1, contentHeight: 1, lineHeight: 100 }, 40)).toBeGreaterThanOrEqual(1)
  })
})

describe('visualWeight — 视觉字数权重', () => {
  it('汉字记 1', () => {
    expect(visualWeight('中文')).toBe(2)
  })

  it('ASCII 记 0.5', () => {
    expect(visualWeight('abcd')).toBe(2)
  })

  it('空白与换行不计', () => {
    expect(visualWeight('中 文\n字')).toBe(3)
  })

  it('空串为 0', () => {
    expect(visualWeight('')).toBe(0)
  })
})

describe('pickWordAt — 从光标处取词', () => {
  it('取到光标所在的连续汉字片段', () => {
    const text = '他握紧了剑柄，指节泛白'
    // 光标在「剑」上（索引 4）
    expect(pickWordAt(text, 4)).toContain('剑')
  })

  it('在标点处断开', () => {
    const text = '少年负剑出门，山风扑面'
    const word = pickWordAt(text, 6)
    expect(word).not.toContain('，')
  })

  it('跳过光标所在位置的标点', () => {
    const text = '他说，然后走了'
    const word = pickWordAt(text, 2)
    expect(word.length).toBeGreaterThan(0)
    expect(/^[，。！？；：、]+$/.test(word)).toBe(false)
  })

  it('不返回空白', () => {
    expect(pickWordAt('   ', 1)).toBe('')
  })

  it('空文本返回空串', () => {
    expect(pickWordAt('', 0)).toBe('')
  })

  it('最多取 8 个字，避免选中整段', () => {
    const text = '中'.repeat(50)
    const word = pickWordAt(text, 25)
    expect(word.length).toBeLessThanOrEqual(8)
  })

  it('越界光标被夹紧，不抛异常', () => {
    expect(() => pickWordAt('短文', 999)).not.toThrow()
    expect(() => pickWordAt('短文', -5)).not.toThrow()
  })
})

describe('chapterHeadingLabel — 章节上方的小标签', () => {
  it('普通数字章节输出「第 N 章」', () => {
    expect(chapterHeadingLabel({ title: '雪夜', index: 4 })).toBe('第 5 章')
    expect(chapterHeadingLabel({ title: '初入江湖', index: 0 })).toBe('第 1 章')
  })

  it('特殊篇名不编号（楔子被标成「第 2 章」会与标题语义冲突）', () => {
    expect(chapterHeadingLabel({ title: '楔子 雪夜', index: 1 })).toBe('篇外')
    expect(chapterHeadingLabel({ title: '序章', index: 0 })).toBe('篇外')
    expect(chapterHeadingLabel({ title: '番外 那年春深', index: 15 })).toBe('篇外')
    expect(chapterHeadingLabel({ title: '后记', index: 20 })).toBe('篇外')
    expect(chapterHeadingLabel({ title: '尾声', index: 21 })).toBe('篇外')
  })

  it('标题已含序号时不再重复编号', () => {
    expect(chapterHeadingLabel({ title: '第一章 初入江湖', index: 1 })).toBe('正文')
    expect(chapterHeadingLabel({ title: '第4章 夜探听雨楼', index: 4 })).toBe('正文')
    expect(chapterHeadingLabel({ title: '第 九 章 归途', index: 9 })).toBe('正文')
    expect(chapterHeadingLabel({ title: '第一百二十三章 巅峰', index: 122 })).toBe('正文')
    expect(chapterHeadingLabel({ title: '第十二回 试探', index: 11 })).toBe('正文')
  })

  it('英文 Chapter 标题标记为正文', () => {
    expect(chapterHeadingLabel({ title: 'Chapter 1 The Gate', index: 0 })).toBe('正文')
    expect(chapterHeadingLabel({ title: 'CHAPTER 2 Return', index: 1 })).toBe('正文')
  })

  it('纯标题（无序号、非特殊篇名）按序号编号', () => {
    expect(chapterHeadingLabel({ title: '剑冢', index: 6 })).toBe('第 7 章')
  })
})
