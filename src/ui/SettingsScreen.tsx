/**
 * 设置页（应用级）。
 *
 * 与阅读器内的「排版」快速面板的分工：
 *   - 快速面板只放阅读时最常改的几项（主题、字号、行距、翻页），改完立刻返回阅读；
 *   - 这里是完整配置台，额外承载朗读、词典、备份这些低频但必要的功能。
 *
 * 两处写入的是同一份 `settings`，因此任何一处改动都会立即反映到另一处 ——
 * 这也是不把「设置」做成两份状态的原因。
 *
 * ## 为什么拆成两级
 *
 * 原先所有设置平铺在一页：25+ 行、要滚三四屏才能找到一项，
 * 用户记不住东西在哪，改一个开关的成本过高。
 * 现在一级只有 6 个分类入口，一眼看完；每项右侧显示**当前值摘要**
 * （如「纸感 · 字号 19」），不进二级页也能确认关键状态。
 */

import { useEffect, useRef, useState } from 'react'
import type { FontFamilyId, PageMode, ThemeId } from '../engine/types'
import { FONT_STACKS, THEMES } from '../engine/types'
import { builtinDictionarySize, parseUserDictionary } from '../engine/dictionary'
import { exportBackup, importBackup, clearAll } from '../storage'
import type { BackupPayload } from '../storage'
import * as db from '../storage'
import type { StoredDictionary } from '../storage'
import { refreshBooks, toast, updateSettings, useAppState } from '../store'
import {
  IconArrowRight,
  IconBack,
  IconCheck,
  IconDictionary,
  IconEye,
  IconLightbulb,
  IconMinus,
  IconNotes,
  IconPlus,
  IconRefresh,
  IconSpeaker,
  IconText,
  IconTrash,
  IconUpload,
} from './icons'

interface SettingsScreenProps {
  onBack: () => void
}

/** 一级分类。顺序即展示顺序：越常用的越靠前。 */
type SettingsCategory = 'appearance' | 'reading' | 'speech' | 'dictionary' | 'data' | 'about'

const SETTINGS_CATEGORIES: Array<{ id: SettingsCategory; title: string; icon: JSX.Element }> = [
  { id: 'appearance', title: '外观与主题', icon: <IconEye size={20} /> },
  { id: 'reading', title: '阅读排版', icon: <IconText size={20} /> },
  { id: 'speech', title: '朗读', icon: <IconSpeaker size={20} /> },
  { id: 'dictionary', title: '词典', icon: <IconDictionary size={20} /> },
  { id: 'data', title: '数据与备份', icon: <IconNotes size={20} /> },
  { id: 'about', title: '关于', icon: <IconLightbulb size={20} /> },
]

const PAGE_MODE_LABELS: Record<PageMode, string> = {
  simulation: '仿真',
  slide: '平移',
  cover: '覆盖',
  scroll: '滚动',
  none: '无动画',
}

export function SettingsScreen({ onBack }: SettingsScreenProps) {
  const { settings } = useAppState()
  const t = settings.typography

  const [dicts, setDicts] = useState<StoredDictionary[]>([])
  const [confirmClear, setConfirmClear] = useState(false)
  const [speaking, setSpeaking] = useState(false)

  const dictInputRef = useRef<HTMLInputElement>(null)
  const backupInputRef = useRef<HTMLInputElement>(null)

  const ttsSupported = typeof window !== 'undefined' && 'speechSynthesis' in window
  const dictSize = builtinDictionarySize()

  /**
   * 分类入口右侧的当前值摘要。
   *
   * 只放**最常被确认的那一两个值**，不是把所有设置列一遍 ——
   * 列全了就退化成原来的长列表，分类也就白分了。
   */
  const categorySummary = (id: SettingsCategory): string => {
    switch (id) {
      case 'appearance': {
        const theme = THEMES[settings.theme]
        const bits = [theme?.name ?? '纸感']
        if (settings.followSystemDark) bits.push('跟随系统')
        if (settings.eyeCareWarmth > 0) bits.push(`护眼 ${Math.round(settings.eyeCareWarmth * 100)}%`)
        return bits.join(' · ')
      }
      case 'reading': {
        const font = FONT_STACKS[t.fontFamily]?.name ?? ''
        return `${font} · ${t.fontSize}px · 行距 ${t.lineHeight.toFixed(1)} · ${PAGE_MODE_LABELS[settings.pageMode]}`
      }
      case 'speech':
        return ttsSupported
          ? `语速 ${settings.ttsRate.toFixed(1)}× · 音调 ${settings.ttsPitch.toFixed(1)}`
          : '当前环境不支持语音合成'
      case 'dictionary': {
        // 注意：builtinDictionarySize() 返回的是 { zh, en } 而不是一个数字。
        // 直接插值会渲染成「[object Object]」—— 这个错误真的发生过。
        const size = builtinDictionarySize()
        return `内置 中文 ${size.zh} / 英文 ${size.en} 条 · 自定义 ${dicts.length} 部`
      }
      case 'data':
        return '导出 / 导入备份 · 清除全部数据'
      case 'about':
        return '版本 1.0.0 · 浏览器验证器'
    }
  }

  useEffect(() => {
    let cancelled = false
    void db.getDictionaries().then((list) => {
      if (!cancelled) setDicts(list)
    })
    return () => {
      cancelled = true
    }
  }, [])

  // ============================================================
  // 词典导入
  // ============================================================
  const handleDictFile = async (file: File) => {
    try {
      const text = await file.text()
      const parsed = parseUserDictionary(text)
      const zhCount = Object.keys(parsed.zh ?? {}).length
      const enCount = Object.keys(parsed.en ?? {}).length
      if (zhCount + enCount === 0) {
        toast('没有解析出任何词条，请检查文件格式（词条<TAB>拼音<TAB>释义）')
        return
      }
      const entry: StoredDictionary = {
        id: `d_${Date.now().toString(36)}`,
        name: file.name,
        zh: parsed.zh ?? {},
        en: parsed.en ?? {},
        importedAt: Date.now(),
      }
      await db.putDictionary(entry)
      setDicts((prev) => [...prev, entry])
      toast(`已导入 ${zhCount + enCount} 条词条`)
    } catch (e) {
      toast(`导入失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const removeDict = async (id: string) => {
    await db.deleteDictionary(id)
    setDicts((prev) => prev.filter((d) => d.id !== id))
    toast('已删除词典')
  }

  // ============================================================
  // 朗读试听
  // ============================================================

  const speakPreview = () => {
    if (!ttsSupported) {
      toast('当前环境不支持语音合成')
      return
    }
    window.speechSynthesis.cancel()
    const u = new SpeechSynthesisUtterance('剑影长歌，山高水长。少年负剑出门，从此江湖多了一个名字。')
    u.rate = settings.ttsRate
    u.pitch = settings.ttsPitch
    u.lang = 'zh-CN'
    u.onend = () => setSpeaking(false)
    u.onerror = () => setSpeaking(false)
    setSpeaking(true)
    window.speechSynthesis.speak(u)
  }

  const stopPreview = () => {
    if (ttsSupported) window.speechSynthesis.cancel()
    setSpeaking(false)
  }

  // ============================================================
  // 备份
  // ============================================================

  const handleExport = async () => {
    try {
      const payload = await exportBackup(settings)
      const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `moyu-backup-${new Date().toISOString().slice(0, 10)}.json`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      // 释放对象 URL，避免内存泄漏（大书库下这个很重要）
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      toast('备份已导出')
    } catch (e) {
      toast(`导出失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const handleImport = async (file: File) => {
    try {
      const text = await file.text()
      const payload = JSON.parse(text) as BackupPayload
      if (!payload || typeof payload !== 'object' || !Array.isArray(payload.books)) {
        toast('备份文件格式不正确')
        return
      }
      await importBackup(payload)
      await refreshBooks()
      toast(`已恢复 ${payload.books.length} 本书`)
    } catch (e) {
      toast(`导入失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const handleClear = async () => {
    if (!confirmClear) {
      setConfirmClear(true)
      return
    }
    try {
      await clearAll()
      await refreshBooks()
      toast('已清除全部数据')
      setConfirmClear(false)
    } catch (e) {
      toast(`清除失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /** 当前打开的二级页；null 表示停在一级分类列表。 */
  const [page, setPage] = useState<SettingsCategory | null>(null)

  // —— 一级：分类入口 ——
  if (page === null) {
    return (
      <div className="screen">
        <div className="topbar">
          <button aria-label="返回" onClick={onBack}>
            <IconBack />
          </button>
          <div className="topbar__title">设置</div>
          <span style={{ width: 44 }} />
        </div>

        <div className="scroll-area" style={{ paddingBottom: 40 }}>
          <div style={{ padding: '10px 16px 4px' }} className="text-sm text-mute">
            所有设置都即时生效，没有「保存」按钮。
          </div>
          {SETTINGS_CATEGORIES.map((cat) => (
            <button
              key={cat.id}
              type="button"
              className="category-card"
              aria-label={`打开${cat.title}设置`}
              onClick={() => setPage(cat.id)}
            >
              <span className="category-card__icon" aria-hidden="true">
                {cat.icon}
              </span>
              <span className="category-card__body">
                <span className="category-card__title">{cat.title}</span>
                <span className="category-card__summary">{categorySummary(cat.id)}</span>
              </span>
              <IconArrowRight size={17} />
            </button>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="screen">
      <div className="topbar">
        <button aria-label="返回设置分类" onClick={() => setPage(null)}>
          <IconBack />
        </button>
        <div className="topbar__title">
          {SETTINGS_CATEGORIES.find((c) => c.id === page)?.title ?? '设置'}
        </div>
        <span style={{ width: 44 }} />
      </div>

      <div className="scroll-area" style={{ paddingBottom: 40 }}>
        {/* —— 外观 —— */}
        {page === 'appearance' && (
        <div className="setting-group">
          <div className="setting-group__title">外观</div>

          <div style={{ padding: '4px 16px 10px' }}>
            <div className="theme-picker" style={{ padding: '0 0 4px' }}>
              {(Object.keys(THEMES) as ThemeId[]).map((id) => {
                const p = THEMES[id]
                const active = settings.theme === id
                return (
                  <button
                    key={id}
                    className={`theme-swatch ${active ? 'theme-swatch--active' : ''}`}
                    style={{ background: p.background, color: p.text }}
                    onClick={() => updateSettings({ theme: id })}
                    aria-label={`主题 ${p.name}`}
                    aria-pressed={active}
                  >
                    <span>{p.name}</span>
                    {active && <IconCheck size={14} className="theme-swatch__check" style={{ color: p.primary }} />}
                  </button>
                )
              })}
            </div>
          </div>

          <div className="setting-row">
            <span className="setting-row__label">
              跟随系统深色模式
              <div className="setting-row__hint">开启后由系统主题决定，忽略上面的选择</div>
            </span>
            <Switch
              on={settings.followSystemDark}
              onChange={(v) => updateSettings({ followSystemDark: v })}
              label="跟随系统深色模式"
            />
          </div>

          <div className="setting-row">
            <span className="setting-row__label">
              Material You 动态取色
              <div className="setting-row__hint">Android 12+ 跟随壁纸取色；浏览器验证器无法应用，仅保存偏好</div>
            </span>
            <Switch on={settings.dynamicColor} onChange={(v) => updateSettings({ dynamicColor: v })} label="动态取色" />
          </div>

          <div className="setting-row">
            <span className="setting-row__label">
              护眼色温
              <div className="setting-row__hint">
                {settings.eyeCareWarmth === 0 ? '关闭' : `${Math.round(settings.eyeCareWarmth * 100)}%`}
              </div>
            </span>
            <input
              className="slider"
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={settings.eyeCareWarmth}
              onChange={(e) => updateSettings({ eyeCareWarmth: Number(e.target.value) })}
              aria-label="护眼色温"
              style={{ maxWidth: 150 }}
            />
          </div>

          <div className="setting-row">
            <span className="setting-row__label">
              屏幕亮度
              <div className="setting-row__hint">
                {settings.brightness === null ? '跟随系统' : `应用内 ${Math.round(settings.brightness * 100)}%`}
              </div>
            </span>
            <input
              className="slider"
              type="range"
              min={0.15}
              max={1}
              step={0.05}
              value={settings.brightness ?? 1}
              disabled={settings.brightness === null}
              onChange={(e) => updateSettings({ brightness: Number(e.target.value) })}
              aria-label="屏幕亮度"
              style={{ maxWidth: 130 }}
            />
            <button
              className="btn"
              style={{ minHeight: 34 }}
              onClick={() => updateSettings({ brightness: settings.brightness === null ? 0.7 : null })}
            >
              {settings.brightness === null ? '调节' : '跟随'}
            </button>
          </div>
        </div>
        )}

        {/* —— 阅读 —— */}
        {page === 'reading' && (
        <div className="setting-group">
          <div className="setting-group__title">阅读</div>

          <div className="setting-row" style={{ alignItems: 'flex-start', flexDirection: 'column', gap: 8 }}>
            <span className="setting-row__label">字体</span>
            <div className="chip-row" style={{ padding: 0, flexWrap: 'wrap' }}>
              {(Object.keys(FONT_STACKS) as FontFamilyId[]).map((id) => (
                <button
                  key={id}
                  className={`chip ${t.fontFamily === id ? 'chip--active' : ''}`}
                  style={{ fontFamily: FONT_STACKS[id].css }}
                  onClick={() => updateSettings({ typography: { ...t, fontFamily: id } })}
                >
                  {FONT_STACKS[id].name}
                </button>
              ))}
            </div>
          </div>

          <StepperRow
            label="字号"
            value={t.fontSize}
            min={12}
            max={34}
            format={(v) => `${v}px`}
            onChange={(v) => updateSettings({ typography: { ...t, fontSize: v } })}
          />
          <StepperRow
            label="行距"
            value={t.lineHeight}
            min={1.2}
            max={2.6}
            step={0.1}
            format={(v) => v.toFixed(1)}
            onChange={(v) => updateSettings({ typography: { ...t, lineHeight: v } })}
          />
          <StepperRow
            label="段间距"
            value={t.paragraphSpacing}
            min={0}
            max={2}
            step={0.2}
            format={(v) => v.toFixed(1)}
            onChange={(v) => updateSettings({ typography: { ...t, paragraphSpacing: v } })}
          />
          <StepperRow
            label="页边距"
            value={t.margin}
            min={8}
            max={48}
            step={2}
            format={(v) => `${v}px`}
            onChange={(v) => updateSettings({ typography: { ...t, margin: v } })}
          />
          <StepperRow
            label="首行缩进"
            value={t.indent}
            min={0}
            max={4}
            step={0.5}
            format={(v) => (v === 0 ? '无' : `${v} 字`)}
            onChange={(v) => updateSettings({ typography: { ...t, indent: v } })}
          />

          <div className="setting-row">
            <span className="setting-row__label">两端对齐</span>
            <Switch on={t.justify} onChange={(v) => updateSettings({ typography: { ...t, justify: v } })} label="两端对齐" />
          </div>
          <div className="setting-row">
            <span className="setting-row__label">正文加粗</span>
            <Switch on={t.bold} onChange={(v) => updateSettings({ typography: { ...t, bold: v } })} label="正文加粗" />
          </div>

          <div className="setting-row" style={{ alignItems: 'flex-start', flexDirection: 'column', gap: 8 }}>
            <span className="setting-row__label">翻页方式</span>
            <div className="chip-row" style={{ padding: 0, flexWrap: 'wrap' }}>
              {(Object.keys(PAGE_MODE_LABELS) as PageMode[]).map((mode) => (
                <button
                  key={mode}
                  className={`chip ${settings.pageMode === mode ? 'chip--active' : ''}`}
                  onClick={() => updateSettings({ pageMode: mode })}
                >
                  {PAGE_MODE_LABELS[mode]}
                </button>
              ))}
            </div>
          </div>

          <div className="setting-row">
            <span className="setting-row__label">
              自动阅读速度
              <div className="setting-row__hint">{settings.autoReadSpeed} 字/秒</div>
            </span>
            <input
              className="slider"
              type="range"
              min={8}
              max={120}
              step={2}
              value={settings.autoReadSpeed}
              onChange={(e) => updateSettings({ autoReadSpeed: Number(e.target.value) })}
              aria-label="自动阅读速度"
              style={{ maxWidth: 150 }}
            />
          </div>

          <div className="setting-row">
            <span className="setting-row__label">阅读时常亮</span>
            <Switch on={settings.keepScreenOn} onChange={(v) => updateSettings({ keepScreenOn: v })} label="阅读时常亮" />
          </div>
          <div className="setting-row">
            <span className="setting-row__label">显示状态栏信息</span>
            <Switch
              on={settings.showStatusBar}
              onChange={(v) => updateSettings({ showStatusBar: v })}
              label="显示状态栏信息"
            />
          </div>
        </div>
        )}

        {/* —— 朗读 —— */}
        {page === 'speech' && (
        <div className="setting-group">
          <div className="setting-group__title">朗读（TTS）</div>
          {!ttsSupported && (
            <div className="setting-row">
              <span className="setting-row__label text-mute">当前环境不支持语音合成</span>
            </div>
          )}
          <div className="setting-row">
            <span className="setting-row__label">
              语速
              <div className="setting-row__hint">{settings.ttsRate.toFixed(1)}×</div>
            </span>
            <input
              className="slider"
              type="range"
              min={0.5}
              max={2}
              step={0.1}
              value={settings.ttsRate}
              onChange={(e) => updateSettings({ ttsRate: Number(e.target.value) })}
              aria-label="朗读语速"
              style={{ maxWidth: 150 }}
            />
          </div>
          <div className="setting-row">
            <span className="setting-row__label">
              音调
              <div className="setting-row__hint">{settings.ttsPitch.toFixed(1)}</div>
            </span>
            <input
              className="slider"
              type="range"
              min={0}
              max={2}
              step={0.1}
              value={settings.ttsPitch}
              onChange={(e) => updateSettings({ ttsPitch: Number(e.target.value) })}
              aria-label="朗读音调"
              style={{ maxWidth: 150 }}
            />
          </div>
          <div className="setting-row">
            <span className="setting-row__label">试听</span>
            <button className="btn" onClick={speaking ? stopPreview : speakPreview} disabled={!ttsSupported}>
              <IconSpeaker size={17} />
              {speaking ? '停止' : '试听'}
            </button>
          </div>
        </div>
        )}

        {/* —— 词典 —— */}
        {page === 'dictionary' && (
        <div className="setting-group">
          <div className="setting-group__title">词典</div>
          <div className="setting-row">
            <span className="setting-row__label">
              内置词典
              <div className="setting-row__hint">离线可用，无需联网</div>
            </span>
            <span className="setting-row__value">
              中文 {dictSize.zh} 条、英文 {dictSize.en} 条
            </span>
          </div>
          <div className="setting-row">
            <span className="setting-row__label">
              自定义词典
              <div className="setting-row__hint">每行一条：词条&lt;TAB&gt;拼音&lt;TAB&gt;释义</div>
            </span>
            <button className="btn" onClick={() => dictInputRef.current?.click()}>
              <IconUpload size={17} />
              导入
            </button>
            <input
              ref={dictInputRef}
              type="file"
              accept=".txt,.dict,text/plain"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) void handleDictFile(f)
                e.target.value = ''
              }}
            />
          </div>
          {dicts.map((d) => (
            <div className="setting-row" key={d.id}>
              <span className="setting-row__label">
                <IconDictionary size={15} style={{ verticalAlign: '-3px', marginRight: 6 }} />
                {d.name}
                <div className="setting-row__hint">
                  中文 {Object.keys(d.zh).length} 条、英文 {Object.keys(d.en).length} 条
                </div>
              </span>
              <button className="btn btn--danger" aria-label={`删除词典 ${d.name}`} onClick={() => void removeDict(d.id)}>
                <IconTrash size={16} />
              </button>
            </div>
          ))}
        </div>
        )}

        {/* —— 数据 —— */}
        {page === 'data' && (
        <div className="setting-group">
          <div className="setting-group__title">数据</div>
          <div className="setting-row">
            <span className="setting-row__label">
              导出备份
              <div className="setting-row__hint">含书库、章节、进度、书签笔记与设置</div>
            </span>
            <button className="btn" onClick={() => void handleExport()}>
              导出
            </button>
          </div>
          <div className="setting-row">
            <span className="setting-row__label">导入备份</span>
            <button className="btn" onClick={() => backupInputRef.current?.click()}>
              <IconUpload size={17} />
              选择文件
            </button>
            <input
              ref={backupInputRef}
              type="file"
              accept="application/json,.json"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) void handleImport(f)
                e.target.value = ''
              }}
            />
          </div>
          <div className="setting-row">
            <span className="setting-row__label">
              清除全部数据
              <div className="setting-row__hint">会删除所有书籍、进度、笔记与设置，不可恢复</div>
            </span>
            <button className="btn btn--danger" onClick={() => void handleClear()}>
              {confirmClear ? '确认清除' : '清除'}
            </button>
          </div>
          {confirmClear && (
            <div className="setting-row">
              <span className="setting-row__label text-mute text-sm">再点一次「确认清除」以执行，或取消。</span>
              <button className="btn" onClick={() => setConfirmClear(false)}>
                取消
              </button>
            </div>
          )}
        </div>
        )}

        {/* —— 关于 —— */}
        {page === 'about' && (
        <div className="setting-group">
          <div className="setting-group__title">关于</div>
          <div className="setting-row">
            <span className="setting-row__label">
              墨阅 · 本地阅读器
              <div className="setting-row__hint">版本 1.0.0 · 浏览器验证器</div>
            </span>
          </div>
          <div style={{ padding: '0 16px 14px' }} className="text-sm text-mute">
            <p style={{ display: 'flex', gap: 7, alignItems: 'flex-start', margin: '0 0 8px' }}>
              <IconLightbulb size={16} style={{ flexShrink: 0, marginTop: 2 }} />
              <span>
                这是 Android 版「墨阅」的算法与交互验证器。两者共用同一套核心引擎规范：
                编码识别、自动分章、分页排版、全文搜索、进度换算、阅读统计。
                在此页验证通过的行为，是 Android 端实现的依据。
              </span>
            </p>
            <p style={{ display: 'flex', gap: 7, alignItems: 'flex-start', margin: 0 }}>
              <IconEye size={16} style={{ flexShrink: 0, marginTop: 2 }} />
              <span>
                数据全部保存在本机浏览器（IndexedDB），不上传任何内容。
                导出的备份文件也只落在你自己的磁盘上。
              </span>
            </p>
          </div>
        </div>
        )}

        <div style={{ padding: '10px 16px 30px' }}>
          <button
            className="btn btn--block"
            onClick={() => {
              void refreshBooks()
              toast('已刷新书库')
            }}
          >
            <IconRefresh size={17} />
            刷新书库
          </button>
        </div>
      </div>
    </div>
  )
}

// ============================================================
// 子组件
// ============================================================

function StepperRow({
  label,
  value,
  min,
  max,
  step = 1,
  format,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  step?: number
  format?: (v: number) => string
  onChange: (v: number) => void
}) {
  const clamp = (v: number) => Math.min(max, Math.max(min, Math.round(v / step) * step))
  return (
    <div className="setting-row">
      <span className="setting-row__label">{label}</span>
      <div className="stepper">
        <button aria-label={`减小${label}`} onClick={() => onChange(clamp(value - step))} disabled={value <= min}>
          <IconMinus size={17} />
        </button>
        <span className="stepper__value">{format ? format(value) : value}</span>
        <button aria-label={`增大${label}`} onClick={() => onChange(clamp(value + step))} disabled={value >= max}>
          <IconPlus size={17} />
        </button>
      </div>
    </div>
  )
}

function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      className={`switch ${on ? 'switch--on' : ''}`}
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
    />
  )
}
