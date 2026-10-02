/**
 * 形变图标组件（Web 端）。
 *
 * 包一层 morphicons 的 React 绑定，目的是把**三段式图标数据**（一个图标 =
 * 若干条子路径）统一成 morphicons 认识的 `IconNode`，并固定一套默认参数
 * （尺寸、描边、弹簧），让所有调用点长得一样。
 *
 * 与 Android 端的关系：形状由 `morphIcons.ts` 里的路径数据决定，弹簧参数也共用同一组
 * 数值，因此两端的动效是可对齐的。修改任何一端时都必须同步另一端。
 */
import { useMemo } from 'react'
import { MorphIcon } from 'morphicons/react'
import type { IconPaths, SpringName } from './morphIcons'
import { SPRING_PRESETS } from './morphIcons'

/**
 * 把「一串 d 字符串」转成 morphicons 能吃的输入。
 *
 * 关键契约（踩过一次坑）：`resampleIcon` / `buildPlan` 的输入是
 * **`IconNode`（`[tag, attrs][]`）或单个 `d` 字符串**，
 * 而**不是**「`d` 字符串的数组」。直接传数组会被当成节点列表，
 * 报 `unsupported tag <M>` —— 因为解析器把第一个 `d` 的第一个字符当成了标签名。
 *
 * 这里选择合并成一个 `d` 字符串：morphicons 自己按 `M` 拆分并识别 `Z`（闭合子路径），
 * 一条字符串就能表达全部子路径，也少一层结构。
 *
 * 注意子路径之间必须用空格分隔。若上一条子路径不以 `Z` 结尾，
 * 直接拼接 `M...` 是合法的（`M` 本身就会终止上一条子路径）。
 */
export function toIconInput(paths: IconPaths): string {
  return paths.join(' ')
}

export interface MorphGlyphProps {
  /** 目标图标；变化时自动从当前形状形变过去 */
  paths: IconPaths
  size?: number
  strokeWidth?: number
  spring?: SpringName
  className?: string
  /** 传入后不再是纯装饰：会给 svg 加 role="img" 与可访问名称 */
  label?: string
}

/**
 * 一个会形变的描边图标。
 *
 * 关于性能：morphicons 内部按**引用**缓存「归一化结果」与「配对方案」。
 * 合并出的字符串每次渲染都是新的，因此这里用 useMemo 按 paths 引用缓存住，
 * 否则缓存永远命不中，形变会退化成每帧重新解析路径。
 */
export function MorphGlyph({
  paths,
  size = 22,
  strokeWidth = 1.8,
  spring = 'snappy',
  className,
  label,
}: MorphGlyphProps) {
  const input = useMemo(() => toIconInput(paths), [paths])
  return (
    <MorphIcon
      icon={input as never}
      size={size}
      strokeWidth={strokeWidth}
      spring={spring}
      color="currentColor"
      className={className}
      label={label}
    />
  )
}

export { SPRING_PRESETS }
