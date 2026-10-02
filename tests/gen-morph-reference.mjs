/**
 * 生成形变引擎的 JS 参考数据（全点），供 Android 端对照测试使用。
 *
 * 存在的意义：只比「首点坐标」是不够的 —— 各子路径分别插值，
 * 首点对了不代表其余点也对。这里把 **t=0/0.5/1 的全部采样点**导出成 JSON，
 * 让 Kotlin 测试逐点比对，把「两端画出来是同一个形状」变成可执行的检查。
 *
 * 用法：node tests/gen-morph-reference.mjs
 * 产物：test-artifacts/morph-reference.json
 *       Android 端由 MorphParityWithJsTest 读取（测试内以仓库相对路径定位）。
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import puppeteer from 'puppeteer'

const exe = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => existsSync(p))

const OUT_DIR = resolve(process.cwd(), 'test-artifacts')
mkdirSync(OUT_DIR, { recursive: true })

// 与 src/ui/morphIcons.ts 逐条一致。
//
// 注意两端的结构必须**完全对称**：都写成「d 字符串的数组」。
// 曾经把月亮写成裸字符串（因为它的路径只有一条），
// 而 `join()` 对字符串原样返回 —— 于是生成出来的基准里
// 记录的子路径数其实是太阳的，月亮与太阳在对调的位置上被比较。
// 这种「一侧是字符串、一侧是数组」的不对称极难发现，务必保持同构。
const PAIRS = {
  moonToSun: [
    [
      'M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401',
    ],
    [
      'M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0z',
      'M12 2v2',
      'M12 20v2',
      'm4.93 4.93 1.41 1.41',
      'm17.66 17.66 1.41 1.41',
      'M2 12h2',
      'M20 12h2',
      'm6.34 17.66-1.41 1.41',
      'm19.07 4.93-1.41 1.41',
    ],
  ],
  searchToClose: [
    ['m21 21-4.34-4.34', 'M19 11a8 8 0 1 1-16 0 8 8 0 0 1 16 0z'],
    ['M18 6 6 18', 'm6 6 12 12'],
  ],
  bookmarkToCheck: [
    ['M19 5a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v15a1 1 0 0 0 1.496.868l4.512-2.578a2 2 0 0 1 1.984 0l4.512 2.578A1 1 0 0 0 19 20z'],
    [
      'M19 5a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v15a1 1 0 0 0 1.496.868l4.512-2.578a2 2 0 0 1 1.984 0l4.512 2.578A1 1 0 0 0 19 20z',
      'm9 10 2 2 4-4',
    ],
  ],
}

const browser = await puppeteer.launch({ executablePath: exe, headless: 'new', args: ['--no-sandbox'] })
const page = await browser.newPage()
await page.goto('http://127.0.0.1:4173', { waitUntil: 'domcontentloaded' })

const reference = await page.evaluate(async (pairs) => {
  const core = await import('https://esm.sh/morphicons@1.7.1')

  /**
   * 把「d 字符串的数组」合并成单个 d。
   *
   * **刻意对裸字符串抛错**：这个脚本曾经把只有一条子路径的月亮写成字符串，
   * 而那时的 join 会原样返回它 —— 结果基准文件里月亮与太阳被对调比较，
   * 却一路「成功」生成。宁可直接失败，也不要产出看似正常的错误基准。
   */
  const join = (v, where) => {
    if (!Array.isArray(v)) {
      throw new Error(`${where}: 期望「d 字符串的数组」，实际是 ${typeof v}。两端结构必须对称。`)
    }
    return v.join(' ')
  }

  const out = {}

  /** 解析 M/L/Z 折线为点列数组。 */
  const parseD = (d) => {
    const subs = []
    const re = /M(-?[\d.]+) (-?[\d.]+)((?:L-?[\d.]+ -?[\d.]+)*)(Z?)/g
    let m
    while ((m = re.exec(d)) !== null) {
      const pts = [Number(m[1]), Number(m[2])]
      for (const seg of m[3].matchAll(/L(-?[\d.]+) (-?[\d.]+)/g)) {
        pts.push(Number(seg[1]), Number(seg[2]))
      }
      subs.push({ pts, closed: m[4] === 'Z' })
    }
    return subs
  }

  for (const [name, [a, b]] of Object.entries(pairs)) {
    const ra = core.resampleIcon(join(a, `${name}.from`))
    const rb = core.resampleIcon(join(b, `${name}.to`))
    const plan = core.buildPlan(ra, rb)
    const buf = core.allocOutputs(plan)
    const closed = plan.items.map((it) => it.closed)
    const frames = {}
    for (const t of [0, 0.5, 1]) {
      core.interpPolar(plan, t, buf)
      frames[String(t)] = parseD(core.serialize(buf, closed))
    }
    out[name] = {
      fromSubpaths: ra.length,
      toSubpaths: rb.length,
      subpaths: plan.items.length,
      closed,
      samplePoints: ra[0].pts.length / 2,
      /**
       * 原始采样点（未配对、未对齐、未插值）。
       *
       * 单独导出这一层是为了**把排查链条拆开**：
       * 弧转换 → 弧长重采样 → 配对 → 插值，任一步错都表现为「中间帧对不上」，
       * 但修法完全不同。有了这一层就能先确认重采样是否正确，
       * 从而把问题锁定在后半段（或前半段）。
       */
      fromSample: ra.map((s) => ({ pts: Array.from(s.pts), closed: s.closed })),
      toSample: rb.map((s) => ({ pts: Array.from(s.pts), closed: s.closed })),
      frames,
    }
  }
  return out
}, PAIRS)

await browser.close()

const payload = {
  generatedBy: 'morphicons@1.7.1 (reference implementation, run in Chromium)',
  note:
    'Kotlin 端 MorphEngine 的逐点对照基准。容差见 MorphParityWithJsTest：' +
    '两端在弧长参数化上有实现差异（高斯-勒让德积分 vs 折线逼近），' +
    '实测偏差在 0.02 以内。',
  pairs: reference,
}

writeFileSync(resolve(OUT_DIR, 'morph-reference.json'), JSON.stringify(payload, null, 2), 'utf8')

console.log('=== JS 参考数据 ===')
for (const [name, info] of Object.entries(reference)) {
  const t05 = info.frames['0.5']
  const total = t05.reduce((s, x) => s + x.pts.length / 2, 0)
  console.log(
    `  ${name}: 起点子路径 ${info.fromSubpaths} → 终点 ${info.toSubpaths}，` +
      `配对 ${info.subpaths}，每条 ${info.samplePoints} 点，t=0.5 共 ${total} 点`,
  )
  // 配对数为 0 或点数对不上，说明数据结构或图标路径有问题，直接报错
  if (info.subpaths <= 0 || info.samplePoints !== 64) {
    throw new Error(`${name}: 参考数据异常（配对 ${info.subpaths}，每条点数 ${info.samplePoints}）`)
  }
}
console.log(`\n已写出 test-artifacts/morph-reference.json`)
