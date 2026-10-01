/**
 * 正文渲染细节探针。
 *
 * 回答两个只能靠真实 DOM 确认的问题：
 *   1. 章节标题是否**重复显示**（heading 一次 + 正文首段又一次）；
 *   2. 段落首的空白是否残留（会与 CSS 首行缩进叠加成两格）。
 *
 * 做法：进入阅读器后翻到第一个**带标题的章节**（跳过「前言」），
 * 再把每个段落元素的 data-offset 与文本前几字符打印出来 ——
 * 这些是截图无法精确回答的问题（靠肉眼看缩进很容易误判）。
 */

import puppeteer from 'puppeteer'

const BASE_URL = process.argv[2] ?? 'http://127.0.0.1:4173'

const browser = await puppeteer.launch({
  headless: true,
  executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
})
const page = await browser.newPage()
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
await page.goto(BASE_URL, { waitUntil: 'networkidle2' })
await page.waitForSelector('.shelf', { timeout: 15000 })

const waitForCards = async (timeoutMs) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const n = await page.$$eval('.book-card, .book-list-item', (els) => els.length)
    if (n > 0) return n
    await new Promise((r) => setTimeout(r, 400))
  }
  return 0
}

let cardCount = await waitForCards(3000)
if (cardCount === 0) {
  console.log('书库为空，加载示例书…')
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button')).find((b) => (b.textContent ?? '').includes('加载示例书'))
    if (btn instanceof HTMLElement) btn.click()
  })
  cardCount = await waitForCards(20000)
}
console.log(`书架书籍数: ${cardCount}\n`)

// 用封面按钮打开（外层 .book-card 上的 click 不会冒泡到它）
const openTarget = await page.$('.book-card button[aria-label^="打开"], .book-list-item button[aria-label^="打开"]')
await openTarget.click()
await page.waitForSelector('.reader__text', { timeout: 15000 })

/** 采集当前页的渲染细节。 */
const inspect = () =>
  page.evaluate(() => {
    const textEl = document.querySelector('.reader__text')
    if (!textEl) return { error: '找不到 .reader__text' }
    const titleEl = textEl.querySelector('.reader__chapter-title')
    const noEl = textEl.querySelector('.reader__chapter-no')
    const paragraphs = Array.from(textEl.querySelectorAll('p')).map((p) => {
      const raw = p.textContent ?? ''
      return {
        offset: p.getAttribute('data-offset'),
        firstChars: raw.slice(0, 14),
        hasLeadingSpace: /^[\s\u3000]/.test(raw),
        textIndent: getComputedStyle(p).textIndent,
      }
    })
    return {
      chapterNo: noEl ? noEl.textContent : null,
      chapterTitle: titleEl ? titleEl.textContent : null,
      footer: document.querySelector('.reader__footer')?.textContent ?? '',
      paragraphs,
    }
  })

// 打开书后先停在保存的位置。示例书没有任何阅读记录，会从第 0 章（前言）开始，
// 因此先翻到第 1 章（第一个带标题的章节）。
const firstView = await inspect()
console.log('=== 初始页（应为「前言」，无标题）===')
console.log(JSON.stringify(firstView, null, 2))

if (!firstView.chapterTitle) {
  // 用键盘方向键翻页（e2e 已证明该路径可靠；点热区在探针里不稳定，会因为
  // 工具栏/面板的显隐状态而落到错误的元素上）。
  console.log('前言章无标题，用方向键翻到下一个带标题的章节…')
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('ArrowRight')
    await new Promise((r) => setTimeout(r, 700))
    const probe = await page.evaluate(() => ({
      hasTitle: document.querySelector('.reader__chapter-title') !== null,
      footer: document.querySelector('.reader__footer')?.textContent ?? '',
    }))
    if (probe.hasTitle) {
      console.log(`  第 ${i + 1} 次翻页后到达带标题章节: ${probe.footer}`)
      break
    }
  }
}

const titledView = await inspect()
console.log('\n=== 带标题的章节页（关键验证）===')
console.log(JSON.stringify(titledView, null, 2))

// —— 断言 ——
console.log('\n=== 判定 ===')
const title = titledView.chapterTitle
const firstPara = titledView.paragraphs[0]?.firstChars ?? ''
const duplicated = !!title && firstPara.replace(/[\s\u3000]/g, '').startsWith(title.replace(/[\s\u3000]/g, ''))
console.log(`章节标题: ${JSON.stringify(title)}`)
console.log(`首段开头: ${JSON.stringify(firstPara)}`)
console.log(`标题是否重复显示: ${duplicated ? '是（BUG）' : '否（正确）'}`)
const anyLeading = titledView.paragraphs.some((p) => p.hasLeadingSpace)
console.log(`段落首是否残留空白: ${anyLeading ? '是（BUG）' : '否（正确）'}`)

await page.screenshot({ path: 'test-artifacts/probe-带标题章节.png' })
await browser.close()
process.exit(duplicated || anyLeading ? 1 : 0)
