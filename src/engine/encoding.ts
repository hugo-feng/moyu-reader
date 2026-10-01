/**
 * 文本编码识别与解码。
 *
 * 背景：本地 TXT 小说的编码没有统一标准。中文网络小说常见的三种情况是
 * UTF-8（含 BOM）、GB18030/GBK，以及少量 UTF-16。若统一按 UTF-8 解码，
 * GBK 文本会整篇变成替换字符 —— 这是同类 App 最常见的差评来源。
 *
 * 实现取向：**不自造字节级校验器**。WHATWG Encoding 标准已在平台内建
 * `TextDecoder`，其 `fatal: true` 模式就是严格的合法性校验（拒绝过长编码、
 * 代理区码点、越界值、截断序列），并且浏览器与 Node 行为一致。
 * 这里只用它做两件事：判定「能不能按 UTF-8 解码」，以及按指定编码解码。
 */

import type { TextEncoding } from './types'

export interface DecodeResult {
  /** 解码后的文本 */
  text: string
  /** 实际采用的编码 */
  encoding: TextEncoding
  /** 解码过程中产生的替换字符数量，越小越可信 */
  replacementCount: number
  /** 是否依赖了兜底分支（用于 UI 提示「编码可能不准确，可手动切换」） */
  uncertain: boolean
}

/**
 * 是否严格符合 UTF-8。
 *
 * 用平台内建的 `TextDecoder` 以 fatal 模式尝试解码：能通过即为合法 UTF-8。
 * 这比手写状态机更可靠，也不会漏掉标准里新增的约束。
 */
export function isValidUtf8(bytes: Uint8Array): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return true
  } catch {
    return false
  }
}

/** 是否存在数量可观的可打印 ASCII 或 CJK 字符（用于判断解码结果是否可信）。 */
function readableRatio(text: string): number {
  if (text.length === 0) return 1
  let readable = 0
  const sample = Math.min(text.length, 4000)
  for (let i = 0; i < sample; i++) {
    const c = text.charCodeAt(i)
    const isCjk = c >= 0x4e00 && c <= 0x9fff
    const isAsciiPrintable = c >= 0x20 && c <= 0x7e
    const isCommonPunct = c === 0x0a || c === 0x0d || c === 0x09
    const isFullWidth = c >= 0x3000 && c <= 0x303f
    const isCjkPunct = c >= 0xff00 && c <= 0xffef
    if (isCjk || isAsciiPrintable || isCommonPunct || isFullWidth || isCjkPunct) readable++
  }
  return readable / sample
}

/** 是否支持某个解码标签。 */
export function isEncodingSupported(label: string): boolean {
  try {
    new TextDecoder(label, { fatal: false })
    return true
  } catch {
    return false
  }
}

/** 用指定编码解码，并容忍非法序列（不抛异常）。 */
export function decodeWith(bytes: Uint8Array, label: string): string {
  return new TextDecoder(label, { fatal: false }).decode(bytes)
}

function countReplacementChars(text: string): number {
  let n = 0
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 0xfffd) n++
  }
  return n
}

/**
 * 识别并解码一段字节流。
 *
 * 策略（按优先级，全部为明确判定，不做「猜」）：
 *   1. 有 BOM 直接采信 BOM（UTF-8 / UTF-16LE / UTF-16BE）；
 *   2. fatal 模式尝试 UTF-8，通过即判定 UTF-8 —— 误判率极低；
 *   3. 无 BOM 的 UTF-16 启发式；
 *   4. 判定 GB18030（GBK 的超集，覆盖全部中文 Windows 编码）；
 *   5. 兜底 UTF-8，并把不确定标记暴露给调用方，让 UI 提示手工切换。
 */
export function detectAndDecode(bytes: Uint8Array): DecodeResult {
  // 1) BOM 优先
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    const text = decodeWith(bytes, 'utf-16le')
    return { text, encoding: 'utf-16le', replacementCount: 0, uncertain: false }
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const text = decodeWith(bytes, 'utf-16be')
    return { text, encoding: 'utf-16be', replacementCount: 0, uncertain: false }
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(3))
    return { text, encoding: 'utf-8', replacementCount: 0, uncertain: false }
  }

  // 2) 严格 UTF-8 判定（整段校验：避免「前半段合法、后半段乱码」被误判为 UTF-8）
  if (isValidUtf8(bytes)) {
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
    return {
      text,
      encoding: 'utf-8',
      replacementCount: countReplacementChars(text),
      uncertain: false,
    }
  }

  // 3) 无 BOM 的 UTF-16 启发式：ASCII 文本在 UTF-16 下会出现大量 0x00 字节
  const probe = bytes.subarray(0, Math.min(bytes.length, 65536))
  if (probe.length >= 4) {
    let evenNulls = 0
    let oddNulls = 0
    const pairs = Math.floor(probe.length / 2)
    for (let i = 0; i < pairs; i++) {
      if (probe[i * 2] === 0x00) evenNulls++
      if (probe[i * 2 + 1] === 0x00) oddNulls++
    }
    if (pairs > 0) {
      const evenRatio = evenNulls / pairs
      const oddRatio = oddNulls / pairs
      if (oddRatio > 0.3 && evenRatio < 0.05) {
        const text = decodeWith(bytes, 'utf-16le')
        return { text, encoding: 'utf-16le', replacementCount: 0, uncertain: true }
      }
      if (evenRatio > 0.3 && oddRatio < 0.05) {
        const text = decodeWith(bytes, 'utf-16be')
        return { text, encoding: 'utf-16be', replacementCount: 0, uncertain: true }
      }
    }
  }

  // 4) GB18030（GBK 的超集，覆盖全部中文 Windows 编码）
  if (isEncodingSupported('gb18030')) {
    const text = decodeWith(bytes, 'gb18030')
    const replacements = countReplacementChars(text)
    return {
      text,
      encoding: 'gb18030',
      replacementCount: replacements,
      uncertain: replacements > 0 || readableRatio(text) < 0.5,
    }
  }

  // 5) 兜底
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  return {
    text,
    encoding: 'utf-8',
    replacementCount: countReplacementChars(text),
    uncertain: true,
  }
}

/**
 * 用指定编码强制重新解码（用户在 UI 上手工切换编码时调用）。
 */
export function decodeAs(bytes: Uint8Array, encoding: TextEncoding): DecodeResult {
  const label =
    encoding === 'gb18030' ? 'gb18030' : encoding === 'utf-16le' ? 'utf-16le' : encoding === 'utf-16be' ? 'utf-16be' : 'utf-8'
  // 重新解码时跳过 BOM，避免 BOM 字符混入正文
  let slice = bytes
  if (encoding === 'utf-8' && bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    slice = bytes.subarray(3)
  }
  const text = decodeWith(slice, label)
  const replacements = countReplacementChars(text)
  return {
    text,
    encoding,
    replacementCount: replacements,
    uncertain: replacements > 0 || readableRatio(text) < 0.5,
  }
}

/**
 * 编码质量评分，用于 UI 自动给出「更可能的编码」建议。
 * 分数越高越可信；评分依据是可读字符比例与替换字符比例。
 */
export function scoreDecoding(bytes: Uint8Array, encoding: TextEncoding): number {
  const { text, replacementCount } = decodeAs(bytes, encoding)
  if (text.length === 0) return 1
  const readable = readableRatio(text)
  const replacementPenalty = replacementCount / text.length
  return Math.max(0, readable - replacementPenalty * 4)
}

/** 归一化换行符，并去除 UTF-8 BOM 字符（若以字符形式残留）。 */
export function normalizeText(raw: string): string {
  let text = raw
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}
