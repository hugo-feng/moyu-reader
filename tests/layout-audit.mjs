/**
 * 布局审计：在多种手机尺寸下量出「被裁切 / 越界 / 与系统栏重叠」的元素。
 *
 * 存在的理由：遮挡与裁切这类问题，靠看截图很容易漏（特别是只在某一种屏幕宽度下出现）。
 * 这里用几何数据判断：元素内容比容器高却设了 overflow:hidden，就是被裁掉了。
 *
 * 用法：node tests/layout-audit.mjs [baseUrl]
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import puppeteer from 'puppeteer'

const BASE_URL = process.argv[2] ?? 'http://127.0.0.1:4173'
const OUT_DIR = resolve(process.cwd(), 'test-artifacts')

/**
 * 目标尺寸。列的是「逻辑分辨率 × 缩放」，也就是真机上的 CSS 像素：
 *   - 小屏：iPhone SE / 老安卓，宽度只有 320
 *   - 主流：390（iPhone 14）、393（Pixel 7）、412（多数国产安卓）
 *   - 大屏 / 折叠：430（iPhone Pro Max）、480（小平板）
 * insets 用来模拟「状态栏 + 手势条」占掉的区域。
 */
const DEVICES = [
  { name: 'SE-320', width: 320, height: 568, insets: { top: 20, bottom: 0 } },
  { name: 'iPhone14-390', width: 390, height: 844, insets: { top: 47, bottom: 34 } },
  { name: 'Pixel7-393', width: 393, height: 851, insets: { top: 24, bottom: 16 } },
  { name: 'Android-412', width: 412, height: 915, insets: { top: 28, bottom: 16 } },
  { name: 'ProMax-430', width: 430, height: 932, insets: { top: 59, bottom: 34 } },
  { name: 'Fold-480', width: 480, height: 1000, insets: { top: 30, bottom: 24 } },
]

const BROWSER_CANDIDATES = [
  process.env.MOYU_BROWSER,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean)

const exe = BROWSER_CANDIDATES.find((p) => existsSync(p))
if (!exe) {
  console.error('找不到 Chromium 内核浏览器')
  process.exit(2)
}
mkdirSync(OUT_DIR, { recursive: true })

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 把模拟的安全区交给页面，并把滚动位置归零。
 *
 * 写的是 `--safe-*-override`（默认 0px）而不是 `--safe-*-real`：
 * 应用自身会在 resize 时重测并写回 -real，直接覆盖会被冲掉。
 * CSS 用 max() 合并两者，因此测试值不会被应用的探测逻辑吃掉 ——
 * 被测代码照常走自己的流程，测试只把「设备安全区」这个外部条件固定下来。
 *
 * 滚动归零同样重要：点击「加载示例书」时 Puppeteer 会把按钮滚进视口，
 * 页面就停在一个随机滚动位置，之后量到的「越界/被裁」全是那个位置的产物，
 * 而不是布局本身的问题。
 */
async function applySafeArea(page, insets) {
  await page.evaluate(
    (i) => {
      const root = document.documentElement
      root.style.setProperty('--safe-top-override', `${i.top}px`)
      root.style.setProperty('--safe-bottom-override', `${i.bottom}px`)
      for (const el of document.querySelectorAll('.scroll-area, .reader__text')) {
        el.scrollTop = 0
      }
      window.scrollTo(0, 0)
    },
    insets,
  )
  await wait(120)
}

/**
 * 收集页面上真正有问题的元素。
 *
 * 判据刻意做成「元素自身的 box 越界」，而不是「scrollWidth > clientWidth」：
 * 后者对绝对定位的子元素（工具栏、热区层）会大量误报 ——
 * 父容器的 scrollWidth 会把定位到容器外的子元素也算进去，但那些元素本来就该在容器外。
 * 只报「文字被遮挡 / 被裁掉」这一类用户真能看见的问题。
 */
async function auditPage(page, insets) {
  return page.evaluate((ins) => {
    const viewport = { w: window.innerWidth, h: window.innerHeight }
    const problems = []
    const seen = new Set()

    function describe(el) {
      const raw = typeof el.className === 'string' ? el.className.trim() : ''
      const cls = raw ? raw.split(/\s+/)[0] : ''
      return cls || el.tagName.toLowerCase()
    }

    /** 元素是否真的承载可见文字（本身直接含文本节点）。 */
    function hasOwnText(el) {
      for (const node of el.childNodes) {
        if (node.nodeType === 3 && (node.textContent ?? '').trim().length > 0) return true
      }
      return false
    }

    /**
     * 元素是否真的能被看见。
     *
     * 必须沿祖先链判断，不能只看元素自身：阅读页的工具栏收起时是
     * `opacity:0` + `translateY(±100%)`，里面的按钮自身样式完全正常，
     * 但用户根本看不到它们 —— 只查自身会产生大量「被裁切」的误报。
     */
    function isVisible(el, style) {
      if (style.display === 'none' || style.visibility === 'hidden') return false
      const box = el.getBoundingClientRect()
      if (box.width <= 0 || box.height <= 0) return false

      // 完全在视口之外（收起的工具栏就是这种情况）
      if (box.bottom <= 0 || box.top >= window.innerHeight) return false
      if (box.right <= 0 || box.left >= window.innerWidth) return false

      let node = el
      while (node && node !== document.documentElement) {
        const ns = getComputedStyle(node)
        if (ns.display === 'none' || ns.visibility === 'hidden') return false
        if (parseFloat(ns.opacity) < 0.05) return false
        node = node.parentElement
      }
      return true
    }

    /**
     * 找最近的可横向滚动祖先。
     * 用于区分「排在视口外但能滑出来」与「真的被裁掉」—— 这两者观感完全不同，
     * 前者是正常的横向滚动行，后者才是缺陷。
     */
    function findHorizontalScrollParent(el) {
      let parent = el.parentElement
      while (parent && parent !== document.body) {
        const ps = getComputedStyle(parent)
        if (['auto', 'scroll'].includes(ps.overflowX)) return parent
        parent = parent.parentElement
      }
      return null
    }

    /**
     * 沿祖先链找「把该元素裁掉」的容器。
     * 只要元素的一部分落在某个 overflow:hidden 祖先的可视区之外，用户就看不到那部分。
     *
     * 两类豁免：
     *   1. **可滚动容器不算裁切** —— 内容比滚动区高/宽、需要滑动才能看到，
     *      这是正常行为。早期版本把 scroll-area 的纵向溢出也报成「被裁切」，
     *      在窄屏上给出一条 30px 的假问题，掩盖了真正的信号。
     *   2. 元素位于横向可滚动容器内时，豁免**横向**判定（纵向仍然要查）。
     *      横向滚动行末尾的 chip 本来就该在视口外，滑一下就能看到。
     */
    function clippedBy(el, box, allowHorizontalOverflow) {
      let parent = el.parentElement
      while (parent && parent !== document.body) {
        const ps = getComputedStyle(parent)
        const hides = ps.overflow === 'hidden' || ps.overflowY === 'hidden' || ps.overflowX === 'hidden'
        const scrollable =
          ['auto', 'scroll'].includes(ps.overflowY) || ['auto', 'scroll'].includes(ps.overflowX)
        if (hides && !scrollable) {
          const pb = parent.getBoundingClientRect()
          const clippedTop = pb.top - box.top
          const clippedBottom = box.bottom - pb.bottom
          const clippedLeft = pb.left - box.left
          const clippedRight = box.right - pb.right
          const worstY = Math.max(clippedTop, clippedBottom)
          const worstX = allowHorizontalOverflow ? -Infinity : Math.max(clippedLeft, clippedRight)
          // 留 2px 容差：字体度量与亚像素舍入会带来 1px 级别的误差
          if (worstY > 2 || worstX > 2) {
            return {
              parent: describe(parent),
              detail:
                worstY >= worstX
                  ? `纵向被裁 ${Math.round(worstY)}px（${describe(parent)} 内）`
                  : `横向被裁 ${Math.round(worstX)}px（${describe(parent)} 内）`,
            }
          }
        }
        parent = parent.parentElement
      }
      return null
    }

    const candidates = document.querySelectorAll('h1,h2,h3,h4,p,span,button,input,textarea,li,label,div')

    for (const el of candidates) {
      const style = getComputedStyle(el)
      if (!isVisible(el, style)) continue

      // 无文字的透明触摸热区（如阅读页的翻页三热区）本就该铺满全屏，
      // 它们不是「被遮挡的内容」，报出来只是噪声。
      if (el.tagName === 'BUTTON' && (el.textContent ?? '').trim().length === 0) continue

      const box = el.getBoundingClientRect()
      const text = (el.textContent ?? '').trim().slice(0, 24)
      // 只关心承载文字的叶子级元素，容器 div 的越界由它内部的文字元素代表
      const ownText = hasOwnText(el)
      if (!ownText && !['INPUT', 'TEXTAREA'].includes(el.tagName)) continue

      const key = `${describe(el)}@${Math.round(box.top)},${Math.round(box.left)}`
      if (seen.has(key)) continue
      seen.add(key)

      const scrollParent = findHorizontalScrollParent(el)
      const scrollableX =
        scrollParent !== null &&
        (scrollParent.scrollWidth > scrollParent.clientWidth + 1 ||
          getComputedStyle(scrollParent).overflowX === 'scroll')

      // 2. 越过视口左右边界 —— 但要排除「横向可滚动」的情况。
      //
      // 在横向滚动行（如书架的筛选标签）里，末尾的 chip 本来就落在视口之外、
      // 需要滑动才能看到，这是设计行为而不是缺陷。用视口边界判定会把它误报成
      // 「被裁切 / 越界」，掩盖真正的问题。
      //
      // 注意：**这个豁免必须放在「被裁切」检查之前**。
      // 否则控制流会先走到 clippedBy，在那里把横向溢出报成「被裁」，
      // 而这行豁免根本没有机会执行 —— 逻辑写对了但顺序错了，等于没写。
      if (!scrollableX) {
        const bounds = scrollParent
          ? scrollParent.getBoundingClientRect()
          : { left: 0, right: viewport.w }
        if (box.left < bounds.left - 1 || box.right > bounds.right + 1) {
          problems.push({
            kind: '横向越界',
            el: describe(el),
            text,
            detail: `left=${Math.round(box.left)} right=${Math.round(box.right)} 容器宽 ${Math.round(bounds.right - bounds.left)}`,
          })
          continue
        }
      }

      // 3. 被 overflow:hidden 的祖先裁掉（纵向，或不可滚动时的横向）
      const clipped = clippedBy(el, box, scrollableX)
      if (clipped) {
        problems.push({
          kind: '被裁切',
          el: describe(el),
          text,
          detail: clipped.detail,
        })
        continue
      }
      if (ins.top > 0 && box.top < ins.top - 1 && box.bottom > 0) {
        problems.push({
          kind: '顶部被系统栏遮挡',
          el: describe(el),
          text,
          detail: `top=${Math.round(box.top)} < 安全区 ${ins.top}`,
        })
      }
      if (ins.bottom > 0 && box.bottom > viewport.h - ins.bottom + 1 && box.top < viewport.h) {
        problems.push({
          kind: '底部被手势条遮挡',
          el: describe(el),
          text,
          detail: `bottom=${Math.round(box.bottom)} > 安全线 ${viewport.h - ins.bottom}`,
        })
      }
    }

    return { viewport, problems }
  }, insets)
}

/**
 * 阅读页专项检查：**正文最后一行必须在安全线之上**。
 *
 * 这是「字铺满后底部被遮挡」的直接判据，也是本次修复的核心验收项。
 * 只查「元素是否落在安全区里」不够 —— 正文段落本身可能整段都在安全区内，
 * 但多出来的那一行会把后面内容整体下推。所以这里直接量文字的实际底边。
 */
async function auditReaderText(page, insets) {
  return page.evaluate((ins) => {
    const problems = []
    const viewportH = window.innerHeight
    const limitBottom = viewportH - ins.bottom

    const textEl = document.querySelector('.reader__text')
    if (!textEl) return { problems, note: '没有 .reader__text' }

    // 只取当前页渲染出来的正文段落。分页把每段写成带 data-offset 的 <p>，
    // 用它过滤可以排除掉面板/目录里同名的 <p>，避免量错元素。
    const paras = [...textEl.querySelectorAll('p[data-offset]')]
    if (paras.length === 0) {
      return {
        problems,
        note: `本页无正文段落（.reader__text 内共 ${textEl.querySelectorAll('p').length} 个 p）`,
      }
    }

    // 自检：正文段落必须真的落在 .reader__text 的纵向范围内。
    // 若某一段完全在容器之外，说明选择器抓到了不该抓的元素 —— 与其报一个假问题，
    // 不如把这件事如实写进 note，让人能分辨「真溢出」与「量错了」。
    const textBox = textEl.getBoundingClientRect()
    const strays = paras.filter((p) => {
      const b = p.getBoundingClientRect()
      return b.bottom < textBox.top - 1 || b.top > textBox.bottom + 1
    })

    const firstBox = paras[0].getBoundingClientRect()
    const lastBox = paras[paras.length - 1].getBoundingClientRect()

    if (strays.length > 0) {
      return {
        problems,
        note: `有 ${strays.length}/${paras.length} 个段落落在 .reader__text 之外，测量结果不可信`,
      }
    }

    // 1. 末行不得越过手势条安全线 —— 这就是用户说的「底部字被遮挡」
    if (lastBox.bottom > limitBottom + 1) {
      problems.push({
        kind: '正文末行压到手势条',
        detail: `末行底边 ${Math.round(lastBox.bottom)} > 安全线 ${Math.round(limitBottom)}（超出 ${Math.round(lastBox.bottom - limitBottom)}px）`,
      })
    }

    // 2. 末行不得溢出正文容器（容器已被 padding 限制在安全区内）
    if (lastBox.bottom > textBox.bottom + 1) {
      problems.push({
        kind: '正文末行溢出容器',
        detail: `末行底边 ${Math.round(lastBox.bottom)} > 容器底边 ${Math.round(textBox.bottom)}（溢出 ${Math.round(lastBox.bottom - textBox.bottom)}px）`,
      })
    }

    // 3. 首行必须在状态栏安全线之下
    if (firstBox.top < ins.top - 1) {
      problems.push({
        kind: '正文首行钻进状态栏',
        detail: `首行顶边 ${Math.round(firstBox.top)} < 安全线 ${ins.top}`,
      })
    }

    // 4. 地脚页码必须在安全线之上
    const folio = document.querySelector('.reader__folio-number')
    if (folio) {
      const fb = folio.getBoundingClientRect()
      if (fb.bottom > limitBottom + 1) {
        problems.push({
          kind: '页码压到手势条',
          detail: `页码底边 ${Math.round(fb.bottom)} > 安全线 ${Math.round(limitBottom)}`,
        })
      }
    }

    return {
      problems,
      note: `视口 ${viewportH}  首行顶 ${Math.round(firstBox.top)}  末行底 ${Math.round(lastBox.bottom)}  安全线 ${Math.round(limitBottom)}  段落 ${paras.length}`,
    }
  }, insets)
}

/** 打开示例书并进入阅读页。 */
async function enterReader(page) {
  const opened = await page.evaluate(() => {
    const hit = [...document.querySelectorAll('button,[role="button"]')].find((el) =>
      (el.getAttribute('aria-label') ?? '').includes('打开《'),
    )
    if (!hit) return false
    hit.setAttribute('data-audit', '1')
    return true
  })
  if (!opened) throw new Error('书架上找不到可打开的书')
  await page.click('[data-audit="1"]')
  await page.waitForSelector('.reader__text', { timeout: 8000 })
  await wait(900)
}

const browser = await puppeteer.launch({
  executablePath: exe,
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none'],
})

const report = { generatedAt: new Date().toISOString(), devices: [] }

for (const device of DEVICES) {
  const page = await browser.newPage()
  await page.setViewport({ width: device.width, height: device.height, deviceScaleFactor: 2 })
  await page.goto(BASE_URL, { waitUntil: 'networkidle2' })
  await page.waitForSelector('.app', { timeout: 15000 })
  await wait(700)
  await applySafeArea(page, device.insets)

  // 书架：没有书就先加载示例书
  if ((await page.$('.empty')) !== null) {
    const sel = await page.evaluate(() => {
      const hit = [...document.querySelectorAll('button')].find((el) =>
        (el.textContent ?? '').includes('加载示例书'),
      )
      if (!hit) return null
      hit.setAttribute('data-audit-load', '1')
      return '[data-audit-load="1"]'
    })
    if (sel) {
      await page.click(sel)
      await wait(2200)
    }
  }
  await applySafeArea(page, device.insets)

  const shelf = await auditPage(page, device.insets)
  await page.screenshot({ path: resolve(OUT_DIR, `audit-${device.name}-书架.png`) })

  // 阅读页
  await enterReader(page)
  await applySafeArea(page, device.insets)
  const reader = await auditPage(page, device.insets)
  // 正文首末行与页码的安全线专项检查（本次「底部被遮挡」的核心验收项）
  const readerText = await auditReaderText(page, device.insets)
  // 翻一页再查一次：分页后的第二页同样不能溢出
  await page.click('.reader__zones button:last-child').catch(() => {})
  await wait(700)
  await applySafeArea(page, device.insets)
  const readerText2 = await auditReaderText(page, device.insets)
  await page.screenshot({ path: resolve(OUT_DIR, `audit-${device.name}-阅读页.png`) })

  // 底部导航在各页都存在，单独确认它的高度没有被裁
  const tabbar = await page.evaluate(() => {
    const el = document.querySelector('.tabbar')
    if (!el) return null
    const box = el.getBoundingClientRect()
    return {
      height: Math.round(box.height),
      bottom: Math.round(box.bottom),
      viewportH: window.innerHeight,
      paddingBottom: getComputedStyle(el).paddingBottom,
    }
  })

  report.devices.push({
    device: device.name,
    size: `${device.width}x${device.height}`,
    insets: device.insets,
    shelf: { problems: shelf.problems },
    reader: { problems: reader.problems },
    readerTextFirstPage: readerText,
    readerTextSecondPage: readerText2,
    tabbar,
  })

  await page.close()
}

await browser.close()

// —— 汇总 ——
writeFileSync(resolve(OUT_DIR, 'layout-audit.json'), JSON.stringify(report, null, 2))

let total = 0
console.log('\n=== 布局审计结果 ===\n')
for (const d of report.devices) {
  const textProblems = [...d.readerTextFirstPage.problems, ...d.readerTextSecondPage.problems]
  const n = d.shelf.problems.length + d.reader.problems.length + textProblems.length
  total += n
  console.log(`${d.device.padEnd(16)} ${d.size.padEnd(10)} 问题 ${n} 个`)
  for (const p of [
    ...d.shelf.problems.map((x) => ({ ...x, page: '书架' })),
    ...d.reader.problems.map((x) => ({ ...x, page: '阅读页' })),
    ...textProblems.map((x) => ({ ...x, page: '阅读页正文' })),
  ]) {
    console.log(`    [${p.page}] ${p.kind}  .${p.el ?? '-'}  — ${p.detail}`)
  }
  console.log(`    阅读页第 1 页：${d.readerTextFirstPage.note}`)
  console.log(`    阅读页第 2 页：${d.readerTextSecondPage.note}`)
  if (d.tabbar) {
    console.log(
      `    底部导航 高 ${d.tabbar.height}px  bottom=${d.tabbar.bottom} 视口高 ${d.tabbar.viewportH}  padding-bottom=${d.tabbar.paddingBottom}`,
    )
  }
}
console.log(`\n合计问题: ${total}`)
console.log(`明细: test-artifacts/layout-audit.json`)
process.exit(total > 0 ? 1 : 0)
