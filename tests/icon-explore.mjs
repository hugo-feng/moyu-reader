/**
 * 图标设计探索：把几个候选字标并排渲染出来看效果。
 *
 * 目的：图标这种东西必须看，不能靠描述决定。
 * 这里同时渲染 512px（应用商店/设置页大小）和 48px（桌面实际大小），
 * 因为「好看」的标准在这两个尺寸下完全不同 —— 细线在大图优雅、在小图就糊了。
 */
import { existsSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import puppeteer from 'puppeteer'

const exe = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => existsSync(p))

const OUT = resolve(process.cwd(), 'test-artifacts')
mkdirSync(OUT, { recursive: true })

const PAPER = '#F7F3EA'
const INK = '#33302B'
const CLAY = '#8A6A46'

/** 一个候选：名字 + 在 108 视图里的 path 列表（前景层）。 */
const candidates = [
  {
    name: 'A 开卷（书脊+双页+墨点）· 现版',
    paths: [
      { d: 'M54,34 L54,76', stroke: CLAY, w: 3 },
      { d: 'M54,36 C48,31.5 40.5,30 33,29.6 L33,72 C40.5,72.4 48,73.9 54,78.4 Z', fill: '#EFE6D6', stroke: CLAY, w: 3 },
      { d: 'M54,36 C60,31.5 67.5,30 75,29.6 L75,72 C67.5,72.4 60,73.9 54,78.4 Z', fill: '#EFE6D6', stroke: CLAY, w: 3 },
      { d: 'M54,52 m-4,0 a4,4 0 1,0 8,0 a4,4 0 1,0 -8,0', fill: INK },
    ],
  },
  {
    name: 'B 开卷·加粗实心',
    paths: [
      { d: 'M54,30 L54,78', stroke: INK, w: 0, fill: INK, rect: [51, 30, 6, 48] },
      { d: 'M51,33 C44,28 36,26.5 28,26 L28,72 C36,72.5 44,74 51,79 Z', fill: INK },
      { d: 'M57,33 C64,28 72,26.5 80,26 L80,72 C72,72.5 64,74 57,79 Z', fill: CLAY },
    ],
  },
  {
    name: 'C 单页折角书',
    paths: [
      { d: 'M30,26 L66,26 L80,40 L80,82 L30,82 Z', fill: INK },
      { d: 'M66,26 L80,40 L66,40 Z', fill: PAPER },
      { d: 'M40,52 L70,52 M40,63 L70,63', stroke: PAPER, w: 4 },
    ],
  },
  {
    name: 'D 墨阅字标「墨」',
    text: '墨',
  },
  {
    name: 'E 竖排双字「墨阅」',
    text: '墨阅',
  },
  {
    name: 'F 开卷·负空间',
    paths: [
      { d: 'M54,30 C44,24 32,22 22,22 L22,84 C32,84 44,86 54,92 C64,86 76,84 86,84 L86,22 C76,22 64,24 54,30 Z', fill: INK },
      { d: 'M54,38 L54,84', stroke: PAPER, w: 4 },
      { d: 'M32,40 C40,40 46,41.5 50,44 L50,78 C46,75.5 40,74 32,74 Z', fill: PAPER },
    ],
  },
]

const html = `<!doctype html><meta charset="utf-8">
<style>
  body { margin:0; padding:20px; background:#e8e2d6; font-family: system-ui, "Microsoft YaHei", sans-serif; }
  .row { display:flex; gap:22px; align-items:flex-end; flex-wrap:wrap; }
  .item { text-align:center; }
  .big { width:128px; height:128px; border-radius:29px; overflow:hidden; box-shadow:0 3px 12px rgba(0,0,0,.18); }
  .small { width:48px; height:48px; border-radius:11px; overflow:hidden; margin-top:8px; box-shadow:0 1px 4px rgba(0,0,0,.18); }
  .label { font-size:11px; color:#4a453d; margin-top:6px; width:132px; line-height:1.3; }
  svg { display:block; }
</style>
<div class="row">
${candidates
  .map((c) => {
    const body = c.text
      ? `<text x="54" y="54" text-anchor="middle" dominant-baseline="central"
             font-size="${c.text.length > 1 ? 46 : 64}" font-weight="700" fill="${INK}"
             font-family="'Songti SC','SimSun',serif">${c.text}</text>`
      : c.paths
          .map((p) => {
            if (p.rect) {
              return `<rect x="${p.rect[0]}" y="${p.rect[1]}" width="${p.rect[2]}" height="${p.rect[3]}" fill="${p.fill}"/>`
            }
            return `<path d="${p.d}" fill="${p.fill ?? 'none'}" stroke="${p.stroke ?? 'none'}" stroke-width="${p.w ?? 0}" stroke-linecap="round" stroke-linejoin="round"/>`
          })
          .join('')
    const svg = `<svg viewBox="0 0 108 108" xmlns="http://www.w3.org/2000/svg">
        <rect width="108" height="108" fill="${PAPER}"/>${body}</svg>`
    return `<div class="item">
      <div class="big">${svg}</div>
      <div class="small">${svg}</div>
      <div class="label">${c.name}</div>
    </div>`
  })
  .join('')}
</div>`

const browser = await puppeteer.launch({ executablePath: exe, headless: 'new', args: ['--no-sandbox'] })
const page = await browser.newPage()
await page.setViewport({ width: 1100, height: 420, deviceScaleFactor: 2 })
await page.setContent(html, { waitUntil: 'load' })
await new Promise((r) => setTimeout(r, 500))
await page.screenshot({ path: resolve(OUT, 'icon-candidates.png') })
console.log('已保存 test-artifacts/icon-candidates.png')
await browser.close()
