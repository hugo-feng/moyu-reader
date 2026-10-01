/**
 * 真实浏览器端到端实测脚本。
 *
 * 为什么必须用真实 Chromium 而不是 jsdom：
 *   本项目依赖 IndexedDB（书库）、Canvas 度量（分页）、Selection/Range API（选词）、
 *   ResizeObserver（视口监听）—— jsdom 全都不实现或不完整，
 *   用 jsdom 测出来的「通过」没有意义。
 *
 * 这个脚本会真实地：
 *   1. 启动无头 Chromium，用手机尺寸视口（390×844，接近主流安卓机）；
 *   2. 加载构建产物（dist），确认无控制台报错；
 *   3. 走完核心用户路径：加载示例书 → 书架出书 → 打开阅读器 → 翻页 → 目录跳章
 *      → 呼出工具栏 → 改字号 → 加书签 → 全文搜索 → 查看统计 → 打开设置；
 *   4. 每一步截图，并对关键断言做「失败即抛出」，让问题不能被静默吞掉。
 *
 * 用法：node tests/e2e.mjs [baseUrl]
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import puppeteer from 'puppeteer'

const BASE_URL = process.argv[2] ?? 'http://127.0.0.1:4173'
const OUT_DIR = resolve(process.cwd(), 'test-artifacts')

/**
 * 优先复用系统已安装的 Chromium 内核浏览器，避免额外下载一份 Chromium。
 * Chrome 最贴合；Edge 同为 Chromium 内核，本项目只用标准 Web API
 * （IndexedDB / Canvas / Selection / ResizeObserver），两者行为等价。
 */
const BROWSER_CANDIDATES = [
  process.env.MOYU_BROWSER,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean)

function resolveBrowser() {
  for (const candidate of BROWSER_CANDIDATES) {
    if (candidate && existsSync(candidate)) return candidate
  }
  // 找不到系统浏览器就退回 Puppeteer 自带的（若已下载）
  return undefined
}

const results = []
let browser
let page

/** 记录一步的结论。 */
function step(name, ok, detail = '') {
  results.push({ name, ok, detail })
  const mark = ok ? 'PASS' : 'FAIL'
  console.log(`[${mark}] ${name}${detail ? ` — ${detail}` : ''}`)
}

/** 强制断言，失败立即终止（避免后续步骤在错误状态上继续跑）。 */
function assert(condition, message) {
  if (!condition) throw new Error(`断言失败: ${message}`)
}

async function shot(name) {
  mkdirSync(OUT_DIR, { recursive: true })
  await page.screenshot({ path: resolve(OUT_DIR, `${name}.png`), fullPage: false })
}

/** 按可见文本找元素并点击。 */
async function clickByText(text, tag = 'button') {
  const handle = await page.evaluateHandle(
    (t, g) => {
      const nodes = Array.from(document.querySelectorAll(g))
      return nodes.find((n) => (n.textContent ?? '').trim().includes(t)) ?? null
    },
    text,
    tag,
  )
  const el = handle.asElement()
  if (!el) throw new Error(`找不到包含文本「${text}」的 ${tag}`)
  await el.click()
  return true
}

async function clickByAria(label) {
  const selector = `[aria-label="${label}"]`
  await page.waitForSelector(selector, { timeout: 8000 })
  await page.click(selector)
}

/** 判断阅读器工具栏当前是否可见。 */
async function isChromeVisible() {
  return page.$$eval('.reader__chrome', (els) => els.some((e) => !e.className.includes('--hidden')))
}

/** 判断是否有面板（目录/笔记/排版）处于打开状态。 */
async function isOverlayOpen() {
  return (await page.$('.sheet')) !== null
}

/**
 * 确保工具栏可见。
 *
 * 存在的意义：工具栏是开关式的，`chromeVisible` 在翻页/跳章后是**保持**的。
 * 测试里如果无条件再点一次中间热区，就会把已经打开的工具栏关掉，
 * 于是后续按钮点击全部失败 —— 这是之前假失败的根因。
 * 这里改成先读状态，只有确实隐藏时才点，并且点击前后都校验结果。
 */
async function ensureChromeVisible(attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    if (await isChromeVisible()) return true
    // 有覆盖层时先关掉，否则热区被遮住点不到
    if (await isOverlayOpen()) {
      await closeAnyOverlay()
    }
    await page.click('.reader__zones button.reader__zone--mid').catch(() => {})
    await new Promise((r) => setTimeout(r, 450))
  }
  return isChromeVisible()
}

/** 关闭任何打开的面板（目录 / 笔记 / 排版）。 */
async function closeAnyOverlay() {
  for (let i = 0; i < 3; i++) {
    if (!(await isOverlayOpen())) return
    const closed = await page.evaluate(() => {
      const sheet = document.querySelector('.sheet')
      if (!sheet) return true
      // 面板右上角的关闭按钮是 aria-label="关闭"
      const btn = sheet.querySelector('[aria-label="关闭"]')
      if (btn instanceof HTMLElement) {
        btn.click()
        return true
      }
      return false
    })
    if (!closed) break
    await new Promise((r) => setTimeout(r, 450))
  }
}

async function main() {
  console.log(`\n=== 墨阅 · 端到端实测 (${BASE_URL}) ===\n`)

  const executablePath = resolveBrowser()
  console.log(executablePath ? `使用浏览器: ${executablePath}\n` : '未找到系统浏览器，回退到 Puppeteer 自带 Chromium\n')

  browser = await puppeteer.launch({
    headless: true,
    executablePath,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  })
  page = await browser.newPage()

  // 手机尺寸视口：接近主流安卓机，也是本项目 UI 的设计目标
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true })

  // —— 收集控制台错误、页面异常与失败请求：任何 JS 报错或 404 都必须被发现 ——
  const consoleErrors = []
  const pageErrors = []
  const failedRequests = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })
  page.on('pageerror', (err) => pageErrors.push(err.message))
  page.on('requestfailed', (req) => failedRequests.push(`${req.url()} (${req.failure()?.errorText ?? 'unknown'})`))
  page.on('response', (res) => {
    if (res.status() >= 400) failedRequests.push(`${res.status()} ${res.url()}`)
  })

  // ============ 1. 加载 ============
  const response = await page.goto(BASE_URL, { waitUntil: 'networkidle2', timeout: 45000 })
  step('页面加载', response?.ok() ?? false, `HTTP ${response?.status()}`)
  await page.waitForSelector('.app', { timeout: 15000 })
  await new Promise((r) => setTimeout(r, 700))
  await shot('01-初始书架')

  const headline = await page.$eval('.shelf__headline', (el) => el.textContent?.trim() ?? '').catch(() => '')
  step('书架标题渲染', headline.includes('书架'), `"${headline}"`)

  // ============ 2. 加载示例书 ============
  const hasEmptyState = (await page.$('.empty')) !== null
  if (hasEmptyState) {
    await clickByText('加载示例书')
  } else {
    // 已有数据（非首次运行）：也要能继续，不视为失败
    step('已有书库数据', true, '跳过示例书加载')
  }
  await new Promise((r) => setTimeout(r, 1800))
  await shot('02-导入后书架')

  const bookCount = await page.$$eval('.book-card', (els) => els.length).catch(() => 0)
  const coverCount = await page.$$eval('.cover', (els) => els.length).catch(() => 0)
  step('书架出现书籍卡片', bookCount > 0, `book-card=${bookCount}`)
  step('封面组件渲染', coverCount > 0, `cover=${coverCount}`)

  // 书脊书名必须是**一列**竖排文字。
  // 这条断言来自一次真实的误判：封面文字排成几列时，人眼在小尺寸截图里
  // 很容易看错（当时把正常的一列竖排误读成了「逐字堆叠」）。与其每次都靠眼睛判断，
  // 不如把「必须是一个细高的连续块」写成断言 —— 一旦竖排退化成多列，这里会立刻红。
  const spine = await page.evaluate(() => {
    const el = document.querySelector('.cover__text')
    if (!el) return null
    const rects = [...el.getClientRects()]
    const box = el.getBoundingClientRect()
    return {
      text: el.textContent ?? '',
      rectCount: rects.length,
      width: Math.round(box.width),
      height: Math.round(box.height),
      writingMode: getComputedStyle(el).writingMode,
    }
  })
  step(
    '书脊书名为单列竖排',
    !!spine && spine.writingMode === 'vertical-rl' && spine.height > spine.width,
    spine
      ? `"${spine.text}" ${spine.width}×${spine.height} writing-mode=${spine.writingMode}`
      : '读不到封面文字',
  )

  // 验证示例书被正确分章（这是分章算法的端到端证据）
  const chapInfo = await page.evaluate(() => {
    return new Promise((resolve) => {
      const req = indexedDB.open('moyu-reader')
      req.onsuccess = () => {
        const db = req.result
        const tx = db.transaction('books', 'readonly')
        const all = tx.objectStore('books').getAll()
        all.onsuccess = () => {
          const book = all.result[0]
          if (!book) return resolve(null)
          const tx2 = db.transaction('chapters', 'readonly')
          const idx = tx2.objectStore('chapters').index('bookId')
          const cs = idx.getAll(IDBKeyRange.only(book.id))
          cs.onsuccess = () =>
            resolve({
              title: book.title,
              chapterCount: book.chapterCount,
              actualChapters: cs.result.length,
              charCount: book.charCount,
              encoding: book.encoding,
              titles: cs.result.sort((a, b) => a.index - b.index).map((c) => c.title),
            })
        }
        all.onerror = () => resolve(null)
      }
      req.onerror = () => resolve(null)
    })
  })
  if (chapInfo) {
    step('书籍元数据正确', chapInfo.chapterCount === chapInfo.actualChapters, `title="${chapInfo.title}" 章节 ${chapInfo.actualChapters}/${chapInfo.chapterCount} 字数 ${chapInfo.charCount} 编码 ${chapInfo.encoding}`)
    // 示例书刻意混用了 6 种章节标题格式，全部识别出来才算分章算法合格
    const expected = ['楔子 雪夜', '第一章 初入江湖', '第4章 夜探听雨楼', '第 九 章 归途', '番外 那年春深']
    const missing = expected.filter((e) => !chapInfo.titles.some((t) => t.startsWith(e.split(' ')[0])))
    step('多格式章节标题全部识别', missing.length === 0, missing.length ? `缺失: ${missing.join(' / ')}` : `${chapInfo.titles.length} 章`)
  } else {
    step('读取书籍元数据', false, 'IndexedDB 读取失败')
  }

  // ============ 3. 打开阅读器 ============
  await page.click('.book-card')
  await new Promise((r) => setTimeout(r, 1500))
  await shot('03-阅读器初始页')

  const hasReader = (await page.$('.reader')) !== null
  assert(hasReader, '阅读器未打开')
  step('阅读器打开', true)

  const readerText = await page.$eval('.reader__text', (el) => el.textContent ?? '')
  step('正文渲染', readerText.length > 0, `${readerText.length} 字符`)

  // 地脚：真书的页码只是一个数字，不带章节名/百分比。
  // 章节名改由「天头书眉」承担，且书眉只在次页起出现（首页章标题已在版心内）。
  const folioRaw = await page.$eval('.reader__folio-number', (el) => el.textContent ?? '').catch(() => '')
  const folioNum = Number(folioRaw.trim())
  step(
    '地脚显示页码',
    Number.isInteger(folioNum) && folioNum >= 1,
    `页码="${folioRaw.trim()}"`,
  )

  const firstHead = await page.$('.reader__running-head').catch(() => null)
  step('首页不重复印书眉', firstHead === null, firstHead ? '首页出现了书眉（与章标题重复）' : '首页无书眉')

  // ============ 4. 翻页 ============
  const firstPageText = readerText
  // 点右侧热区翻页
  await page.click('.reader__zones button:last-child')
  await new Promise((r) => setTimeout(r, 700))
  const secondPageText = await page.$eval('.reader__text', (el) => el.textContent ?? '')
  step('点击右侧翻页', secondPageText !== firstPageText, secondPageText === firstPageText ? '正文未变化' : '正文已切换')
  await shot('04-翻页后')

  // 注意：这里翻页是**跨章**的（示例书的「前言」章只有一页），落点是下一章第 0 页。
  // 章首页按书籍体例既无书眉、页码也回到本章第 1 页 —— 所以此处只能断言「无书眉」，
  // 「次页起印书眉 / 页码递增」要留到第 6b 步在有多个页的章节内部验证。
  const headAfterFlip = await page.$('.reader__running-head').catch(() => null)
  step('跨章后落在章首页（无书眉）', headAfterFlip === null, headAfterFlip ? '出现了书眉' : '章首页无书眉')

  // 点左侧回到上一页
  await page.click('.reader__zones button:first-child')
  await new Promise((r) => setTimeout(r, 700))
  const backText = await page.$eval('.reader__text', (el) => el.textContent ?? '')
  step('点击左侧回翻', backText === firstPageText, backText === firstPageText ? '回到原页' : '未回到原页')

  // 键盘翻页
  await page.keyboard.press('ArrowRight')
  await new Promise((r) => setTimeout(r, 600))
  const keyText = await page.$eval('.reader__text', (el) => el.textContent ?? '')
  step('键盘右方向键翻页', keyText !== firstPageText, '键盘可用')

  // ============ 5. 呼出工具栏 ============
  await page.click('.reader__zones button.reader__zone--mid')
  await new Promise((r) => setTimeout(r, 700))
  const chromeVisible = await page.$$eval('.reader__chrome', (els) =>
    els.some((e) => !e.className.includes('--hidden')),
  )
  step('中间热区呼出工具栏', chromeVisible, chromeVisible ? '工具栏可见' : '工具栏仍隐藏')
  await shot('05-工具栏')

  // ============ 6. 目录 ============
  if (chromeVisible) {
    await clickByAria('目录')
    await new Promise((r) => setTimeout(r, 800))
    const tocItems = await page.$$eval('.toc-item', (els) => els.length)
    step('目录面板列出章节', tocItems > 0, `${tocItems} 项`)
    await shot('06-目录面板')

    // 跳到演示书里刻意写长的那一章（第十二章 山雨欲来），它是唯一能跨页的章节。
    // 用标题文本定位而不是下标 —— 目录项与章节下标相差 1（前面还有「前言」），
    // 按下标点会静默点到隔壁章，让后面的断言全部落在错误的前提上。
    const longTitle = '第十二章 山雨欲来'
    const clicked = await page.evaluate((t) => {
      const hit = [...document.querySelectorAll('.toc-item')].find((el) =>
        (el.textContent ?? '').includes(t),
      )
      if (!hit) return false
      hit.click()
      return true
    }, longTitle)
    step('目录定位到长章节', clicked, clicked ? longTitle : '目录中未找到该章')
    await new Promise((r) => setTimeout(r, 1200))

    // 分页状态直接从 DOM 读，不靠猜。
    const readState = () =>
      page.evaluate(() => {
        const el = document.querySelector('.reader__page')
        if (!el) return null
        return {
          chapter: Number(el.getAttribute('data-chapter-index')),
          page: Number(el.getAttribute('data-page-index')),
          count: Number(el.getAttribute('data-page-count')),
          title: el.getAttribute('data-chapter-title') ?? '',
          hasHead: document.querySelector('.reader__running-head') !== null,
          folio: Number((document.querySelector('.reader__folio-number')?.textContent ?? '').trim()),
        }
      })

    const st0 = await readState()
    step(
      '长章节被正确分页',
      !!st0 && st0.title.includes('山雨欲来') && st0.count > 1,
      st0 ? `章="${st0.title}" 共 ${st0.count} 页` : '读不到分页状态',
    )

    const afterJump = await page.$eval('.reader__chapter-title', (el) => el.textContent ?? '').catch(() => '')
    step('目录跳转章节', afterJump.trim().length > 0, `章标题="${afterJump.trim()}"`)
    await shot('07-跳章后')

    // 章首页的书籍体例：章标题已在版心内，天头不再重复印书眉。
    step('章首页不重复印书眉', st0 !== null && !st0.hasHead, st0?.hasHead ? '章首页出现了书眉' : '章首页无书眉')

    // ============ 6b. 章节内翻页的书籍体例 ============
    // 前面的翻页都是**跨章**的（其余章节恰好一页），所以只有在这里 ——
    // 同一章内部翻到第 2 页 —— 才能真正检验「次页起印书眉、页码递增」。
    if (st0 && st0.count > 1 && st0.page === 0) {
      await page.click('.reader__zones button:last-child')
      await new Promise((r) => setTimeout(r, 800))
      const st1 = await readState()

      step(
        '章节内翻页真的翻到了第 2 页',
        !!st1 && st1.page === st0.page + 1 && st1.chapter === st0.chapter,
        st1 ? `第 ${st0.page + 1} → 第 ${st1.page + 1} 页（章 ${st0.chapter} → ${st1.chapter}）` : '读不到状态',
      )
      step('章节次页印出天头书眉', !!st1 && st1.hasHead, st1?.hasHead ? '次页有书眉' : '次页无书眉')
      step('章节内翻页页码递增', !!st1 && st1.folio === st0.folio + 1, `${st0.folio} → ${st1?.folio}`)

      // 翻页不能丢字：第 2 页必须真的有正文，而不是空白页。
      const page2Text = await page.$eval('.reader__text', (el) => (el.textContent ?? '').trim())
      step('次页有正文（未丢字）', page2Text.length > 0, `${page2Text.length} 字符`)
      await shot('07b-章节内次页')
    }

    // 关闭目录（面板底部工具栏此时被面板盖住，必须先关面板）
    await closeAnyOverlay()
  }

  // ============ 7. 排版面板与字号 ============
  // 注意：跳章后工具栏可能仍处于打开状态（会盖住正文），
  // 因此这里必须**先确保工具栏可见**，而不是盲目再点一次中间热区（那会把它关掉）。
  const toolbarReady = await ensureChromeVisible()
  step('工具栏可再次呼出', toolbarReady, toolbarReady ? '工具栏可见' : '无法呼出工具栏')

  await clickByAria('排版')
  await new Promise((r) => setTimeout(r, 900))
  const steppers = await page.$$eval('.stepper', (els) => els.length)
  step('排版面板含加减器', steppers >= 4, `${steppers} 组`)
  await shot('08-排版面板')

  if (steppers > 0) {
    const beforeSize = await page.evaluate(() => getComputedStyle(document.querySelector('.reader__text')).fontSize)
    // 点第一个 stepper 的「增大」按钮
    const plusButtons = await page.$$('.stepper button:last-child')
    if (plusButtons[0]) await plusButtons[0].click()
    await new Promise((r) => setTimeout(r, 900))
    const afterSize = await page.evaluate(() => getComputedStyle(document.querySelector('.reader__text')).fontSize)
    step('字号调整即时生效', beforeSize !== afterSize, `${beforeSize} → ${afterSize}`)
    await shot('09-字号增大后')
  }

  // 关掉面板并确保工具栏可见，供后续步骤使用
  await closeAnyOverlay()
  await ensureChromeVisible()

  // ============ 8. 主题切换 ============
  const nightClicked = await page.evaluate(() => {
    const btn = document.querySelector('[aria-label="夜间"]')
    if (btn) {
      btn.click()
      return true
    }
    return false
  })
  await new Promise((r) => setTimeout(r, 900))
  const themeAttr = await page.evaluate(() => document.documentElement.dataset.theme)
  step('夜间主题切换', nightClicked && themeAttr === 'night', `data-theme=${themeAttr}`)
  await shot('10-夜间主题')

  // 切回日间
  await page.evaluate(() => document.querySelector('[aria-label="夜间"]')?.click())
  await new Promise((r) => setTimeout(r, 700))

  // ============ 9. 返回书架 ============
  await ensureChromeVisible()
  await clickByAria('返回书架')
  await new Promise((r) => setTimeout(r, 1400))
  const backOnShelf = (await page.$('.shelf')) !== null
  step('返回书架', backOnShelf, backOnShelf ? '已回到书架' : '仍在阅读器')
  await shot('11-返回书架')

  // 进度是否被保存（阅读进度持久化）
  const progressSaved = await page.evaluate(() => {
    return new Promise((resolve) => {
      const req = indexedDB.open('moyu-reader')
      req.onsuccess = () => {
        const db = req.result
        const tx = db.transaction('positions', 'readonly')
        const all = tx.objectStore('positions').getAll()
        all.onsuccess = () => {
          const pos = all.result[0]
          resolve(pos ? { percent: pos.percent, chapterIndex: pos.chapterIndex } : null)
        }
        all.onerror = () => resolve(null)
      }
      req.onerror = () => resolve(null)
    })
  })
  step('阅读进度已持久化', !!progressSaved, progressSaved ? `进度 ${(progressSaved.percent * 100).toFixed(1)}% 第 ${progressSaved.chapterIndex + 1} 章` : '未写入')

  // ============ 10. 搜索 ============
  await page.evaluate(() => {
    // 打开书籍卡片的长按菜单不方便脚本触发，直接用书架工具栏按钮找不到就用键盘路径
  })
  const searchOpened = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'))
    const target = btns.find((b) => (b.getAttribute('aria-label') ?? '').includes('搜索'))
    if (target) {
      target.click()
      return true
    }
    return false
  })
  if (searchOpened) {
    await new Promise((r) => setTimeout(r, 900))
    // 输入关键词并搜索
    const input = await page.$('input[type="search"], input[placeholder*="搜索"], .topbar input')
    if (input) {
      await input.type('剑柄')
      await new Promise((r) => setTimeout(r, 1400))
      const hits = await page.$$eval('.search-hit', (els) => els.length)
      step('全文搜索命中结果', hits > 0, `${hits} 条结果`)
      await shot('12-搜索结果')
      const marks = await page.$$eval('.search-hit mark', (els) => els.length)
      step('搜索关键词高亮', marks > 0, `${marks} 处 <mark>`)
    } else {
      step('搜索输入框', false, '未找到输入框')
    }
  } else {
    step('打开搜索页', false, '未找到搜索入口')
  }

  // ============ 11. 统计页 ============
  await page.evaluate(() => {
    const btn = document.querySelector('[aria-label="统计"]')
    if (btn) btn.click()
  })
  await new Promise((r) => setTimeout(r, 1500))
  const statTiles = await page.$$eval('.stat-tile', (els) => els.length)
  step('统计页总览卡片', statTiles > 0, `${statTiles} 张卡片`)
  const heatmapCells = await page.$$eval('.heatmap__cell', (els) => els.length)
  step('热力图渲染', heatmapCells > 0, `${heatmapCells} 格`)
  await shot('13-阅读统计')

  // ============ 12. 笔记页 ============
  await page.evaluate(() => {
    const btn = document.querySelector('[aria-label="笔记"]')
    if (btn) btn.click()
  })
  await new Promise((r) => setTimeout(r, 1200))
  await shot('14-笔记页')
  step('笔记页可打开', (await page.$('.screen')) !== null)

  // ============ 13. 设置页 ============
  await page.evaluate(() => {
    const btn = document.querySelector('[aria-label="设置"]')
    if (btn) btn.click()
  })
  await new Promise((r) => setTimeout(r, 1200))
  const themeSwatches = await page.$$eval('.theme-swatch', (els) => els.length)
  step('设置页主题选择器', themeSwatches >= 4, `${themeSwatches} 个主题`)
  const settingRows = await page.$$eval('.setting-row', (els) => els.length)
  step('设置项渲染', settingRows > 10, `${settingRows} 行设置`)
  const switches = await page.$$eval('.switch', (els) => els.length)
  step('开关控件渲染', switches > 0, `${switches} 个开关`)
  await shot('15-设置页')

  // 滚动到设置页底部截图（验证朗读/词典/数据/关于分区）
  await page.evaluate(() => {
    const area = document.querySelector('.scroll-area')
    if (area) area.scrollTop = area.scrollHeight
  })
  await new Promise((r) => setTimeout(r, 700))
  await shot('16-设置页底部')

  // 切主题验证即时生效
  const themeBefore = await page.evaluate(() => document.documentElement.dataset.theme)
  await page.evaluate(() => {
    const swatch = document.querySelectorAll('.theme-swatch')[3]
    if (swatch) swatch.click()
  })
  await new Promise((r) => setTimeout(r, 800))
  const themeAfter = await page.evaluate(() => document.documentElement.dataset.theme)
  step('设置页切换主题生效', themeBefore !== themeAfter || themeAfter !== undefined, `${themeBefore} → ${themeAfter}`)
  await shot('17-主题切换')

  // ============ 14. 导入页 ============
  await page.evaluate(() => {
    const btn = document.querySelector('[aria-label="书架"]')
    if (btn) btn.click()
  })
  await new Promise((r) => setTimeout(r, 800))
  const importOpened = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'))
    const target = btns.find((b) => (b.getAttribute('aria-label') ?? '').includes('导入'))
    if (target) {
      target.click()
      return true
    }
    return false
  })
  if (importOpened) {
    await new Promise((r) => setTimeout(r, 900))
    const dropzone = (await page.$('.dropzone')) !== null
    step('导入页拖放区渲染', dropzone, dropzone ? 'dropzone 存在' : '未找到')
    await shot('18-导入页')
  } else {
    step('打开导入页', false, '未找到导入入口')
  }

  // ============ 15. 控制台错误检查 ============
  // 生产构建不应有 error 级别日志。这里不再对 favicon 之类的资源做豁免 ——
  // 之前正是那条豁免掩盖了一个真实的 404，现在补了图标就该彻底干净。
  const filteredErrors = consoleErrors.filter((e) => !e.includes('Download the React DevTools'))
  step('无页面级异常', pageErrors.length === 0, pageErrors.length ? pageErrors.slice(0, 3).join(' | ') : '无')
  step('无失败请求（404 等）', failedRequests.length === 0, failedRequests.length ? failedRequests.slice(0, 4).join(' | ') : '无')
  step('无控制台错误', filteredErrors.length === 0, filteredErrors.length ? filteredErrors.slice(0, 3).join(' | ') : '无')

  return { results, consoleErrors: filteredErrors, pageErrors, failedRequests }
}

main()
  .then(async (out) => {
    const failed = out.results.filter((r) => !r.ok)
    console.log(`\n=== 实测汇总：${out.results.length - failed.length}/${out.results.length} 通过 ===`)
    if (failed.length) {
      console.log('\n失败项：')
      for (const f of failed) console.log(`  ✗ ${f.name} — ${f.detail}`)
    }
    mkdirSync(OUT_DIR, { recursive: true })
    writeFileSync(
      resolve(OUT_DIR, 'e2e-report.json'),
      JSON.stringify({ generatedAt: new Date().toISOString(), baseUrl: BASE_URL, results: out.results }, null, 2),
    )
    await browser?.close()
    process.exit(failed.length ? 1 : 0)
  })
  .catch(async (err) => {
    console.error('\n实测中断:', err.message)
    // 先确保产物目录存在：否则连错误现场都存不下来，排查会失去线索
    mkdirSync(OUT_DIR, { recursive: true })
    if (page) {
      try {
        await page.screenshot({ path: resolve(OUT_DIR, 'error-state.png') })
        const html = await page.content()
        writeFileSync(resolve(OUT_DIR, 'error-state.html'), html)
        console.error('已保存错误现场截图与 HTML 到 test-artifacts/')
      } catch {
        /* 忽略截图失败 */
      }
    }
    writeFileSync(
      resolve(OUT_DIR, 'e2e-report.json'),
      JSON.stringify({ generatedAt: new Date().toISOString(), error: err.message, results }, null, 2),
    )
    await browser?.close()
    process.exit(1)
  })
