import { describe, expect, it } from 'vitest'
import {
  decodeAs,
  detectAndDecode,
  isEncodingSupported,
  isValidUtf8,
  normalizeText,
  scoreDecoding,
} from './encoding'

/** GB18030 编码字节（用 Node 内置 encoder 生成，模拟真实 GBK 小说文件）。 */
function gb18030Bytes(text: string): Uint8Array {
  // Node 的 TextEncoder 只支持 UTF-8，因此这里手工编码常见汉字：
  // 用 iconv 不引入额外依赖，改为查表法构造几个高频字的 GBK 码位。
  const gbkTable: Record<string, [number, number]> = {
    我: [0xce, 0xd2],
    是: [0xca, 0xc7],
    一: [0xd2, 0xbb],
    个: [0xb8, 0xf6],
    中: [0xd6, 0xd0],
    国: [0xb9, 0xfa],
    人: [0xc8, 0xcb],
    小: [0xd0, 0xa1],
    说: [0xcb, 0xb5],
    '\n': [0x0a, 0x00],
  }
  const out: number[] = []
  for (const ch of text) {
    if (ch === '\n') {
      out.push(0x0a)
      continue
    }
    if (ch.charCodeAt(0) < 0x80) {
      out.push(ch.charCodeAt(0))
      continue
    }
    const pair = gbkTable[ch]
    if (!pair) throw new Error(`测试表缺少字符: ${ch}`)
    out.push(pair[0], pair[1])
  }
  return new Uint8Array(out)
}

function utf8Bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

describe('isValidUtf8 — 字节级严格校验', () => {
  it('接受纯 ASCII', () => {
    expect(isValidUtf8(utf8Bytes('hello world'))).toBe(true)
  })

  it('接受合法中文 UTF-8', () => {
    expect(isValidUtf8(utf8Bytes('我的中国小说'))).toBe(true)
  })

  it('接受空数组', () => {
    expect(isValidUtf8(new Uint8Array([]))).toBe(true)
  })

  it('拒绝孤立续字节 0x80', () => {
    expect(isValidUtf8(new Uint8Array([0x80]))).toBe(false)
  })

  it('拒绝截断的多字节序列', () => {
    // 0xE4 0xB8 是「中」的前两字节，缺第三字节
    expect(isValidUtf8(new Uint8Array([0xe4, 0xb8]))).toBe(false)
  })

  it('拒绝过长编码（overlong）', () => {
    // 0xC0 0x80 是 NUL 的过长编码，必须拒绝
    expect(isValidUtf8(new Uint8Array([0xc0, 0x80]))).toBe(false)
    // 0xE0 0x80 0x80 是三字节过长编码
    expect(isValidUtf8(new Uint8Array([0xe0, 0x80, 0x80]))).toBe(false)
  })

  it('拒绝 UTF-16 代理区码点', () => {
    // U+D800 的 UTF-8 编码是 ED A0 80，属非法
    expect(isValidUtf8(new Uint8Array([0xed, 0xa0, 0x80]))).toBe(false)
  })

  it('拒绝超出 Unicode 范围的码点', () => {
    // 0xF5 开头的五字节序列非法
    expect(isValidUtf8(new Uint8Array([0xf5, 0x80, 0x80, 0x80]))).toBe(false)
  })

  it('拒绝 0xFF / 0xFE', () => {
    expect(isValidUtf8(new Uint8Array([0xff]))).toBe(false)
    expect(isValidUtf8(new Uint8Array([0xfe]))).toBe(false)
  })

  it('正确切分 GBK 字节流（应判为非法 UTF-8）', () => {
    const gbk = gb18030Bytes('我是中国')
    expect(isValidUtf8(gbk)).toBe(false)
  })
})

describe('detectAndDecode — BOM 处理', () => {
  it('UTF-8 BOM 被剥离，不混入正文', () => {
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8Bytes('我的中国')])
    const r = detectAndDecode(withBom)
    expect(r.encoding).toBe('utf-8')
    expect(r.text).toBe('我的中国')
    expect(r.text.charCodeAt(0)).not.toBe(0xfeff)
  })

  it('UTF-16LE BOM 被识别', () => {
    const text = '我的中国'
    const bytes = new Uint8Array(2 + text.length * 2)
    bytes[0] = 0xff
    bytes[1] = 0xfe
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i)
      bytes[2 + i * 2] = c & 0xff
      bytes[3 + i * 2] = (c >> 8) & 0xff
    }
    const r = detectAndDecode(bytes)
    expect(r.encoding).toBe('utf-16le')
    expect(r.text).toContain('我的中国')
  })

  it('UTF-16BE BOM 被识别', () => {
    const text = '我的中国'
    const bytes = new Uint8Array(2 + text.length * 2)
    bytes[0] = 0xfe
    bytes[1] = 0xff
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i)
      bytes[2 + i * 2] = (c >> 8) & 0xff
      bytes[3 + i * 2] = c & 0xff
    }
    const r = detectAndDecode(bytes)
    expect(r.encoding).toBe('utf-16be')
    expect(r.text).toContain('我的中国')
  })
})

describe('detectAndDecode — 无 BOM 推断', () => {
  it('UTF-8 中文被正确保留', () => {
    const r = detectAndDecode(utf8Bytes('第一章 初入江湖\n\n少年负剑出门。'))
    expect(r.encoding).toBe('utf-8')
    expect(r.text).toContain('初入江湖')
    expect(r.replacementCount).toBe(0)
    expect(r.uncertain).toBe(false)
  })

  it('GBK 文本不会被误判为 UTF-8', () => {
    const gbk = gb18030Bytes('我是中国')
    const r = detectAndDecode(gbk)
    expect(r.encoding).not.toBe('utf-8')
  })

  it('环境支持 gb18030 解码器（Android/Node 均支持）', () => {
    expect(isEncodingSupported('gb18030')).toBe(true)
  })

  it('GBK 解码结果可读且无替换字符', () => {
    const gbk = gb18030Bytes('我是中国')
    const r = detectAndDecode(gbk)
    expect(r.text).toBe('我是中国')
    expect(r.replacementCount).toBe(0)
  })

  it('空文件不崩溃', () => {
    const r = detectAndDecode(new Uint8Array([]))
    expect(r.text).toBe('')
  })

  it('纯 ASCII 判为 UTF-8', () => {
    const r = detectAndDecode(utf8Bytes('Chapter 1\n\nHello.'))
    expect(r.encoding).toBe('utf-8')
    expect(r.uncertain).toBe(false)
  })
})

describe('decodeAs — 用户手工切换编码', () => {
  it('强制指定 gb18030 可正确解码 GBK 字节', () => {
    const gbk = gb18030Bytes('我是中国')
    const r = decodeAs(gbk, 'gb18030')
    expect(r.text).toBe('我是中国')
    expect(r.replacementCount).toBe(0)
  })

  it('强制指定 utf-8 解码 GBK 会产生替换字符（证明编码切换确实生效）', () => {
    const gbk = gb18030Bytes('我是中国')
    const r = decodeAs(gbk, 'utf-8')
    expect(r.replacementCount).toBeGreaterThan(0)
  })

  it('decodeAs 也会剥离 UTF-8 BOM', () => {
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8Bytes('测试')])
    expect(decodeAs(withBom, 'utf-8').text).toBe('测试')
  })
})

describe('scoreDecoding — 编码质量评分', () => {
  it('正确编码的得分高于错误编码', () => {
    const gbk = gb18030Bytes('我是中国')
    const good = scoreDecoding(gbk, 'gb18030')
    const bad = scoreDecoding(gbk, 'utf-8')
    expect(good).toBeGreaterThan(bad)
  })

  it('评分落在 0..1 区间', () => {
    const bytes = utf8Bytes('中文abc')
    for (const enc of ['utf-8', 'gb18030'] as const) {
      const s = scoreDecoding(bytes, enc)
      expect(s).toBeGreaterThanOrEqual(0)
      expect(s).toBeLessThanOrEqual(1)
    }
  })
})

describe('normalizeText — 换行与 BOM 归一化', () => {
  it('CRLF 转为 LF', () => {
    expect(normalizeText('a\r\nb\r\nc')).toBe('a\nb\nc')
  })

  it('孤立 CR 转为 LF', () => {
    expect(normalizeText('a\rb')).toBe('a\nb')
  })

  it('字符形式的 BOM 被去除', () => {
    expect(normalizeText('\uFEFF第一章')).toBe('第一章')
  })

  it('不改变普通文本', () => {
    expect(normalizeText('第一章\n正文')).toBe('第一章\n正文')
  })
})
