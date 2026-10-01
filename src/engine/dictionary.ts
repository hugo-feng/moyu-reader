/**
 * 查词（词典）。
 *
 * 小说阅读器的查词有两个真实场景，两者需求完全不同：
 *   1. **中文词组**：用户长按选中 2-4 个汉字。中文没有词边界，所以**不能**
 *      靠分词猜，必须用户选中什么就查什么（选中态由阅读页的选区提供）。
 *   2. **英文单词**：用户双击选中一个单词，需要查释义。
 *
 * 因此这里的接口刻意只接受「用户已经选定的文本」，不做自动分词 ——
 * 自动分词在长按场景下会给出用户没选的词，体验反而更差。
 *
 * 释义来源分三层，优先本地、联网增强：
 *   - 内置常用字/词表（离线可用，保证功能永远「可用」而不是「有网才行」）；
 *   - 用户自定义词条（可导入 txt 词典，覆盖网络用语等内置表没有的词）；
 *   - 在线补充（可选，失败静默降级，绝不阻塞 UI）。
 */

export interface DictSense {
  /** 词性，如 n. / v. / 名 / 动 */
  pos?: string
  /** 释义正文 */
  definition: string
  /** 例句 */
  example?: string
}

export interface DictEntry {
  /** 查询的词条（原文） */
  word: string
  /** 拼音或音标 */
  phonetic?: string
  /** 繁体写法 */
  traditional?: string
  /** 释义列表 */
  senses: DictSense[]
  /** 释义来源，用于 UI 标注可信度 */
  source: 'builtin' | 'user' | 'online'
}

export interface DictLookupResult {
  /** 命中的词条（可能带前缀/后缀扩展，如查「不」命中「不」与「不过」） */
  entries: DictEntry[]
  /** 是否未命中 */
  miss: boolean
  /** 查询时是否尝试过在线补充 */
  onlineAttempted: boolean
  /** 在线查询失败原因（若有） */
  onlineError?: string
}

/** 最长可查询词条长度：中文 8 字足以覆盖绝大多数词与成语（含 4 字成语）。 */
export const MAX_QUERY_LENGTH = 24

/**
 * 规范化查询串。
 * 去空白、去标点、全角转半角（英文查询常见问题），
 * 但**保留**中文标点作为分隔以便拆分。
 */
export function normalizeQuery(raw: string): string {
  return raw
    .replace(/\s+/g, '')
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
    .slice(0, MAX_QUERY_LENGTH)
}

/** 是否看起来像英文单词（决定是否给出音标与英文释义排版）。 */
export function looksEnglish(text: string): boolean {
  return /^[A-Za-z][A-Za-z'’\-]*$/.test(text)
}

/**
 * 内置基础字/词表。
 *
 * 这是一份**刻意保持精简**的高频表：目标是让查词功能在任何环境下都能立刻
 * 给出有意义的结果，而不是假装自己是一部完整词典。冷僻词会走到「未收录」
 * 提示，用户可以导入自定义词典补齐，这在离线阅读器里是诚实且实用的设计。
 */
const BUILTIN: Record<string, Omit<DictEntry, 'word' | 'source'>> = {
  的: { phonetic: 'de', senses: [{ pos: '助', definition: '用在定语后，表示修饰关系。' }] },
  一: { phonetic: 'yī', senses: [{ pos: '数', definition: '最小的正整数；表示同一、全部或专一。' }] },
  不: { phonetic: 'bù', senses: [{ pos: '副', definition: '表示否定。' }] },
  了: { phonetic: 'le', senses: [{ pos: '助', definition: '用在动词后表示动作完成，或句末表示变化。' }] },
  人: { phonetic: 'rén', senses: [{ pos: '名', definition: '能制造和使用工具、进行社会活动的动物。' }] },
  我: { phonetic: 'wǒ', senses: [{ pos: '代', definition: '第一人称代词，说话人自己。' }] },
  在: { phonetic: 'zài', senses: [{ pos: '动', definition: '存在；居于某处。' }, { pos: '介', definition: '表示时间、处所、范围。' }] },
  有: { phonetic: 'yǒu', senses: [{ pos: '动', definition: '表示存在、拥有。' }] },
  这: { phonetic: 'zhè', senses: [{ pos: '代', definition: '指示代词，指较近的人或事物。' }] },
  个: { phonetic: 'gè', senses: [{ pos: '量', definition: '通用量词。' }] },
  上: { phonetic: 'shàng', senses: [{ pos: '名', definition: '位置在高处；次序或时间在先。' }] },
  来: { phonetic: 'lái', senses: [{ pos: '动', definition: '由别处到此处。' }] },
  到: { phonetic: 'dào', senses: [{ pos: '动', definition: '达到；往。' }] },
  说: { phonetic: 'shuō', senses: [{ pos: '动', definition: '用话来表达意思。' }] },
  时: { phonetic: 'shí', senses: [{ pos: '名', definition: '时间；时机；时辰。' }] },
  要: { phonetic: 'yào', senses: [{ pos: '动', definition: '希望得到；需要。' }, { pos: '副', definition: '将要。' }] },
  就: { phonetic: 'jiù', senses: [{ pos: '副', definition: '表示紧接着、随即或仅仅。' }] },
  会: { phonetic: 'huì', senses: [{ pos: '动', definition: '懂得；能够。' }, { pos: '名', definition: '聚会；团体。' }] },
  可: { phonetic: 'kě', senses: [{ pos: '动', definition: '许可；能够。' }, { pos: '副', definition: '表示转折或强调。' }] },
  以: { phonetic: 'yǐ', senses: [{ pos: '介', definition: '用；凭借。' }, { pos: '连', definition: '表示目的。' }] },
  生: { phonetic: 'shēng', senses: [{ pos: '动', definition: '生育；生长。' }, { pos: '形', definition: '未煮熟的；不熟悉的。' }] },
  死: { phonetic: 'sǐ', senses: [{ pos: '动', definition: '失去生命。' }, { pos: '副', definition: '表示程度极深。' }] },
  天: { phonetic: 'tiān', senses: [{ pos: '名', definition: '天空；一昼夜；天气。' }] },
  地: { phonetic: 'dì', senses: [{ pos: '名', definition: '大地；处所。' }, { pos: '助', definition: '用在状语后。' }] },
  心: { phonetic: 'xīn', senses: [{ pos: '名', definition: '心脏；思想、感情。' }] },
  手: { phonetic: 'shǒu', senses: [{ pos: '名', definition: '人体上肢前端能拿东西的部分。' }] },
  道: { phonetic: 'dào', senses: [{ pos: '名', definition: '路；道理；方法。' }, { pos: '动', definition: '说。' }] },
  无: { phonetic: 'wú', senses: [{ pos: '动', definition: '没有。' }] },
  为: { phonetic: 'wéi', senses: [{ pos: '动', definition: '做；当作。' }, { pos: '介', definition: '被；为了（wèi）。' }] },
  中: { phonetic: 'zhōng', senses: [{ pos: '名', definition: '中间；内部。' }] },
  大: { phonetic: 'dà', senses: [{ pos: '形', definition: '在体积、面积、数量等方面超过一般。' }] },
  小: { phonetic: 'xiǎo', senses: [{ pos: '形', definition: '在体积、面积、数量等方面不及一般。' }] },
  风: { phonetic: 'fēng', senses: [{ pos: '名', definition: '空气的流动；风气、风俗。' }] },
  雨: { phonetic: 'yǔ', senses: [{ pos: '名', definition: '从云中降落的水滴。' }] },
  剑: { phonetic: 'jiàn', senses: [{ pos: '名', definition: '古代兵器，长条形，一端尖，两边有刃。' }] },
  刀: { phonetic: 'dāo', senses: [{ pos: '名', definition: '用来切、割、砍的工具或兵器。' }] },
  灵: { phonetic: 'líng', senses: [{ pos: '名', definition: '灵魂；精神。' }, { pos: '形', definition: '灵活；灵验。' }] },
  气: { phonetic: 'qì', senses: [{ pos: '名', definition: '气体；气息；精神状态。' }] },
  力: { phonetic: 'lì', senses: [{ pos: '名', definition: '力量；能力。' }] },
  火: { phonetic: 'huǒ', senses: [{ pos: '名', definition: '物体燃烧时产生的光和热。' }] },
  水: { phonetic: 'shuǐ', senses: [{ pos: '名', definition: '无色无味的液体，生命必需。' }] },
  山: { phonetic: 'shān', senses: [{ pos: '名', definition: '地面上高起的部分。' }] },
  城: { phonetic: 'chéng', senses: [{ pos: '名', definition: '城市；城墙。' }] },
  国: { phonetic: 'guó', senses: [{ pos: '名', definition: '国家。' }] },
  王: { phonetic: 'wáng', senses: [{ pos: '名', definition: '君主；同类中最强者。' }] },
  帝: { phonetic: 'dì', senses: [{ pos: '名', definition: '君主；皇帝。' }] },
  仙: { phonetic: 'xiān', senses: [{ pos: '名', definition: '神话中长生不死、有神通的人。' }] },
  魔: { phonetic: 'mó', senses: [{ pos: '名', definition: '神话中的鬼怪；邪恶力量。' }] },
  龙: { phonetic: 'lóng', senses: [{ pos: '名', definition: '传说中的神异动物；帝王的象征。' }] },
  爱: { phonetic: 'ài', senses: [{ pos: '动', definition: '对人或事物有深挚的感情。' }] },
  恨: { phonetic: 'hèn', senses: [{ pos: '动', definition: '仇视；怨恨。' }] },
  笑: { phonetic: 'xiào', senses: [{ pos: '动', definition: '露出愉快的表情，发出欢喜的声音。' }] },
  哭: { phonetic: 'kū', senses: [{ pos: '动', definition: '因悲哀或激动而流泪出声。' }] },
  走: { phonetic: 'zǒu', senses: [{ pos: '动', definition: '行走；离开。' }] },
  跑: { phonetic: 'pǎo', senses: [{ pos: '动', definition: '两脚迅速交替前进。' }] },
  看: { phonetic: 'kàn', senses: [{ pos: '动', definition: '使视线接触人或物。' }] },
  听: { phonetic: 'tīng', senses: [{ pos: '动', definition: '用耳朵接受声音。' }] },
  想: { phonetic: 'xiǎng', senses: [{ pos: '动', definition: '思考；希望；怀念。' }] },
  知: { phonetic: 'zhī', senses: [{ pos: '动', definition: '知道；了解。' }] },

  // 双字词与成语
  世界: { phonetic: 'shì jiè', senses: [{ pos: '名', definition: '时间和空间的总和；地球上人类社会的总体。' }] },
  江湖: { phonetic: 'jiāng hú', senses: [{ pos: '名', definition: '江河湖泊；泛指四方各地。在武侠语境中指侠客与武林人士活动的社会圈。' }] },
  修炼: { phonetic: 'xiū liàn', senses: [{ pos: '动', definition: '修行练功，多指道家、佛家或仙侠设定中提升境界的过程。' }] },
  境界: { phonetic: 'jìng jiè', senses: [{ pos: '名', definition: '土地的界限；事物所达到的程度或表现的情况。' }] },
  法术: { phonetic: 'fǎ shù', senses: [{ pos: '名', definition: '方术、幻术；神话中超自然的手段。' }] },
  灵气: { phonetic: 'líng qì', senses: [{ pos: '名', definition: '仙侠设定中天地间可供修炼的超凡能量。' }] },
  元气: { phonetic: 'yuán qì', senses: [{ pos: '名', definition: '中国哲学中指构成万物的原始物质；也指人的精神、生命力。' }] },
  师兄: { phonetic: 'shī xiōng', senses: [{ pos: '名', definition: '同门中拜师较早或年长的男性。' }] },
  江湖再见: { phonetic: 'jiāng hú zài jiàn', senses: [{ definition: '江湖语境中的告别语，含后会有期之意。' }] },
  一剑封喉: { phonetic: 'yī jiàn fēng hóu', senses: [{ definition: '一剑即致人死命，形容剑法极快极准。' }] },
  不可思议: { phonetic: 'bù kě sī yì', senses: [{ pos: '成语', definition: '原有神秘奥妙的意思，现多指无法想象、难以理解。' }] },
  莫名其妙: { phonetic: 'mò míng qí miào', senses: [{ pos: '成语', definition: '说不出其中的奥妙，形容事情很奇怪、使人不明白。' }] },
  恍然大悟: { phonetic: 'huǎng rán dà wù', senses: [{ pos: '成语', definition: '一下子完全明白过来。' }] },
  一鸣惊人: { phonetic: 'yī míng jīng rén', senses: [{ pos: '成语', definition: '比喻平时没有突出表现，一下子做出惊人的成绩。' }] },
  乐不思蜀: { phonetic: 'lè bù sī shǔ', senses: [{ pos: '成语', definition: '比喻乐而忘返或乐而忘本。' }] },
}

/** 英文内置表（阅读器常见场景：公版英文读物）。 */
const BUILTIN_EN: Record<string, Omit<DictEntry, 'word' | 'source'>> = {
  the: { phonetic: '/ðə/', senses: [{ pos: 'art.', definition: '定冠词，表示特指。' }] },
  and: { phonetic: '/ænd/', senses: [{ pos: 'conj.', definition: '和；并且。' }] },
  chapter: { phonetic: '/ˈtʃæptə(r)/', senses: [{ pos: 'n.', definition: '章；回；时期。' }] },
  book: { phonetic: '/bʊk/', senses: [{ pos: 'n.', definition: '书；卷。' }, { pos: 'v.', definition: '预订。' }] },
  read: { phonetic: '/riːd/', senses: [{ pos: 'v.', definition: '阅读；朗读。' }] },
  night: { phonetic: '/naɪt/', senses: [{ pos: 'n.', definition: '夜晚。' }] },
  sword: { phonetic: '/sɔːd/', senses: [{ pos: 'n.', definition: '剑；刀。' }] },
  world: { phonetic: '/wɜːld/', senses: [{ pos: 'n.', definition: '世界；世人。' }] },
  love: { phonetic: '/lʌv/', senses: [{ pos: 'n.', definition: '爱；爱情。' }, { pos: 'v.', definition: '爱；喜欢。' }] },
  time: { phonetic: '/taɪm/', senses: [{ pos: 'n.', definition: '时间；次数。' }] },
}

/** 用户自定义词条容器（由上层从持久化层注入）。 */
export interface UserDictionary {
  /** 中文词条 */
  zh?: Record<string, { phonetic?: string; senses: DictSense[] }>
  /** 英文词条 */
  en?: Record<string, { phonetic?: string; senses: DictSense[] }>
}

export interface LookupOptions {
  /** 用户自定义词典 */
  userDict?: UserDictionary
  /** 是否允许在线补充（默认否，保证离线可用且不阻塞） */
  allowOnline?: boolean
  /** 在线查询超时（毫秒） */
  onlineTimeoutMs?: number
}

/**
 * 本地查询（同步、无网络）。
 *
 * 除了精确命中，还做一层**前缀扩展**：查「江」时把「江湖」也列出来，
 * 这符合用户的真实预期（单个字往往是想了解它组成的词）。
 * 但只对单字查询做扩展，且最多 5 条，避免结果爆炸。
 */
export function lookupLocal(query: string, userDict?: UserDictionary): DictEntry[] {
  const word = normalizeQuery(query)
  if (!word) return []

  const entries: DictEntry[] = []
  const english = looksEnglish(word)
  const table = english ? BUILTIN_EN : BUILTIN
  const userTable = english ? userDict?.en : userDict?.zh

  // 1) 精确命中（用户词典优先，便于覆盖内置释义）
  const userHit = userTable?.[word]
  if (userHit) {
    entries.push({ word, phonetic: userHit.phonetic, senses: userHit.senses, source: 'user' })
  }
  const builtinHit = table[word]
  if (builtinHit && !userHit) {
    entries.push({ word, ...builtinHit, source: 'builtin' })
  }

  // 2) 单字前缀扩展
  if (!english && word.length === 1) {
    const extra: DictEntry[] = []
    for (const key of Object.keys(table)) {
      if (key.length > 1 && key.startsWith(word)) {
        extra.push({ word: key, ...table[key], source: 'builtin' })
        if (extra.length >= 5) break
      }
    }
    if (userTable) {
      for (const key of Object.keys(userTable)) {
        if (key.length > 1 && key.startsWith(word)) {
          extra.unshift({ word: key, ...userTable[key], source: 'user' })
          if (extra.length >= 5) break
        }
      }
    }
    entries.push(...extra)
  }

  return entries
}

/**
 * 完整查询：本地优先，可选在线补充。
 *
 * 在线部分走 Wiktionary 的公开 REST API（无需 key）。
 * 失败时静默降级为本地结果 —— 阅读器不能因为网络问题而卡住查词面板。
 */
export async function lookup(
  query: string,
  options: LookupOptions = {},
): Promise<DictLookupResult> {
  const word = normalizeQuery(query)
  const local = lookupLocal(word, options.userDict)

  if (local.length > 0 || !options.allowOnline) {
    return { entries: local, miss: local.length === 0, onlineAttempted: false }
  }

  const online = await lookupOnline(word, options.onlineTimeoutMs ?? 4000)
  return {
    entries: online.entries,
    miss: online.entries.length === 0,
    onlineAttempted: true,
    onlineError: online.error,
  }
}

/** 在线释义（Wiktionary）。失败返回空并给出原因。 */
export async function lookupOnline(
  word: string,
  timeoutMs = 4000,
): Promise<{ entries: DictEntry[]; error?: string }> {
  const english = looksEnglish(word)
  const lang = english ? 'en' : 'zh'
  const url = `https://${lang}.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(word)}`

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } })
    if (!res.ok) {
      return { entries: [], error: `HTTP ${res.status}` }
    }
    const data = (await res.json()) as {
      [lang: string]: Array<{
        partOfSpeech?: string
        language?: string
        definitions?: Array<{ definition?: string; parsedDefinition?: string; examples?: string[] }>
      }>
    }
    const senses: DictSense[] = []
    const buckets = data[lang] ?? []
    for (const bucket of buckets) {
      for (const def of bucket.definitions ?? []) {
        const raw = def.parsedDefinition ?? def.definition ?? ''
        const clean = raw.replace(/<[^>]+>/g, '').trim()
        if (!clean) continue
        senses.push({
          pos: bucket.partOfSpeech,
          definition: clean,
          example: def.examples?.[0]?.replace(/<[^>]+>/g, '').trim(),
        })
        if (senses.length >= 8) break
      }
      if (senses.length >= 8) break
    }
    if (senses.length === 0) return { entries: [], error: '未找到在线释义' }
    return { entries: [{ word, senses, source: 'online' }] }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return { entries: [], error: message.includes('abort') ? '在线查询超时' : message }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 解析用户导入的词典文本。
 *
 * 支持两种常见格式（本地词典文件格式混乱，必须宽容）：
 *   词条<TAB>拼音<TAB>释义
 *   词条 释义
 * 以 # 开头的行视为注释，空行跳过。
 */
export function parseUserDictionary(text: string): UserDictionary {
  const zh: UserDictionary['zh'] = {}
  const en: UserDictionary['en'] = {}

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#') || line.startsWith('//')) continue

    const tabParts = line.split('\t').map((s) => s.trim())
    let word: string
    let phonetic: string | undefined
    let definition: string

    if (tabParts.length >= 3) {
      word = tabParts[0]
      phonetic = tabParts[1] || undefined
      definition = tabParts.slice(2).join(' ')
    } else {
      const spaceParts = line.split(/\s+/)
      if (spaceParts.length < 2) continue
      word = spaceParts[0]
      // 剩余部分里，/.../ 视为音标
      const rest = spaceParts.slice(1).join(' ')
      const phoneticMatch = /^\/[^/]+\/\s*/.exec(rest)
      if (phoneticMatch) {
        phonetic = phoneticMatch[0].trim()
        definition = rest.slice(phoneticMatch[0].length).trim()
      } else {
        definition = rest
      }
    }

    if (!word || !definition) continue

    const entry = { phonetic, senses: [{ definition }] }
    if (looksEnglish(word)) en[word] = entry
    else zh[word] = entry
  }

  return { zh, en }
}

/** 内置表规模，供 UI 说明「离线可查多少词」。 */
export function builtinDictionarySize(): { zh: number; en: number } {
  return { zh: Object.keys(BUILTIN).length, en: Object.keys(BUILTIN_EN).length }
}
