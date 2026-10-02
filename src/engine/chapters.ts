/**
 * TXT 自动分章。
 *
 * 中文小说的章节标题格式极度混乱，同目录下可能同时出现：
 *   第一章 初入江湖 / 第1章 初入江湖 / 【第一章】初入江湖 / 第 一 章 初入江湖
 *   Chapter 12 The Gate / CHAPTER 1 / 十二、初入江湖 / 卷一 风起 / 楔子 / 番外一
 *
 * 设计原则：**宁可少切，不可错切**。错切会让正文被割裂，比不分章更糟。
 * 因此分两级判定：
 *   - 高置信：行首出现「第 N 章/节/回…」这类明确序号，且整行足够短（标题不会很长）；
 *   - 低置信：整行极短、且形如「一、标题」或纯序号，仅在没有高置信结果时才启用。
 *
 * 另外输出顺序递增的 `start` 偏移，使全局字符偏移成为进度/书签/搜索的统一坐标系。
 */

import type { Chapter } from './types'

/** 中文数字，含大写与「两」「〇」。 */
const CN_NUM = '[0-9零一二三四五六七八九十百千万两〇壹贰叁肆伍陆柒捌玖拾佰仟]'

/** 章节量词。顺序影响可读性，不影响匹配。 */
const CN_UNIT = '章节回卷节篇部集话話'

/** 高置信：第X章 / 第X节 / 第X回 …，允许「第」与数字间、数字与量词间有空格。 */
const RE_NUMBERED = new RegExp(
  `^[\\s\\u3000]*(?:第[\\s\\u3000]*(${CN_NUM}{1,12})[\\s\\u3000]*[${CN_UNIT}])(?:[\\s\\u3000]*[:：.、,，\\-—]?[\\s\\u3000]*)(.*)$`,
)

/** 「卷」类：第X卷，视为分部标题，同样接受。 */
const RE_VOLUME = new RegExp(`^[\\s\\u3000]*第[\\s\\u3000]*(${CN_NUM}{1,12})[\\s\\u3000]*[卷部篇][\\s\\u3000]*[:：.、]?[\\s\\u3000]*(.*)$`)

/** 英文：Chapter 12 / CHAPTER 12 / Chap. 12。 */
const RE_ENGLISH = /^[\s\u3000]*(?:chapter|chap\.?|part|section)[\s\u3000]*([0-9]{1,4}|[ivxlcdm]{1,8})[\s\u3000]*[:：.\-—]?[\s\u3000]*(.*)$/i

/** 括号或书名号包裹的标题：【第3章】标题 / 《第3章 标题》 */
const RE_BRACKETED = new RegExp(`^[\\s\\u3000]*[【《\\[（(]\\s*(第[\\s\\u3000]*${CN_NUM}{1,12}[\\s\\u3000]*[${CN_UNIT}])([^】》\\]）)]*)[】》\\]）)]\\s*(.*)$`)

/** 特殊篇名的词表（不含分组），供正则的两个分支复用。 */
const SPECIAL_NAME = '序章|序言|序|自序|前言|引子|楔子|引言|尾声|终章|完结章|后记|附录|番外[0-9零一二三四五六七八九十]*|外传|作者的话|作品相关|設定|设定|人物介绍'

/**
 * 特殊篇名：序章、楔子、引子、尾声、后记、番外 等。
 *
 * 这里曾经写成「篇名 + 可选分隔符 + 最多 30 字的尾巴」，看起来宽松无害，
 * 实际会把**以篇名开头的普通句子**整句当成标题：正文里的「前言部分内容。」
 * 会被切成一个叫「前言部分内容。 部分内容。」的章节（尾巴还被重复拼了一遍）。
 * 中文小说里「前言里说过…」「楔子其实…」这样的句子太常见，这是会真实切错章的 bug。
 *
 * 收紧的依据是中文篇名的实际写法：篇名与标题之间**一定有空白分隔**
 * （「楔子 雪夜」「番外 那年春深」「尾声 归途」），否则整行就是一个纯篇名
 * （「前言」「楔子」「番外一」）。
 * 于是改成两选一：要么「纯篇名 + 可选标点」整行结束，要么「篇名 + 空白 + 标题」。
 * 「前言部分内容。」两者都不满足 —— 它既不是纯篇名，篇名后也没有空白。
 *
 * 分组约定（**改动正则时必须同步维护**，取错组会让功能静默失效）：
 *   group1 = 分支 1 命中的纯篇名（「楔子」）
 *   group2 = 分支 2 命中的篇名（「楔子」），group3 = 标题（「雪夜」）
 * 每个分支都带自己的捕获组，取哪个组的规则见 matchTitleLine。
 *
 * 第一个分支的尾部空白写成 `[ \t\u3000]*` 而不是 `[\s\u3000]*`，这一点很关键：
 * `\s` 包含换行，会让分支 1 把「楔子 雪夜」中间的空格吃掉后仍然匹配成功，
 * 于是整行被「纯篇名」分支抢走，真正的标题反而被当成了篇名。
 * 只允许空格与制表符，就能逼正则引擎在遇到「空格 + 标题」时改走分支 2。
 *
 * Android 端 ChapterSplitter.kt 的同名正则必须与此保持一致。
 */
const RE_SPECIAL = new RegExp(
  `^[\\s\\u3000]*(${SPECIAL_NAME})[ \\t\\u3000]*[:：.、]?[ \\t\\u3000]*$` +
    `|^[\\s\\u3000]*(${SPECIAL_NAME})[\\s\\u3000]+(.{1,30})[\\s\\u3000]*$`,
)

/**
 * 低置信：一、标题 / 十二.标题（中文数字 + 顿号/点）
 *
 * 这里的标点是**必需**的，不能写成「数字 + 可选标点」。
 * 曾经就是因为标点可选，低置信重扫从「楔子 雪夜」里剥出一个「一」当成序号，
 * 把整行变成章节「一、楔子 雪夜」—— 凭空造出一章，比漏切更糟。
 * 真实的「一、标题」写法里，顿号从不缺席。
 */
const RE_LOW_CONFIDENCE = new RegExp(`^[\\s\\u3000]*(${CN_NUM}{1,12})[\\s\\u3000]*[、.．][\\s\\u3000]*(.{1,30})$`)

/** 裸数字行：123（极端情况，仅在完全没有其他章节时使用） */
const RE_BARE_NUMBER = /^[\s\u3000]*([0-9]{1,4})[\s\u3000]*$/

/** 标题行最大长度：超过则视为正文中的普通句子，不切。 */
const MAX_TITLE_LINE_LENGTH = 40

/**
 * 标题最长多少字之后就不像标题、而像正文了。
 *
 * 与 [MAX_TITLE_LINE_LENGTH] 是两个不同用途的阈值，别混淆：
 *   - MAX_TITLE_LINE_LENGTH（40）：**扫描时**过滤，太长的行根本不作为候选
 *   - 本常量（24）：**已识别为候选之后**再判断它像不像标题，
 *     用于拦住「短篇里唯一一行像标题的正文」
 * 后者更严，因为要补偿「整篇只剩一个候选」时的低容错。
 */
const MAX_PLAUSIBLE_TITLE_LENGTH = 24

/** 句末标点：出现它们说明这是正文句子，不是标题。 */
const PROSE_ENDINGS = /[。！？；…]$|[，、]$/

/**
 * 判断一行「读起来像不像正文」而不是标题。
 *
 * 与 Android 端 ChapterSplitter.looksLikeProse 必须一致。
 * 判据是长度与句末标点，**与全文长短无关**：按全文长度判断会误伤
 * 合法的短文本（测试固件就是短文本，实测踩过）。
 */
function looksLikeProse(title: string): boolean {
  const t = title.trim()
  if (t.length > MAX_PLAUSIBLE_TITLE_LENGTH) return true
  return PROSE_ENDINGS.test(t)
}

export interface SplitOptions {
  /** 是否启用低置信规则（默认在无高置信结果时自动启用） */
  allowLowConfidence?: boolean
  /** 完全不分章时的兜底块大小（字符数） */
  fallbackChunkSize?: number
  /** 兜底块是否按段落边界切分，避免切断句子 */
  fallbackOnParagraph?: boolean
}

interface Candidate {
  offset: number
  title: string
  confidence: 'high' | 'low'
}

/** 去掉标题里的序号残留，让列表更干净。 */
function cleanTitle(raw: string): string {
  return raw
    .replace(/[\s\u3000]+/g, ' ')
    .replace(/^[:：.、,，\-—]+/, '')
    .replace(/[:：.、,，\-—]+$/, '')
    .trim()
}

/**
 * 扫描文本，找出所有候选章节标题的偏移。
 *
 * 注意：这里只扫描每一行的行首，且跳过超长行 —— 这是避免误切的关键。
 */
function collectCandidates(text: string, allowLowConfidence: boolean): Candidate[] {
  const candidates: Candidate[] = []
  let lineStart = 0

  while (lineStart <= text.length) {
    let lineEnd = text.indexOf('\n', lineStart)
    if (lineEnd === -1) lineEnd = text.length

    const line = text.slice(lineStart, lineEnd)
    const trimmedLength = line.trim().length

    if (trimmedLength > 0 && trimmedLength <= MAX_TITLE_LINE_LENGTH) {
      const hit = matchTitleLine(line, allowLowConfidence)
      if (hit) {
        candidates.push({ offset: lineStart, title: hit.title, confidence: hit.confidence })
      }
    }

    if (lineEnd === text.length) break
    lineStart = lineEnd + 1
  }

  return candidates
}

/** 对单行做标题匹配，返回标题与置信度。 */
function matchTitleLine(
  line: string,
  allowLowConfidence: boolean,
): { title: string; confidence: 'high' | 'low' } | null {
  // 特殊篇名（序章/楔子/番外…）：高置信，但要求整行不长
  const special = RE_SPECIAL.exec(line)
  if (special) {
    // 分支 2（篇名 + 空白 + 标题）命中时 group2/group3 有值，标题是「篇名 标题」；
    // 分支 1（纯篇名）命中时只有 group1，标题就是篇名本身。
    const marker = cleanTitle(special[2] ?? '')
    const tail = cleanTitle(special[3] ?? '')
    if (marker) return { title: tail ? `${marker} ${tail}` : marker, confidence: 'high' }
    return { title: cleanTitle(special[1] ?? ''), confidence: 'high' }
  }

  // 【第一章】标题 / 《第1章 标题》
  const bracketed = RE_BRACKETED.exec(line)
  if (bracketed) {
    const head = cleanTitle(bracketed[1] ?? '')
    const inner = cleanTitle(bracketed[2] ?? '')
    const tail = cleanTitle(bracketed[3] ?? '')
    const parts = [head, inner, tail].filter(Boolean)
    return { title: parts.join(' '), confidence: 'high' }
  }

  // 第X章 / 第X节 / 第X回
  const numbered = RE_NUMBERED.exec(line)
  if (numbered) {
    const head = cleanTitle(`第${numbered[1]}章`)
    // 量词可能是「节/回/卷」等，用原行前段重建更稳妥
    const unitMatch = new RegExp(`第[\\s\\u3000]*${CN_NUM}{1,12}[\\s\\u3000]*([${CN_UNIT}])`).exec(line)
    const unit = unitMatch ? unitMatch[1] : '章'
    const rebuilt = cleanTitle(`第${numbered[1]}${unit}`)
    const tail = cleanTitle(numbered[2] ?? '')
    return { title: tail ? `${rebuilt} ${tail}` : (rebuilt || head), confidence: 'high' }
  }

  // 第X卷 / 第X部 / 第X篇
  const volume = RE_VOLUME.exec(line)
  if (volume) {
    const unitMatch = new RegExp(`第[\\s\\u3000]*${CN_NUM}{1,12}[\\s\\u3000]*([卷部篇])`).exec(line)
    const unit = unitMatch ? unitMatch[1] : '卷'
    const rebuilt = cleanTitle(`第${volume[1]}${unit}`)
    const tail = cleanTitle(volume[2] ?? '')
    return { title: tail ? `${rebuilt} ${tail}` : rebuilt, confidence: 'high' }
  }

  // Chapter 12
  const english = RE_ENGLISH.exec(line)
  if (english) {
    const rebuilt = cleanTitle(line.slice(0, line.length - (english[2] ?? '').length))
    const tail = cleanTitle(english[2] ?? '')
    return { title: tail ? `${rebuilt} ${tail}` : rebuilt, confidence: 'high' }
  }

  if (allowLowConfidence) {
    const low = RE_LOW_CONFIDENCE.exec(line)
    if (low) {
      const tail = cleanTitle(low[2] ?? '')
      // 排除「3.5」「1.2」这类小数，避免把正文里的数字当章节
      if (tail && !/^[0-9]/.test(tail)) {
        return { title: cleanTitle(`${low[1]}、${tail}`), confidence: 'low' }
      }
    }
    const bare = RE_BARE_NUMBER.exec(line)
    if (bare) {
      return { title: `第 ${bare[1]} 章`, confidence: 'low' }
    }
  }

  return null
}

/** 按段落边界把长文本切成兜底块。 */
function chunkByParagraph(text: string, chunkSize: number): Chapter[] {
  const chapters: Chapter[] = []
  const len = text.length
  let index = 0
  let cursor = 0

  while (cursor < len) {
    let end = Math.min(cursor + chunkSize, len)
    if (end < len) {
      // 向后寻找最近的换行，避免切断句子；最多再多看 20% 长度
      const searchLimit = Math.min(len, end + Math.floor(chunkSize * 0.2))
      const nl = text.indexOf('\n', end)
      if (nl !== -1 && nl < searchLimit) end = nl + 1
    }
    const content = text.slice(cursor, end)
    if (content.trim().length > 0 || index === 0) {
      chapters.push({
        bookId: '',
        index: index++,
        title: `第 ${index} 节`,
        content,
        start: cursor,
        length: content.length,
        detected: false,
      })
    }
    cursor = end
  }
  return chapters
}

/**
 * 把整本书的文本切成章节。
 *
 * @param text 已归一化换行（\n）的全文
 * @param options 切分选项
 */
export function splitChapters(text: string, options: SplitOptions = {}): Chapter[] {
  const chunkSize = options.fallbackChunkSize ?? 3000

  if (text.length === 0) return []

  // 先只用高置信规则扫一遍
  let candidates = collectCandidates(text, false)

  // 只有在「完全没有高置信标题」时才启用低置信规则。
  //
  // 这里曾用一个更激进的判据（候选数 < 2 就启用低置信重扫），但那会导致
  // 只有 1 个真实标题的文本被低置信结果**替换**掉，反而丢掉准确的章节标题。
  // 单一高置信标题本身是有效信息，应当保留。
  if (candidates.length === 0 && (options.allowLowConfidence === true || options.allowLowConfidence === undefined)) {
    candidates = collectCandidates(text, true)
  }

  // 仍然没有章节特征 → 按段落兜底切块
  if (candidates.length === 0) {
    return chunkByParagraph(text, chunkSize)
  }

  /**
   * 值不值得切 —— 只在「只有一个候选标题，且那个标题不像标题」时拦。
   *
   * 与 Android 端 ChapterSplitter.split 的同名判断**必须保持一致**：
   * 分章结果是用户可见的核心行为，两端不一致会让人无法用验证器
   * 去判断 Android 端是否正常。
   *
   * 防的是：短篇小说里出现一行像章节标题的**正文句子**，
   * 于是全文被切成两节，第一节只有开头一小段。
   *
   * 判据按「那一行像不像标题」（长度 + 句末标点），
   * **不能**按全文长度 —— 后者会把合法的短文本一并拦掉
   * （测试固件本身就是短文本，实测踩过这个坑）。
   */
  if (candidates.length === 1 && looksLikeProse(candidates[0].title)) {
    return [
      {
        bookId: '',
        index: 0,
        title: '全文',
        content: text,
        start: 0,
        length: text.length,
        detected: false,
      },
    ]
  }

  // 丢弃首个候选前的空白，但保留其作为「前言」章节
  const chapters: Chapter[] = []

  // 处理卷标题：以「卷/部/篇」为标记的行不单独成章，而是并入其后的章节标题，
  // 但为简化与稳定，这里统一作为独立章节保留（阅读时体验与主流 App 一致）。
  for (let i = 0; i < candidates.length; i++) {
    const cur = candidates[i]
    const next = candidates[i + 1]
    const end = next ? next.offset : text.length
    const content = text.slice(cur.offset, end)
    chapters.push({
      bookId: '',
      index: i,
      title: cur.title || `第 ${i + 1} 章`,
      content,
      start: cur.offset,
      length: content.length,
      detected: true,
    })
  }

  // 若正文之前有实质内容（通常是书名、作者、简介），补一个「前言」章
  const firstOffset = candidates[0].offset
  if (firstOffset > 0) {
    const preface = text.slice(0, firstOffset)
    if (preface.trim().length > 20) {
      chapters.unshift({
        bookId: '',
        index: 0,
        title: '前言',
        content: preface,
        start: 0,
        length: preface.length,
        detected: false,
      })
      chapters.forEach((c, i) => {
        c.index = i
      })
    }
  }

  return chapters
}

/**
 * 判定文本是否「看起来已经分好章」。
 * 供导入流程决定是否提示用户「未识别到章节，已按 3000 字分节」。
 */
export function hasChapterMarkers(text: string): boolean {
  return collectCandidates(text, false).length >= 2
}
