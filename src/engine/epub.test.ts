/**
 * EPUB 解析测试。
 *
 * 这个测试文件必须跑在 jsdom 下：`htmlToPlainText` 用平台内建的 `DOMParser`
 * 解析 XHTML（这是它比正则剥离可靠的原因），而 Node 环境没有 DOMParser，
 * 会退化成不处理实体、丢弃图片的降级分支，测出来的是假失败。
 *
 * @vitest-environment jsdom
 */

import { describe, expect, it } from 'vitest'
import { htmlToPlainText, stripLeadingHeading } from './epub'

describe('htmlToPlainText — XHTML 转纯文本', () => {
  it('提取段落文本', () => {
    const html = '<html><body><p>第一段</p><p>第二段</p></body></html>'
    const text = htmlToPlainText(html)
    expect(text).toContain('第一段')
    expect(text).toContain('第二段')
    // 块级元素之间必须有换行，否则段落会被粘成一行
    expect(text.split('\n').filter(Boolean).length).toBe(2)
  })

  it('剔除 script 与 style 内容（正则方案最常翻车的地方）', () => {
    const html = `<html><head><style>p{color:red}</style></head>
      <body><script>var secret = "不应出现";</script><p>正文内容</p></body></html>`
    const text = htmlToPlainText(html)
    expect(text).toContain('正文内容')
    expect(text).not.toContain('不应出现')
    expect(text).not.toContain('color:red')
  })

  it('<br> 转换为换行', () => {
    const text = htmlToPlainText('<body><p>上行<br/>下行</p></body>')
    expect(text).toContain('上行\n下行')
  })

  it('图片转为占位符，保留 alt', () => {
    const text = htmlToPlainText('<body><p>前<img src="a.png" alt="插图"/>后</p></body>')
    expect(text).toContain('［图：插图］')
  })

  it('无 alt 的图片给出通用占位符', () => {
    const text = htmlToPlainText('<body><p><img src="a.png"/></p></body>')
    expect(text).toContain('［图片］')
  })

  it('解码 HTML 实体', () => {
    const text = htmlToPlainText('<body><p>&lt;引号&gt; &amp; &quot;内容&quot;</p></body>')
    expect(text).toContain('<引号>')
    expect(text).toContain('&')
    expect(text).toContain('"内容"')
  })

  it('&nbsp; 转为普通空格', () => {
    const text = htmlToPlainText('<body><p>甲&nbsp;乙</p></body>')
    expect(text).not.toContain('\u00a0')
    expect(text).toContain('甲 乙')
  })

  it('行首的全角空格被清除（避免与首行缩进叠加成两格）', () => {
    // 这是实测截图中真实出现过的问题：正文行首带 　 导致缩进加倍
    const text = htmlToPlainText('<body><p>\u3000\u3000这是一段带全角缩进的正文</p></body>')
    expect(text.startsWith('\u3000')).toBe(false)
    expect(text.startsWith(' ')).toBe(false)
    expect(text).toBe('这是一段带全角缩进的正文')
  })

  it('行首的普通空格与制表符被清除', () => {
    const text = htmlToPlainText('<body><p>   \t 正文</p></body>')
    expect(text).toBe('正文')
  })

  it('连续空行折叠为一个段落间距', () => {
    const text = htmlToPlainText('<body><p>甲</p><p></p><p></p><p>乙</p></body>')
    expect(text).not.toMatch(/\n{3,}/)
    expect(text).toContain('甲')
    expect(text).toContain('乙')
  })

  it('未闭合标签不会让整章错乱（解析器容错）', () => {
    const text = htmlToPlainText('<body><p>第一段<p>第二段<p>第三段</body>')
    expect(text).toContain('第一段')
    expect(text).toContain('第二段')
    expect(text).toContain('第三段')
  })

  it('注释被忽略', () => {
    const text = htmlToPlainText('<body><!-- 这是注释 --><p>正文</p></body>')
    expect(text).not.toContain('这是注释')
    expect(text).toContain('正文')
  })

  it('空文档返回空串', () => {
    expect(htmlToPlainText('<body></body>')).toBe('')
  })
})

describe('stripLeadingHeading — 消除标题重复显示', () => {
  it('剥掉与标题相同的首行', () => {
    const text = '第三章 剑冢\n远处传来一声悠长的钟鸣。'
    expect(stripLeadingHeading(text, '第三章 剑冢')).toBe('远处传来一声悠长的钟鸣。')
  })

  it('忽略空白差异后仍能匹配', () => {
    const text = '第三章   剑冢\n正文内容'
    expect(stripLeadingHeading(text, '第三章 剑冢')).toBe('正文内容')
  })

  it('首行比标题更短时不动它（宁可留重复标题，也不误删正文）', () => {
    // 文档内 h1 是「剑冢」，目录标题是「第三章 剑冢」。
    // 此时无法确定「剑冢」是标题还是正文，保守起见保留。
    const text = '剑冢\n正文内容'
    expect(stripLeadingHeading(text, '第三章 剑冢')).toBe(text)
  })

  it('首行 = 标题 + 副标题 时剥掉整行', () => {
    const text = '第三章 剑冢·上\n正文内容'
    expect(stripLeadingHeading(text, '第三章 剑冢')).toBe('正文内容')
  })

  it('正文首行与标题无关时不动它', () => {
    const text = '远处传来一声悠长的钟鸣。\n第二段。'
    expect(stripLeadingHeading(text, '第三章 剑冢')).toBe(text)
  })

  it('整章只有标题时返回空串', () => {
    expect(stripLeadingHeading('第三章 剑冢', '第三章 剑冢')).toBe('')
  })

  it('标题为空时原样返回', () => {
    const text = '任意正文'
    expect(stripLeadingHeading(text, '')).toBe(text)
  })

  it('空文本原样返回', () => {
    expect(stripLeadingHeading('', '标题')).toBe('')
  })

  it('剥掉标题后多余的空行被清理', () => {
    const text = '第一章 开端\n\n\n正文内容'
    expect(stripLeadingHeading(text, '第一章 开端')).toBe('正文内容')
  })

  it('不会误删看起来相似但实为正文的首行', () => {
    // 「剑冢深处有人」虽然包含「剑冢」，但不是标题本身，也不是以标题开头
    const text = '雾隐山\n剑冢深处有人点灯。'
    expect(stripLeadingHeading(text, '第三章 剑冢')).toBe(text)
  })
})
