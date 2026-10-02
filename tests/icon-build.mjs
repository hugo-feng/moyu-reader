/**
 * 应用图标生成。
 *
 * 设计：一本摊开的书 —— 左页墨色、右页焦糖，纸感底。
 * 为什么是这个方向而不是细线描边：
 *   桌面图标实际只有 36–48dp，细线在这个尺寸会糊成一团。
 *   实心色块 + 两页对比，缩到 36dp 仍然一眼认得出「书」。
 * 单色层（澎湃 OS / Android 13+ 主题图标会用它重新着色）必须是**纯形状**，
 *   因此另外生成一个两页同色、带书脊缺口的版本。
 *
 * 关键：矢量（XML）与位图（PNG）必须来自同一份几何参数，
 * 否则系统用矢量做主题着色、用位图做普通显示时，两者形状会不一致。
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import puppeteer from 'puppeteer'

const exe = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => existsSync(p))

const RES = resolve('D:/work/android/app/src/main/res')
const OUT = resolve(process.cwd(), 'test-artifacts')
mkdirSync(OUT, { recursive: true })

const PAPER = '#F7F3EA'
const INK = '#33302B'
const CLAY = '#9C7A52'

/**
 * 开卷书的几何（108×108 画布，与自适应图标的前景层同坐标系）。
 *
 * 自适应图标的前景会被系统按蒙版裁切：安全区是中心 66dp（约 18–90），
 * 因此图形必须落在这个范围内，否则圆形/水滴形蒙版会切掉书角。
 */
const GEO = {
  top: 30,
  bottom: 78,
  halfW: 32,
  gap: 3,
  curve: 12,
}

/** 生成一页的 path。左页向右开口、右页向左开口，合起来是摊开的书。 */
function pagePath(side, gapPx) {
  const { top, bottom, halfW, curve } = GEO
  const cx = 54
  const inner = side === 'left' ? cx - gapPx / 2 : cx + gapPx / 2
  const outer = side === 'left' ? cx - halfW : cx + halfW
  const dir = side === 'left' ? -1 : 1
  // 外缘比内缘低一点，形成书页自然下垂的弧度
  return (
    `M${inner},${top + 4} ` +
    `C${inner + dir * curve},${top - 2} ${outer - dir * 6},${top - 4} ${outer},${top - 4} ` +
    `L${outer},${bottom - 4} ` +
    `C${outer - dir * 6},${bottom - 4} ${inner + dir * curve},${bottom - 2} ${inner},${bottom + 4} Z`
  )
}

const leftPath = pagePath('left', GEO.gap)
const rightPath = pagePath('right', GEO.gap)
// 单色版把书脊缺口加宽，让两页在纯色下也能分辨
const leftPathMono = pagePath('left', 7)
const rightPathMono = pagePath('right', 7)

/** 彩色前景（普通图标） */
const FOREGROUND_XML = `<?xml version="1.0" encoding="utf-8"?>
<!--
  应用图标前景：一本摊开的书（左页墨色、右页焦糖）。
  自适应图标的前景层会被系统按蒙版裁切，图形全部落在中心安全区内（约 18–90）。
  为什么用实心色块而不是描边：桌面图标实际只有 36–48dp，
  细线在那个尺寸会糊；色块缩到 36dp 仍然一眼认得出是「书」。
-->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="108"
    android:viewportHeight="108">

    <!-- 左页 -->
    <path
        android:fillColor="${INK}"
        android:pathData="${leftPath}" />

    <!-- 右页 -->
    <path
        android:fillColor="${CLAY}"
        android:pathData="${rightPath}" />
</vector>
`

/** 单色层：Android 13+ / 澎湃 OS 的主题图标会用自己的颜色重绘这一层 */
const MONOCHROME_XML = `<?xml version="1.0" encoding="utf-8"?>
<!--
  单色层：主题图标（Android 13+ / 澎湃 OS）会忽略这里的颜色，
  用系统取色重新填充整个形状，因此这一层必须是**纯剪影**。
  书脊缺口特意加宽，否则两页会被填成一整块、看不出是书。
-->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="108"
    android:viewportHeight="108">

    <path
        android:fillColor="#000000"
        android:pathData="${leftPathMono}" />
    <path
        android:fillColor="#000000"
        android:pathData="${rightPathMono}" />
</vector>
`

function svg(colorLeft, colorRight, pathL, pathR, bg) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="108" height="108" viewBox="0 0 108 108">
    <rect width="108" height="108" fill="${bg}"/>
    <path d="${pathL}" fill="${colorLeft}"/>
    <path d="${pathR}" fill="${colorRight}"/>
  </svg>`
}

const COLOR_SVG = svg(INK, CLAY, leftPath, rightPath, PAPER)

/**
 * 位图尺寸。
 * 自适应图标的前景层是 108dp 画布，各密度下的像素尺寸如下；
 * 旧版启动图标（ic_launcher.png）按 48dp 的常规尺寸生成。
 */
const DENSITIES = [
  { dir: 'mipmap-mdpi', scale: 1 },
  { dir: 'mipmap-hdpi', scale: 1.5 },
  { dir: 'mipmap-xhdpi', scale: 2 },
  { dir: 'mipmap-xxhdpi', scale: 3 },
  { dir: 'mipmap-xxxhdpi', scale: 4 },
]

writeFileSync(resolve(RES, 'drawable/ic_launcher_foreground.xml'), FOREGROUND_XML)
writeFileSync(resolve(RES, 'drawable/ic_launcher_monochrome.xml'), MONOCHROME_XML)
console.log('已写入矢量前景与单色层')

const browser = await puppeteer.launch({ executablePath: exe, headless: 'new', args: ['--no-sandbox'] })
const page = await browser.newPage()

async function renderPng(svgMarkup, px, outPath) {
  await page.setViewport({ width: px, height: px, deviceScaleFactor: 1 })
  await page.setContent(
    `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:transparent}
     svg{display:block;width:${px}px;height:${px}px}</style>${svgMarkup.replace(
       'width="108" height="108"',
       `width="${px}" height="${px}"`,
     )}`,
    { waitUntil: 'load' },
  )
  await page.screenshot({ path: outPath, omitBackground: true })
}

for (const { dir, scale } of DENSITIES) {
  const target = resolve(RES, dir)
  mkdirSync(target, { recursive: true })

  // 自适应图标前景层：108dp 画布
  const fgPx = Math.round(108 * scale)
  await renderPng(COLOR_SVG, fgPx, resolve(target, 'ic_launcher_foreground.png'))

  // 旧版方形 / 圆形启动图标：48dp
  const legacyPx = Math.round(48 * scale)
  await renderPng(COLOR_SVG, legacyPx, resolve(target, 'ic_launcher.png'))
  await renderPng(COLOR_SVG, legacyPx, resolve(target, 'ic_launcher_round.png'))

  console.log(`  ${dir}: 前景 ${fgPx}px / 启动图标 ${legacyPx}px`)
}

// —— 预览图：把最终图标按真实尺寸排出来，供人眼确认 ——
await page.setViewport({ width: 640, height: 260, deviceScaleFactor: 4 })
await page.setContent(
  `<!doctype html><meta charset="utf-8"><style>
     body{margin:0;padding:24px;background:#e8e2d6;font-family:system-ui,"Microsoft YaHei",sans-serif}
     .row{display:flex;gap:20px;align-items:flex-end}
     .icon{overflow:hidden;box-shadow:0 2px 10px rgba(0,0,0,.18)}
     .lbl{font-size:11px;color:#6a6459;text-align:center;margin-top:5px}
     .mono{background:#2b2b30}
   </style>
   <div class="row">
     ${[
       { px: 144, r: 32, label: '144 应用商店' },
       { px: 72, r: 16, label: '72 设置页' },
       { px: 48, r: 11, label: '48 桌面' },
       { px: 36, r: 8, label: '36 小图标' },
     ]
       .map(
         (s) =>
           `<div><div class="icon" style="width:${s.px}px;height:${s.px}px;border-radius:${s.r}px">${COLOR_SVG.replace(
             'width="108" height="108"',
             `width="${s.px}" height="${s.px}"`,
           )}</div><div class="lbl">${s.label}</div></div>`,
       )
       .join('')}
     <div><div class="icon mono" style="width:72px;height:72px;border-radius:16px">${svg(
       '#e8e2d6',
       '#e8e2d6',
       leftPathMono,
       rightPathMono,
       '#2b2b30',
     ).replace('width="108" height="108"', 'width="72" height="72"')}</div><div class="lbl">主题图标</div></div>
   </div>`,
  { waitUntil: 'load' },
)
await new Promise((r) => setTimeout(r, 400))
await page.screenshot({ path: resolve(OUT, 'icon-final.png') })
console.log('已保存 test-artifacts/icon-final.png')

await browser.close()
