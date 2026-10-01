/**
 * 演示书内容。
 *
 * 用途：让验证器一打开就有真实可读的长篇内容，从而能真正验证分章、分页、
 * 翻页、搜索、统计这些功能，而不是面对一个空书架。内容为本项目原创，
 * 刻意写成多样化的章节标题格式，用来压测分章算法。
 */

export const DEMO_BOOK_TITLE = '剑影长歌'
export const DEMO_BOOK_AUTHOR = '墨阅示例'

/** 生成一段有辨识度的正文，避免重复文本让搜索测试失去意义。 */
function para(seed: string, n: number): string {
  const pool = [
    '山道上积雪未消，脚踩下去发出细碎的声响。',
    '他握紧了剑柄，指节因用力而泛白。',
    '远处传来一声悠长的钟鸣，惊起满林寒鸦。',
    '风从峡谷深处卷上来，带着铁锈与松脂的气味。',
    '她没有回头，只把斗篷的兜帽压低了些。',
    '灯火在窗纸上晃出一个模糊的人影。',
    '茶已经凉透，杯底沉着一层暗褐色的叶屑。',
    '马蹄声由远及近，又在门前骤然停住。',
    '刀锋映着月光，像一线流动的水银。',
    '他忽然笑了一声，那笑意却没有到达眼底。',
    '老人把一卷泛黄的帛书推到桌案中央。',
    '雨点开始敲打屋檐，先是零星，继而连成一片。',
    '她袖中的短匕已经滑出半寸。',
    '少年抬起头，眼里的惊惶已经褪尽。',
    '石门在身后缓缓合拢，隔绝了最后一线天光。',
  ]
  const out: string[] = []
  for (let i = 0; i < n; i++) {
    out.push(pool[(i * 7 + seed.length) % pool.length])
    if (i % 3 === 2) {
      out.push(`第 ${i + 1} 次交手之后，${seed}这个名字开始在江湖上被人低声提起，带着几分忌惮，也带着几分说不清的期待。`)
    }
    if (i % 5 === 4) {
      out.push('　')
    }
  }
  return out.join('')
}

/** 章节标题刻意混用多种格式，用于验证分章算法的兼容性。 */
const DEMO_CHAPTERS: Array<{ title: string; body: string }> = [
  { title: '楔子 雪夜', body: para('雪夜', 6) },
  { title: '第一章 初入江湖', body: para('初入江湖', 9) },
  { title: '第二章 血雨腥风', body: para('血雨腥风', 8) },
  { title: '第三章 剑冢', body: para('剑冢', 10) },
  { title: '第4章 夜探听雨楼', body: para('听雨楼', 7) },
  { title: '第五章 故人之约', body: para('故人', 9) },
  { title: '第六章 一线生机', body: para('生机', 8) },
  { title: '第七章 落子无悔', body: para('落子', 11) },
  { title: '第八章 长歌当哭', body: para('长歌', 7) },
  { title: '第 九 章 归途', body: para('归途', 10) },
  { title: '第十章 灯下人', body: para('灯下人', 8) },
  { title: '第十一章 千金一诺', body: para('一诺', 9) },
  { title: '第十二章 山雨欲来', body: para('山雨', 12) },
  { title: '第十三章 剑影长歌', body: para('剑影', 10) },
  { title: '番外 那年春深', body: para('春深', 6) },
]

export function buildDemoBookText(): string {
  const head = [
    `《${DEMO_BOOK_TITLE}》`,
    `作者：${DEMO_BOOK_AUTHOR}`,
    '简介：一个少年从雪夜山道出发，走过剑冢与听雨楼，最终把名字留在江湖上的故事。本示例文本由墨阅阅读器项目原创，仅用于功能验证。',
    '',
  ].join('\n')

  const chapters = DEMO_CHAPTERS.map((c) => `${c.title}\n${c.body}`).join('\n\n')
  return `${head}\n${chapters}\n`
}

/** 演示用的书签/笔记文本片段（导入后自动生成，便于验证笔记功能）。 */
export function demoAnnotationSnippets(): Array<{ chapterIndex: number; cue: string; note: string }> {
  return [
    { chapterIndex: 1, cue: '他握紧了剑柄', note: '开篇的动作描写很克制，没有直接写紧张。' },
    { chapterIndex: 3, cue: '刀锋映着月光', note: '这一段的意象用得好。' },
    { chapterIndex: 6, cue: '老人把一卷泛黄的帛书', note: '关键道具出现了。' },
  ]
}
