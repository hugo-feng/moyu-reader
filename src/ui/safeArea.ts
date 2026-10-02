/**
 * 设备安全区（状态栏 / 刘海 / 底部手势条）探测。
 *
 * 为什么需要它：
 *   浏览器与 iOS WebView 里 `env(safe-area-inset-*)` 可用，CSS 直接读就行。
 *   但 **Android WebView 里 `env(safe-area-inset-bottom)` 恒为 0**，
 *   而底部手势条是真实存在的（通常 16px 上下）—— 结果是底部导航与页码
 *   被手势条压住，用户看到的就是「字被遮住」。
 *
 * 做法（思路来自同类阅读器的既有实践）：
 *   1. 先用一个探针元素量出 `env()` 的真实值；
 *   2. 量不到（Android WebView）就按平台给一个保守兜底值；
 *   3. 结果写进 `--safe-top-real` / `--safe-bottom-real`，
 *      其余所有布局只读 `--safe-top` / `--safe-bottom` 这两个语义变量。
 *
 * 这样布局代码不接触任何平台判断，测试也能通过覆盖变量来模拟任意机型。
 */

/** Android 手势条的高度。不同 ROM 有差异，取一个不会被完全盖住的保守值。 */
const ANDROID_GESTURE_BAR_FALLBACK = 16

/** Android 状态栏的保守兜底高度（多数机型在 24–28dp）。 */
const ANDROID_STATUS_BAR_FALLBACK = 24

/** 当前生效的安全区（CSS 像素）。 */
export interface SafeArea {
  top: number
  bottom: number
}

const listeners = new Set<(area: SafeArea) => void>()
let currentArea: SafeArea = { top: 0, bottom: 0 }

/**
 * 读取当前**生效**的安全区。
 *
 * 读的是合并后的语义变量 `--safe-top` / `--safe-bottom`（= max(实测, override)），
 * 而不是 `-real`：这样分页用到的数值与布局用到的数值必然一致。
 * 若两边取值来源不同，就会出现「CSS 让开了系统栏、分页却按没让开算」的错位。
 */
function readEffective(): SafeArea {
  if (!document.body) return { top: 0, bottom: 0 }
  const styles = getComputedStyle(document.documentElement)
  const parse = (name: string): number => {
    const value = Number.parseFloat(styles.getPropertyValue(name).trim())
    return Number.isFinite(value) && value > 0 ? value : 0
  }
  return { top: parse('--safe-top'), bottom: parse('--safe-bottom') }
}

function notify(): void {
  const next = readEffective()
  if (next.top === currentArea.top && next.bottom === currentArea.bottom) return
  currentArea = next
  for (const listener of listeners) listener(currentArea)
}

/**
 * 订阅安全区变化。
 *
 * 分页必须知道安全区：可用高度 = 视口高 − 页边距 − 安全区。
 * 只在 CSS 里加 padding 而不重新分页，排出来的页会比可视区高一截，
 * 末行就会被推到屏幕外 —— 也就是用户看到的「字被遮住」。
 */
export function subscribeSafeArea(listener: (area: SafeArea) => void): () => void {
  listeners.add(listener)
  listener(currentArea)
  return () => {
    listeners.delete(listener)
  }
}

/** 主动重读一次。测试改完 override 后调用它，让分页跟上。 */
export function refreshSafeArea(): void {
  notify()
}

/**
 * 量出 `env(safe-area-inset-<side>)` 的真实像素值。
 *
 * 探针技巧：给一个零高度元素设置 `padding: env(...)` 并开启滚动，
 * 支持 env() 的浏览器会把该值计入 scrollHeight，不支持则保持 0。
 * 用 scrollHeight 而不是 offsetHeight，读数不受亚像素舍入影响。
 */
function measureEnvInset(side: 'top' | 'bottom'): number {
  const probe = document.createElement('div')
  probe.style.cssText =
    'position:fixed;left:0;top:0;width:1px;height:0;overflow:scroll;' +
    'pointer-events:none;visibility:hidden;z-index:-1;' +
    `padding-${side}:env(safe-area-inset-${side}, 0px)`
  document.body.appendChild(probe)
  const value = probe.scrollHeight
  document.body.removeChild(probe)
  return Number.isFinite(value) && value > 0 ? value : 0
}

function isAndroid(): boolean {
  return /android/i.test(navigator.userAgent)
}

function isStandalone(): boolean {
  // 装成 PWA / 套壳应用时才是真正的全屏，才需要自己让出系统栏
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    window.matchMedia('(display-mode: fullscreen)').matches ||
    // Android WebView 套壳的常见特征
    /; wv\)/.test(navigator.userAgent)
  )
}

export function applySafeAreaInsets(): void {
  const root = document.documentElement

  let top = measureEnvInset('top')
  let bottom = measureEnvInset('bottom')

  if (top === 0 && isAndroid()) {
    // Android WebView 不报状态栏高度；只有在全屏（套壳/独立应用）里才需要自己让位。
    // 普通浏览器里地址栏已经把状态栏区域占掉了，再让位反而多出一块空白。
    if (isStandalone()) top = ANDROID_STATUS_BAR_FALLBACK
  }

  if (bottom === 0 && isAndroid() && isStandalone()) {
    bottom = ANDROID_GESTURE_BAR_FALLBACK
  }

  root.style.setProperty('--safe-top-real', `${Math.round(top)}px`)
  root.style.setProperty('--safe-bottom-real', `${Math.round(bottom)}px`)

  // 通知订阅者（分页等）重新计算 —— 缺少这一步就会出现
  // 「CSS 让开了系统栏、但分出来的页仍按旧高度算」的错位。
  notify()
}

/** 启动时探测一次，并在转屏 / 窗口尺寸变化时重测（横竖屏的安全区不同）。 */
export function installSafeAreaDetection(): void {
  const run = (): void => {
    // 探针要挂到 body 上，模块被提前求值时 body 可能还不存在
    if (document.body) applySafeAreaInsets()
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run, { once: true })
  } else {
    run()
  }

  window.addEventListener('orientationchange', () => {
    // 转屏后 env() 的更新有延迟，等一帧再读
    window.setTimeout(run, 120)
  })
  window.addEventListener('resize', run)
}
