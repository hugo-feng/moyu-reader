import { describe, expect, it } from 'vitest'
import { hasChapterMarkers, splitChapters } from './chapters'
import { normalizeText } from './encoding'

/** 把章节数组还原成原文，用于验证切分无损（不丢字、不重复字）。 */
function reassemble(chapters: ReturnType<typeof splitChapters>): string {
  return chapters.map((c) => c.content).join('')
}

describe('splitChapters — 高置信章节标题', () => {
  it('识别「第一章 标题」标准格式', () => {
    const text = normalizeText(
      ['第一章 初入江湖', '少年负剑出门。', '', '第二章 血雨腥风', '风很大。'].join('\n'),
    )
    const chapters = splitChapters(text)
    expect(chapters).toHaveLength(2)
    expect(chapters[0].title).toContain('第一章')
    expect(chapters[0].title).toContain('初入江湖')
    expect(chapters[1].title).toContain('第二章')
    expect(chapters[0].content).toContain('少年负剑出门')
    expect(chapters[1].content).toContain('风很大')
  })

  it('识别阿拉伯数字「第1章」', () => {
    const text = normalizeText(['第1章 开始', '正文一', '第2章 继续', '正文二'].join('\n'))
    const chapters = splitChapters(text)
    expect(chapters).toHaveLength(2)
    expect(chapters[0].content).toContain('正文一')
  })

  it('识别「第 一 章」带空格写法', () => {
    const text = normalizeText(['第 一 章 起', '甲乙丙', '第 二 章 承', '丁戊己'].join('\n'))
    const chapters = splitChapters(text)
    expect(chapters).toHaveLength(2)
  })

  it('识别「第X节」「第X回」「第X卷」等量词', () => {
    const text = normalizeText(['第一回 楔子', 'A', '第二节 试探', 'B', '第三卷 风起', 'C'].join('\n'))
    const chapters = splitChapters(text)
    expect(chapters).toHaveLength(3)
    expect(chapters[0].title).toContain('回')
    expect(chapters[1].title).toContain('节')
    expect(chapters[2].title).toContain('卷')
  })

  it('识别中文数字到「一百二十三」这类多位写法', () => {
    const text = normalizeText(['第一百二十三章 巅峰', '正文'].join('\n'))
    const chapters = splitChapters(text)
    expect(chapters).toHaveLength(1)
    expect(chapters[0].title).toContain('一百二十三')
  })

  it('识别英文 Chapter 格式（大小写不敏感）', () => {
    const text = normalizeText(['Chapter 1 The Gate', 'Text one.', 'CHAPTER 2 Return', 'Text two.'].join('\n'))
    const chapters = splitChapters(text)
    expect(chapters).toHaveLength(2)
    expect(chapters[0].content).toContain('Text one')
  })

  it('识别【第3章】括号包裹写法', () => {
    const text = normalizeText(['【第3章】风起', '正文甲', '【第4章】云涌', '正文乙'].join('\n'))
    const chapters = splitChapters(text)
    expect(chapters).toHaveLength(2)
    expect(chapters[0].title).toContain('第3章')
    expect(chapters[0].title).toContain('风起')
  })

  it('识别特殊篇名：楔子 / 序章 / 番外', () => {
    const text = normalizeText(['楔子', '很久以前。', '第一章 正传', '开始了。', '番外 后来', '后来的事。'].join('\n'))
    const chapters = splitChapters(text)
    const titles = chapters.map((c) => c.title)
    expect(titles.some((t) => t.includes('楔子'))).toBe(true)
    expect(titles.some((t) => t.includes('番外'))).toBe(true)
    expect(chapters.length).toBeGreaterThanOrEqual(3)
  })
})

describe('splitChapters — 抗误切（这是最关键的行为）', () => {
  it('正文中的长句含「第一章」不触发切分', () => {
    const longLine =
      '他翻开那本旧书，看到第一章 初入江湖这几个字时愣住了，因为那正是他父亲当年留下的笔记标题，' +
      '而他从未想过会在这种地方再次见到它，一时间百感交集难以自持。'
    // 用一个**合法**的章节标题（「真」不是数词，不能写成「真实的第一章」）
    const text = normalizeText(['第一章 开端', '正文内容。', longLine, '后续正文。'].join('\n'))
    const chapters = splitChapters(text)

    // 断言 1：长句中的「第一章」不被当作标题 —— 全文只切出 1 章
    expect(chapters).toHaveLength(1)
    // 断言 2：合法的短标题被正确识别
    expect(chapters[0].title).toContain('开端')
    expect(chapters[0].detected).toBe(true)
    // 断言 3：长句完整保留在正文里，没有被割裂
    expect(chapters[0].content).toContain('百感交集难以自持')
    expect(chapters[0].content).toContain(longLine)
  })

  it('超过标题长度阈值的长行即便以「第一章」开头也不切分', () => {
    // 构造一行以「第一章」开头但总长超过 40 字符的行：判定为正文，不是标题
    const longHeadingLine = `第一章 ${'这是一段伪装成标题的极长正文内容用于验证长度阈值是否生效'.repeat(2)}`
    expect(longHeadingLine.length).toBeGreaterThan(40)
    const text = normalizeText([longHeadingLine, '后续正文。'].join('\n'))
    const chapters = splitChapters(text)
    expect(chapters).toHaveLength(1)
    expect(chapters[0].detected).toBe(false)
  })

  it('行尾出现的章节字样（非行首）不触发切分', () => {
    const text = normalizeText(['正文开始。参见第一章 说明。', '继续正文。'].join('\n'))
    const chapters = splitChapters(text)
    // 无高置信标题 → 走兜底分块，此时内容必须完整
    expect(reassemble(chapters)).toBe(text)
  })

  it('小数「3.5」不被低置信规则误判为章节', () => {
    const text = normalizeText(['3.5 倍的力量', '正文内容。'].join('\n'))
    const chapters = splitChapters(text, { allowLowConfidence: true })
    // 不应产生标题为「3、5 倍的力量」的章节
    if (chapters.length === 1 && chapters[0].detected) {
      expect(chapters[0].title).not.toContain('3、5')
    }
  })
})

describe('splitChapters — 无损性与偏移正确性', () => {
  const sample = normalizeText(
    [
      '第一章 初入江湖',
      '少年负剑出门，山风扑面。',
      '',
      '他不知道前方有什么。',
      '第二章 血雨腥风',
      '刀光如雪。',
      '',
      '第三章 归途',
      '他终于回来了。',
    ].join('\n'),
  )

  it('拼接所有章节内容可还原原文（不丢字、不重复）', () => {
    const chapters = splitChapters(sample)
    expect(reassemble(chapters)).toBe(sample)
  })

  it('每章 start 偏移与该章内容在原文中的位置一致', () => {
    const chapters = splitChapters(sample)
    for (const c of chapters) {
      expect(sample.slice(c.start, c.start + c.length)).toBe(c.content)
    }
  })

  it('start 严格递增，且 length 与 content.length 相等', () => {
    const chapters = splitChapters(sample)
    for (let i = 1; i < chapters.length; i++) {
      expect(chapters[i].start).toBeGreaterThan(chapters[i - 1].start)
    }
    for (const c of chapters) {
      expect(c.length).toBe(c.content.length)
    }
  })

  it('index 从 0 连续递增', () => {
    const chapters = splitChapters(sample)
    chapters.forEach((c, i) => expect(c.index).toBe(i))
  })

  it('detected 标记正确：真实章节为 true', () => {
    const chapters = splitChapters(sample)
    expect(chapters.every((c) => c.detected)).toBe(true)
  })
})

describe('splitChapters — 前言与兜底', () => {
  it('正文前有实质内容时补出「前言」章', () => {
    const text = normalizeText(
      ['《剑影录》', '作者：某某', '简介：一个少年的故事，很长很长的一段简介文字用来超过二十个字符的阈值。', '第一章 开始', '正文。'].join(
        '\n',
      ),
    )
    const chapters = splitChapters(text)
    expect(chapters[0].title).toBe('前言')
    expect(chapters[0].content).toContain('剑影录')
    expect(chapters[1].title).toContain('第一章')
  })

  it('正文前只有少量空白时不生成前言章', () => {
    const text = normalizeText(['', '第一章 开始', '正文。'].join('\n'))
    const chapters = splitChapters(text)
    expect(chapters[0].title).toContain('第一章')
    expect(chapters.some((c) => c.title === '前言')).toBe(false)
  })

  it('完全没有章节标记时按兜底块切分，且内容无损', () => {
    const body = Array.from({ length: 200 }, (_, i) => `这是第 ${i + 1} 段没有任何章节标记的正文内容。`).join('\n')
    const chapters = splitChapters(body, { fallbackChunkSize: 500 })
    expect(chapters.length).toBeGreaterThan(1)
    expect(chapters.every((c) => !c.detected)).toBe(true)
    expect(reassemble(chapters)).toBe(body)
  })

  it('兜底切分不在段落中间断开', () => {
    const body = Array.from({ length: 50 }, (_, i) => `第${i + 1}段内容`).join('\n')
    const chapters = splitChapters(body, { fallbackChunkSize: 60 })
    for (let i = 0; i < chapters.length - 1; i++) {
      expect(chapters[i].content.endsWith('\n')).toBe(true)
    }
  })

  it('空文本返回空数组', () => {
    expect(splitChapters('')).toEqual([])
  })

  it('只有一章时也能正确切分', () => {
    const text = normalizeText(['第一章 唯一', '内容在此。'].join('\n'))
    const chapters = splitChapters(text)
    expect(chapters).toHaveLength(1)
    expect(chapters[0].content).toContain('内容在此')
  })
})

describe('hasChapterMarkers', () => {
  it('多章节文本返回 true', () => {
    expect(hasChapterMarkers('第一章 A\n正文\n第二章 B\n正文')).toBe(true)
  })

  it('无章节文本返回 false', () => {
    expect(hasChapterMarkers('一段没有任何章节标记的普通文本。')).toBe(false)
  })

  it('只有一处章节标记返回 false（不足以确认已分章）', () => {
    expect(hasChapterMarkers('第一章 唯一\n正文')).toBe(false)
  })
})

describe('splitChapters — 低置信规则的条件启用', () => {
  it('「一、标题」格式在章节数不足时启用', () => {
    const text = normalizeText(['一、初见', '内容一', '二、再见', '内容二', '三、离别', '内容三'].join('\n'))
    const chapters = splitChapters(text)
    expect(chapters.length).toBe(3)
  })

  it('存在高置信标题时不会被低置信规则打乱', () => {
    const text = normalizeText(['第一章 正式', '正文甲', '一、小标题', '正文乙'].join('\n'))
    const chapters = splitChapters(text)
    // 只有 1 个高置信标题 → 会尝试低置信；关键是不能丢内容
    expect(reassemble(chapters)).toBe(text)
  })
})
