/**
 * 截图脚本：把关键界面拍成图片，供人眼复核排版。
 *
 * 与 e2e.mjs 的分工：e2e 负责"功能是否可用"的断言，本脚本只负责"看起来对不对"。
 * 因此它不做断言，只走一遍路径并把每一屏存成 PNG。
 */

import { existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = resolve(here, '..', 'test-artifacts', 'shots')
mkdirSync(outDir, { recursive: true })

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:4173'

/** 找一个真实存在的浏览器：优先 Edge（Windows 自带），其次 Chrome。 */
function resolveBrowser() {
  const candidates = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ]
  return candidates.find((p) => existsSync(p))
}

const exe = resolveBrowser()
if (!exe) {
  console.error('找不到 Edge / Chrome，无法截图')
  process.exit(1)
}

const browser = await puppeteer.launch({
  executablePath: exe,
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none'],
})

const page = await browser.newPage()
// iPhone 14 Pro 逻辑分辨率 —— 与真机观感一致
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 })

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
let n = 0
async function shot(name) {
  n += 1
  const file = resolve(outDir, `${String(n).padStart(2, '0')}-${name}.png`)
  await page.screenshot({ path: file })
  console.log(`  已保存 ${file.replace(resolve(here, '..'), '.')}`)
}

async function clickAria(label) {
  const ok = await page.evaluate((l) => {
    const hit = [...document.querySelectorAll('button,[role="button"]')].find(
      (el) => (el.getAttribute('aria-label') ?? '').includes(l),
    )
    if (hit) {
      hit.click()
      return true
    }
    return false
  }, label)
  if (!ok) console.warn(`  [警告] 找不到 aria-label 含「${label}」的元素`)
  return ok
}

async function clickText(text) {
  const ok = await page.evaluate((t) => {
    const hit = [...document.querySelectorAll('button,[role="button"]')].find((el) =>
      (el.textContent ?? '').includes(t),
    )
    if (hit) {
      hit.click()
      return true
    }
    return false
  }, text)
  if (!ok) console.warn(`  [警告] 找不到文本含「${text}」的元素`)
  return ok
}

/** 等待某个选择器出现，避免脚本在渲染完成前就点下去。 */
async function waitFor(selector, timeout = 8000) {
  try {
    await page.waitForSelector(selector, { timeout })
    return true
  } catch {
    return false
  }
}

console.log(`\n=== 墨阅 · 界面截图 (${BASE}) ===\n`)
await page.goto(BASE, { waitUntil: 'networkidle2' })
await page.waitForSelector('.app', { timeout: 15000 })
await wait(900)

// 0. 空书架（首次运行才有意义，已有数据时也照拍，不视为错误）
if ((await page.$('.empty')) !== null) await shot('书架-空态')

// 加载示例书，否则后面每一步都会停在空书架上
if ((await page.$('.empty')) !== null) {
  await clickText('加载示例书')
  await wait(2200)
}

// 1. 有书的书架
await shot('书架')

// 2. 书内：打开示例书
await page.evaluate(() => {
  const card = document.querySelector('.book-card')
  if (card) card.click()
})
await waitFor('.reader__text')
await wait(1400)
await shot('阅读页-章首页')

// 3. 翻到次页，检查书眉与页码
if (await waitFor('.reader__zones button:last-child', 4000)) {
  await page.click('.reader__zones button:last-child')
  await wait(900)
  await shot('阅读页-次页含书眉')
}

// 4. 呼出工具栏
// 注意：中间热区只在工具栏**隐藏**时才把它打开。若它已经可见，再点一次会把它关掉，
// 所以这里必须先判断状态，不能盲目点。
async function chromeVisible() {
  return page.$$eval('.reader__chrome', (els) => els.some((e) => !e.className.includes('--hidden')))
}
async function openChrome() {
  if (await chromeVisible()) return true
  if (!(await waitFor('.reader__zones button.reader__zone--mid', 4000))) return false
  await page.click('.reader__zones button.reader__zone--mid')
  await wait(800)
  return chromeVisible()
}

await openChrome()
await shot('阅读页-工具栏')

// 5. 目录（点工具栏里同一个按钮收回，比找关闭按钮可靠）
await clickAria('目录')
await wait(900)
await shot('目录面板')
await clickAria('目录')
await wait(700)

// 6. 排版面板
await openChrome()
await clickAria('排版')
await wait(900)
await shot('排版面板')
await clickAria('排版')
await wait(700)

// 7. 返回书架 → 统计页
await clickAria('返回书架')
await wait(800)
if ((await page.$('.book-card')) === null) {
  await page.goto(BASE, { waitUntil: 'networkidle2' })
  await wait(900)
}
await clickAria('统计')
await wait(1400)
await shot('阅读统计')

// 8. 笔记页
await clickAria('返回')
await wait(700)
await clickAria('笔记')
await wait(1200)
await shot('笔记页')

// 9. 设置页
await clickAria('返回')
await wait(700)
await clickAria('设置')
await wait(1200)
await shot('设置页')

// 10. 导入页
await clickAria('返回')
await wait(700)
await clickAria('导入')
await wait(1000)
await shot('导入页')

await browser.close()
console.log(`\n共 ${n} 张，目录：test-artifacts/shots\n`)
