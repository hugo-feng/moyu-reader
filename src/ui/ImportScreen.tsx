/**
 * 导入页：本地文件 → 书架。
 *
 * 三条导入路径的诚实程度不同，代码里刻意区分开：
 *   - TXT：完整支持。字节级编码探测（UTF-8 / GB18030 / UTF-16），
 *     识别不确定时给出「手工切换编码 + 前 200 字预览」的补救入口；
 *   - EPUB：完整支持。解析交给开源库 epubjs（见 engine/epub.ts），
 *     我们只负责把它的输出映射到墨阅的章节模型；
 *   - PDF：只建立书库记录（format: 'pdf'）+ 一个说明性章节，
 *     不假装提取了 PDF 文本（原生端是整页图片渲染）。
 *
 * 进度用组件本地状态维护，不写回全局 store —— 导入是一次性的页面级流程，
 * 放进全局状态只会让 store 多一份需要清理的临时数据。
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { Book, BookFormat, Chapter, TextEncoding } from '../engine/types'
import { decodeAs, detectAndDecode, scoreDecoding } from '../engine/encoding'
import { epubToBook, parseEpub } from '../engine/epub'
import { buildBookFromText, getAllBooks, saveBookWithChapters } from '../storage'
import {
  createGroup,
  refreshBooks,
  removeGroup,
  toast,
  useAppState,
  type ImportProgress,
} from '../store'
import { IconBack, IconFolder, IconUpload } from './icons'

export interface ImportScreenProps {
  onBack: () => void
}

/** 编码手工切换时的候选项，顺序按中文小说的实际出现频率排列。 */
const ENCODING_CHOICES: Array<{ value: TextEncoding; label: string }> = [
  { value: 'utf-8', label: 'UTF-8' },
  { value: 'gb18030', label: 'GB18030 / GBK' },
  { value: 'utf-16le', label: 'UTF-16 LE' },
  { value: 'utf-16be', label: 'UTF-16 BE' },
]

const PREVIEW_LENGTH = 200

interface FailedText {
  fileName: string
  bytes: Uint8Array
  detected: TextEncoding
  uncertain: boolean
}

function extOf(name: string): string {
  const m = /\.([^.]+)$/.exec(name.toLowerCase())
  return m ? m[1] : ''
}

function formatOf(name: string): BookFormat | null {
  const ext = extOf(name)
  if (ext === 'txt') return 'txt'
  if (ext === 'epub') return 'epub'
  if (ext === 'pdf') return 'pdf'
  return null
}

export function ImportScreen({ onBack }: ImportScreenProps) {
  const { books, groups, ready } = useAppState()

  const [over, setOver] = useState(false)
  const [items, setItems] = useState<ImportProgress['items']>([])
  const [busy, setBusy] = useState(false)
  const [failedTexts, setFailedTexts] = useState<FailedText[]>([])
  const [encodingFile, setEncodingFile] = useState<string | null>(null)
  const [encodingPick, setEncodingPick] = useState<TextEncoding>('gb18030')

  const fileInput = useRef<HTMLInputElement | null>(null)
  const folderInput = useRef<HTMLInputElement | null>(null)

  /** 降级标记：非标准属性只能命令式设置。 */
  useEffect(() => {
    const el = folderInput.current
    if (el) {
      el.setAttribute('webkitdirectory', '')
      el.setAttribute('directory', '')
    }
  }, [])

  const folderSupported = useMemo(() => {
    if (typeof document === 'undefined') return false
    return 'webkitdirectory' in document.createElement('input')
  }, [])

  const doneCount = items.filter((i) => i.status === 'ok').length
  const failedCount = items.filter((i) => i.status === 'error').length
  const dupCount = items.filter((i) => i.status === 'duplicate').length
  const total = items.length
  const pct = total === 0 ? 0 : Math.round(((doneCount + failedCount + dupCount) / total) * 100)

  const updateItem = (index: number, patch: Partial<ImportProgress['items'][number]>) => {
    setItems((prev) => prev.map((it, i) => (i === index ? { ...it, ...patch } : it)))
  }

  const markStatus = (index: number, status: 'ok' | 'error' | 'duplicate', message: string) => {
    updateItem(index, { status, message })
  }

  /** 重复判定：书名 + 全书字数完全一致即视为同一本书。 */
  const isDuplicate = (title: string, charCount: number, existing: Book[]): boolean =>
    existing.some((b) => b.title === title && b.charCount === charCount)

  const importTxt = async (
    index: number,
    name: string,
    bytes: Uint8Array,
    encoding?: TextEncoding,
  ): Promise<void> => {
    const decode = encoding ? decodeAs(bytes, encoding) : detectAndDecode(bytes)
    const existing = await getAllBooks()
    const id = `b_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
    const { book, chapters } = buildBookFromText({
      id,
      fileName: name,
      text: decode.text,
      encoding: decode.encoding,
    })

    if (book.charCount === 0) {
      markStatus(index, 'error', '文件内容为空')
      return
    }

    if (isDuplicate(book.title, book.charCount, existing)) {
      markStatus(index, 'duplicate', '书架中已有同名同字数的书')
      return
    }

    await saveBookWithChapters(book, chapters)
    await refreshBooks()

    const hint = decode.uncertain ? `${decode.encoding}，编码识别可能不准确` : decode.encoding
    markStatus(index, 'ok', `${book.chapterCount} 章、${book.charCount} 字、${hint}`)
  }

  const importEpub = async (index: number, name: string, bytes: Uint8Array): Promise<void> => {
    const parsed = await parseEpub({ bytes, fallbackTitle: name.replace(/\.[^.]+$/, '') })
    const id = `b_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`

    // 封面已由解析层转成 dataURL，可直接持久化（无需再做 base64 转换）
    const book = epubToBook(parsed, { id, addedAt: Date.now() })
    const chapters: Chapter[] = parsed.chapters.map((c, i) => ({ ...c, index: i, bookId: id }))

    const existing = await getAllBooks()
    if (isDuplicate(book.title, book.charCount, existing)) {
      markStatus(index, 'duplicate', '书架中已有同名同字数的书')
      return
    }

    await saveBookWithChapters({ ...book, chapterCount: chapters.length }, chapters)
    await refreshBooks()

    const warn = parsed.warnings.length > 0 ? `，${parsed.warnings[0]}` : ''
    markStatus(index, 'ok', `${chapters.length} 章、EPUB${warn}`)
  }

  const importPdf = async (index: number, name: string): Promise<void> => {
    const existing = await getAllBooks()
    const id = `b_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`

    const placeholder =
      '［PDF 文档］\n\n' +
      'PDF 未做文本提取。墨阅把 PDF 作为整页图片排版渲染，' +
      '因此本条目只保存书库记录与阅读位置；具体页面请在原生端查看。\n' +
      '如需在 Web 验证器中阅读文字内容，请导入该书的 TXT 或 EPUB 版本。'

    const built = buildBookFromText({
      id,
      fileName: name,
      text: placeholder,
      encoding: 'utf-8',
    })
    const chapters: Chapter[] = built.chapters.map((c, i) => ({ ...c, index: i, bookId: id }))
    const book: Book = {
      ...built.book,
      format: 'pdf',
      title: built.book.title,
      chapterCount: chapters.length,
    }

    if (isDuplicate(book.title, book.charCount, existing)) {
      markStatus(index, 'duplicate', '书架中已有同名同字数的书')
      return
    }

    await saveBookWithChapters(book, chapters)
    await refreshBooks()
    markStatus(index, 'ok', 'PDF 仅建立记录（正文为占位说明）')
  }

  /** 串行处理：便于逐条反馈进度，也避免同时写 IndexedDB 造成事务争用。 */
  const handleFiles = async (fileList: FileList | File[]) => {
    const files = Array.from(fileList)
    if (files.length === 0 || busy) return

    const startIndex = items.length
    setBusy(true)
    setItems((prev) => [
      ...prev,
      ...files.map((f) => ({ name: f.name, status: 'pending' as const, message: '等待导入' })),
    ])

    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      const index = startIndex + i
      const kind = formatOf(file.name)

      try {
        if (!kind) {
          markStatus(index, 'error', '不支持的格式（仅支持 TXT / EPUB / PDF）')
          continue
        }
        if (file.size === 0) {
          markStatus(index, 'error', '文件为空')
          continue
        }

        if (kind === 'txt') {
          const bytes = new Uint8Array(await file.arrayBuffer())
          const probe = detectAndDecode(bytes)
          const replacementRatio = probe.text.length > 0 ? probe.replacementCount / probe.text.length : 0
          const probablyGarbled = probe.uncertain || replacementRatio > 0.02
          await importTxt(index, file.name, bytes)
          if (probablyGarbled) {
            setFailedTexts((prev) => [
              ...prev.filter((f) => f.fileName !== file.name),
              { fileName: file.name, bytes, detected: probe.encoding, uncertain: true },
            ])
          }
          continue
        }

        if (kind === 'epub') {
          const bytes = new Uint8Array(await file.arrayBuffer())
          await importEpub(index, file.name, bytes)
          continue
        }

        await importPdf(index, file.name)
      } catch (e) {
        markStatus(index, 'error', e instanceof Error ? e.message : String(e))
      }
    }

    setBusy(false)
  }

  /** 用户在编码面板确认后重新导入同一个文件。 */
  const reimportWithEncoding = async (entry: FailedText) => {
    if (busy) return
    setBusy(true)
    const index = items.length
    setItems((prev) => [
      ...prev,
      { name: `${entry.fileName}（按 ${encodingPick} 重新导入）`, status: 'pending', message: '等待导入' },
    ])
    try {
      await importTxt(index, entry.fileName, entry.bytes, encodingPick)
      setFailedTexts((prev) => prev.filter((f) => f.fileName !== entry.fileName))
      setEncodingFile(null)
    } catch (e) {
      markStatus(index, 'error', e instanceof Error ? e.message : String(e))
    }
    setBusy(false)
  }

  const createGroupFromImport = async () => {
    const name = window.prompt('新分组名称')
    if (!name || name.trim().length === 0) return
    try {
      await createGroup(name.trim(), '#8a6a46')
      toast('已创建分组')
    } catch (e) {
      toast(`创建分组失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const currentFailed = failedTexts.find((f) => f.fileName === encodingFile) ?? null

  return (
    <div className="screen">
      <div className="topbar">
        <button type="button" className="btn btn--ghost" onClick={onBack} aria-label="返回书架">
          <IconBack size={20} />
        </button>
        <div className="topbar__title">导入书籍</div>
      </div>

      <div className="scroll-area">
        {/* —— 拖放区 —— */}
        <div
          className={`dropzone${over ? ' dropzone--over' : ''}`}
          onClick={() => fileInput.current?.click()}
          onDragOver={(e) => {
            e.preventDefault()
            setOver(true)
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault()
            setOver(false)
            if (e.dataTransfer?.files) void handleFiles(e.dataTransfer.files)
          }}
        >
          <IconUpload size={34} />
          <div className="dropzone__title">点击选择文件，或拖拽到这里</div>
          <div className="dropzone__hint">
            支持 TXT（自动识别 UTF-8 / GB18030 / UTF-16）与 EPUB；
            PDF 仅建立书库记录，不做文本提取。
          </div>
        </div>

        <div className="row" style={{ gap: 10, padding: '0 16px 4px', flexWrap: 'wrap' }}>
          <button type="button" className="btn btn--primary" onClick={() => fileInput.current?.click()} disabled={busy}>
            <IconUpload size={17} />
            选择文件
          </button>
          {folderSupported ? (
            <button type="button" className="btn" onClick={() => folderInput.current?.click()} disabled={busy}>
              <IconFolder size={17} />
              选择文件夹
            </button>
          ) : null}
          <button type="button" className="btn" onClick={() => void createGroupFromImport()} disabled={busy}>
            新建分组
          </button>
          {groups.length > 0 ? (
            <span className="text-mute text-sm" style={{ alignSelf: 'center' }}>
              已有 {groups.length} 个分组
            </span>
          ) : null}
        </div>

        {groups.length > 0 ? (
          <div className="chip-row" style={{ paddingTop: 8 }} aria-label="管理分组">
            {groups.map((g) => (
              <button
                key={g.id}
                type="button"
                className="chip"
                onClick={() => {
                  void removeGroup(g.id).then(() => toast(`已删除分组「${g.name}」`))
                }}
                aria-label={`删除分组 ${g.name}`}
              >
                <span style={{ width: 8, height: 8, borderRadius: 99, background: g.color }} aria-hidden="true" />
                {g.name} ×
              </button>
            ))}
          </div>
        ) : null}

        <input
          ref={fileInput}
          type="file"
          multiple
          accept=".txt,.epub,.pdf,text/plain,application/epub+zip,application/pdf"
          hidden
          aria-label="选择要导入的文件"
          onChange={(e) => {
            if (e.target.files) void handleFiles(e.target.files)
            e.target.value = ''
          }}
        />
        {folderSupported ? (
          <input
            ref={folderInput}
            type="file"
            multiple
            hidden
            aria-label="选择要导入的文件夹"
            onChange={(e) => {
              if (e.target.files) void handleFiles(e.target.files)
              e.target.value = ''
            }}
          />
        ) : null}

        {/* —— 进度 —— */}
        {total > 0 ? (
          <div style={{ padding: '14px 16px 6px' }}>
            <div className="row row--between" style={{ marginBottom: 8 }}>
              <span className="text-sm text-mute">
                {busy ? '正在导入…' : '导入完成'}，共 {total} 个文件
              </span>
              <span className="text-sm text-mute">
                成功 {doneCount}、重复 {dupCount}、失败 {failedCount}
              </span>
            </div>
            <div style={{ height: 4, background: 'var(--line-strong)', borderRadius: 99 }}>
              <i
                style={{
                  display: 'block',
                  height: '100%',
                  width: `${pct}%`,
                  background: 'var(--accent)',
                  borderRadius: 99,
                }}
              />
            </div>
          </div>
        ) : null}

        {items.length > 0 ? (
          <div className="card card--flat" style={{ margin: '12px 16px 0', overflow: 'hidden' }}>
            {items.map((it, i) => (
              <div className="import-row" key={`${it.name}-${i}`}>
                <span className="import-row__name">{it.name}</span>
                <span
                  className={`import-row__status${
                    it.status === 'ok' ? ' import-row__status--ok' : it.status === 'error' ? ' import-row__status--err' : ''
                  }`}
                >
                  {it.status === 'ok'
                    ? it.message ?? '已导入'
                    : it.status === 'error'
                      ? it.message ?? '失败'
                      : it.status === 'duplicate'
                        ? it.message ?? '重复'
                        : it.message ?? '等待中'}
                </span>
              </div>
            ))}
          </div>
        ) : null}

        {/* —— 编码补救 —— */}
        {failedTexts.length > 0 ? (
          <div className="card" style={{ margin: '16px 16px 0', padding: 14 }}>
            <div className="row row--between" style={{ marginBottom: 8 }}>
              <span style={{ fontWeight: 600, fontSize: 13.5 }}>编码识别可能不准确</span>
              <span className="text-sm text-mute">{failedTexts.length} 个文件</span>
            </div>
            <div className="text-sm text-mute" style={{ lineHeight: 1.7, marginBottom: 10 }}>
              如果正文出现大量乱码或「□」，请手工选择正确编码后重新导入（文件已在内存中，无需再次选择）。
            </div>

            {failedTexts.map((f) => (
              <div key={f.fileName} style={{ marginBottom: 8 }}>
                <div className="row row--between" style={{ gap: 8 }}>
                  <span className="truncate grow text-sm">{f.fileName}</span>
                  <button
                    type="button"
                    className="btn"
                    style={{ flexShrink: 0 }}
                    onClick={() => {
                      setEncodingFile(encodingFile === f.fileName ? null : f.fileName)
                      setEncodingPick(f.detected)
                    }}
                    aria-label={`为 ${f.fileName} 手动选择编码`}
                  >
                    {encodingFile === f.fileName ? '收起' : '手动选择编码'}
                  </button>
                </div>
                <div className="text-sm text-mute" style={{ marginTop: 2 }}>
                  当前判定：{f.detected}
                  {f.uncertain ? '，识别置信度低' : ''}
                </div>
              </div>
            ))}

            {currentFailed ? (
              <div style={{ marginTop: 12, borderTop: '1px solid var(--line)', paddingTop: 12 }}>
                <div className="segmented" role="group" aria-label="选择编码" style={{ marginBottom: 10 }}>
                  {ENCODING_CHOICES.map((c) => (
                    <button
                      key={c.value}
                      type="button"
                      className={encodingPick === c.value ? 'segmented__item--active' : undefined}
                      aria-pressed={encodingPick === c.value}
                      onClick={() => setEncodingPick(c.value)}
                    >
                      {c.label}
                    </button>
                  ))}
                </div>

                <div
                  style={{
                    fontFamily: 'var(--font-serif)',
                    fontSize: 13,
                    lineHeight: 1.8,
                    background: 'var(--paper-raise)',
                    borderRadius: 'var(--radius-sm)',
                    padding: '10px 12px',
                    maxHeight: 160,
                    overflowY: 'auto',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                  }}
                >
                  {decodeAs(currentFailed.bytes, encodingPick).text.slice(0, PREVIEW_LENGTH) || '（无内容）'}
                </div>

                <div className="text-sm text-mute" style={{ marginTop: 8 }}>
                  各编码可读性评分：
                  {ENCODING_CHOICES.map((c) => (
                    <span key={c.value} style={{ marginLeft: 8 }}>
                      {c.label} {scoreDecoding(currentFailed.bytes, c.value).toFixed(2)}
                    </span>
                  ))}
                </div>

                <div className="modal__actions" style={{ marginTop: 12 }}>
                  <button type="button" className="btn" onClick={() => setEncodingFile(null)}>
                    取消
                  </button>
                  <button
                    type="button"
                    className="btn btn--primary"
                    disabled={busy}
                    onClick={() => void reimportWithEncoding(currentFailed)}
                  >
                    按此编码重新导入
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        ) : null}

        {/* —— 说明 —— */}
        <div className="text-sm text-mute" style={{ padding: '18px 16px 90px', lineHeight: 1.8 }}>
          {ready
            ? `书架现有 ${books.length} 本、${groups.length} 个分组。`
            : '正在读取书库…'}
          <br />
          重复判定规则：书名与全书字数完全一致时视为同一本书，将跳过导入。
          <br />
          TXT 使用严格字节校验识别编码，不做「猜测式」解码；识别不确定时会在此处提示。
        </div>
      </div>
    </div>
  )
}
