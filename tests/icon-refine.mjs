/**
 * 图标细化：在 B 的方向上试参数（开合角度、墨点有无、页色深浅），
 * 并按真实桌面尺寸（36 / 48 / 72dp）渲染，看哪个缩到最小仍认得出。
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

const CLAY_LIGHT = '#B39270'

/** 开卷书：两页 + 书脊，参数化控制厚度与开合。 */
function openBook(opts) {
  const { leftFill, rightFill, gap = 3, top = 28, bottom = 80, halfW = 26, curve = 8 } = opts
  const cx = 54
  const lx = cx - gap / 2
  const rx = cx + gap / 2
  return [
    // 左页：外缘略低，形成翻卷感
    `<path d="M${lx},${top + 4} C${lx - curve},${top - 2} ${cx - halfW + 6},${top - 4} ${cx - halfW},${top - 4} L${cx - halfW},${bottom - 4} C${cx - halfW + 6},${bottom - 4} ${lx - curve},${bottom - 2} ${lx},${bottom + 4} Z" fill="${leftFill}"/>`,
    // 右页
    `<path d="M${rx},${top + 4} C${rx + curve},${top - 2} ${cx + halfW - 6},${top - 4} ${cx + halfW},${top - 4} L${cx + halfW},${bottom - 4} C${cx + halfW - 6},${bottom - 4} ${rx + curve},${bottom - 2} ${rx},${bottom + 4} Z" fill="${rightFill}"/>`,
  ].join('')
}

const variants = [
  { name: 'B1 墨+焦糖', body: openBook({ leftFill: INK, rightFill: CLAY }) },
  { name: 'B2 墨+浅焦糖', body: openBook({ leftFill: INK, rightFill: CLAY_LIGHT }) },
  {
    name: 'B3 纯墨（用于主题图标）',
    body: openBook({ leftFill: INK, rightFill: INK, gap: 5 }),
  },
  {
    name: 'B4 墨+焦糖+墨点',
    body:
      openBook({ leftFill: INK, rightFill: CLAY }) +
      `<circle cx="54" cy="54" r="5.5" fill="${PAPER}"/>`,
  },
  {
    name: 'B5 三页/书页分层',
    body:
      openBook({ leftFill: INK, rightFill: CLAY_LIGHT }) +
      `<path d="M${54 - 13},44 L${54 - 4},44 M${54 + 4},44 L${54 + 13},44" stroke="${PAPER}" stroke-width="3" stroke-linecap="round"/>`,
  },
  {
    name: 'B6 更宽开合',
    body: openBook({ leftFill: INK, rightFill: CLAY_LIGHT, halfW: 32, curve: 12, top: 30, bottom: 78 }),
  },
]

function svgFor(body) {
  return `<svg viewBox="0 0 108 108" xmlns="http://www.w3.org/2000/svg">
    <rect width="108" height="108" fill="${PAPER}"/>${body}</svg>`
}

const html = `<!doctype html><meta charset="utf-8">
<style>
  body { margin:0; padding:20px; background:#e8e2d6; font-family: system-ui, "Microsoft YaHei", sans-serif; }
  .row { display:flex; gap:26px; align-items:flex-start; flex-wrap:wrap; }
  .item { text-align:center; }
  .sizes { display:flex; align-items:flex-end; gap:10px; margin-bottom:8px; }
  .icon { overflow:hidden; box-shadow:0 2px 8px rgba(0,0,0,.16); }
  .lbl { font-size:10px; color:#6a6459; }
  .label { font-size:12px; color:#3a352d; margin-top:6px; width:150px; line-height:1.3; }
</style>
<div class="row">
${variants
  .map((v) => {
    const svg = svgFor(v.body)
    const mk = (px, r) => `<div><div class="icon" style="width:${px}px;height:${px}px;border-radius:${r}px">${svg}</div><div class="lbl">${px}</div></div>`
    return `<div class="item">
      <div class="sizes">${mk(72, 16)}${mk(48, 11)}${mk(36, 8)}</div>
      <div class="label">${v.name}</div>
    </div>`
  })
  .join('')}
</div>`

const browser = await puppeteer.launch({ executablePath: exe, headless: 'new', args: ['--no-sandbox'] })
const page = await browser.newPage()
await page.setViewport({ width: 1100, height: 300, deviceScaleFactor: 4 })
await page.setContent(html, { waitUntil: 'load' })
await new Promise((r) => setTimeout(r, 500))
await page.screenshot({ path: resolve(OUT, 'icon-refined.png') })
console.log('已保存 test-artifacts/icon-refined.png')
await browser.close()
