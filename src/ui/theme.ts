/**
 * 排版参数 → CSS 变量。
 *
 * 阅读器与设置页需要把同一套排版参数应用成样式，因此抽到这里统一，
 * 避免两端各写一份导致「预览与实际不一致」。
 */

import type { CSSProperties } from 'react'
import type { ReaderSettings, Typography } from '../engine/types'
import { FONT_STACKS, THEMES } from '../engine/types'

/** 阅读区的 CSS 变量集合。 */
export interface ReaderStyleVars extends CSSProperties {
  '--reader-bg'?: string
  '--reader-fg'?: string
  '--reader-fg-soft'?: string
  '--reader-font'?: string
  '--reader-size'?: string
  '--reader-lh'?: string
  '--reader-para'?: string
  '--reader-pad-x'?: string
  '--reader-pad-y'?: string
  '--reader-align'?: string
  '--reader-indent'?: string
  '--reader-tracking'?: string
}

/** 由设置生成阅读区样式变量。 */
export function readerStyleVars(settings: ReaderSettings): ReaderStyleVars {
  const palette = THEMES[settings.theme]
  const t = settings.typography
  return {
    '--reader-bg': palette.background,
    '--reader-fg': palette.text,
    '--reader-fg-soft': palette.textSecondary,
    '--reader-font': FONT_STACKS[t.fontFamily].css,
    '--reader-size': `${t.fontSize}px`,
    '--reader-lh': `${t.lineHeight}`,
    '--reader-para': `${t.paragraphSpacing}em`,
    '--reader-pad-x': `${t.margin}px`,
    '--reader-pad-y': `${Math.round(t.margin * 0.9)}px`,
    '--reader-align': t.justify ? 'justify' : 'left',
    '--reader-indent': `${t.indent}em`,
    // 中文正文需要极轻微的字距，否则密集汉字会显得拥挤
    '--reader-tracking': '0.012em',
    fontWeight: t.bold ? 600 : 400,
  }
}

/** 阅读区的有效字号（像素）。分页计算与样式必须用同一个值。 */
export function effectiveFontSize(typography: Typography): number {
  return typography.fontSize
}

/** 顶栏/底栏高度，用于计算可用正文高度。 */
export const CHROME_HEIGHT = 0

/** 把排版参数描述成一句人话，用于设置页摘要。 */
export function describeTypography(t: Typography): string {
  const parts = [
    `${FONT_STACKS[t.fontFamily].name}`,
    `${t.fontSize}px`,
    `行距 ${t.lineHeight.toFixed(1)}`,
  ]
  if (t.bold) parts.push('加粗')
  if (!t.justify) parts.push('左对齐')
  return parts.join(' · ')
}

/** 翻页方式的显示名。 */
export const PAGE_MODE_LABELS: Record<ReaderSettings['pageMode'], string> = {
  simulation: '仿真',
  slide: '平移',
  cover: '覆盖',
  scroll: '滚动',
  none: '无动画',
}
