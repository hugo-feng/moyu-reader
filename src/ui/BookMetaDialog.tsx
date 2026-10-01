/**
 * 书籍信息编辑对话框。
 *
 * 可编辑：书名 / 作者 / 简介 / 分组 / 封面 / 是否读完。
 * 只读：格式、编码、字数、章节数、加入时间 —— 这些是解析结果，
 * 手工改会让书库元数据与真实内容脱节，所以只展示不允许改。
 *
 * 封面走 FileReader → dataURL 存进 `book.cover`：不引入图片裁剪/压缩依赖，
 * 但上限 4MB，避免一张手机原图把 IndexedDB 记录撑到几十 MB。
 */

import { useState } from 'react'
import type { Book } from '../engine/types'
import { updateBookMeta, useAppState, toast } from '../store'
import { coverGradient } from './BookCover'

export interface BookMetaDialogProps {
  book: Book
  onClose: () => void
}

const MAX_COVER_BYTES = 4 * 1024 * 1024

const FORMAT_LABEL: Record<Book['format'], string> = {
  txt: 'TXT 纯文本',
  epub: 'EPUB 电子书',
  pdf: 'PDF 文档',
}

/** 千分位分隔，中文界面里比 `toLocaleString` 更可控。 */
function withThousands(value: number): string {
  return value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

function formatDate(timestamp: number): string {
  const d = new Date(timestamp)
  const pad = (n: number) => `${n}`.padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function BookMetaDialog({ book, onClose }: BookMetaDialogProps) {
  const { groups } = useAppState()

  const [title, setTitle] = useState(book.title)
  const [author, setAuthor] = useState(book.author)
  const [intro, setIntro] = useState(book.intro)
  const [groupId, setGroupId] = useState<string>(book.groupId ?? '')
  const [cover, setCover] = useState<string | undefined>(book.cover)
  const [finished, setFinished] = useState(book.finished)
  const [saving, setSaving] = useState(false)

  const onPickCover = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    if (!file.type.startsWith('image/')) {
      toast('请选择图片文件')
      return
    }
    if (file.size > MAX_COVER_BYTES) {
      toast('图片过大（上限 4MB），请先压缩')
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') setCover(reader.result)
    }
    reader.onerror = () => toast('封面读取失败')
    reader.readAsDataURL(file)
  }

  const handleSave = async () => {
    if (saving) return
    const trimmed = title.trim()
    if (trimmed.length === 0) {
      toast('书名不能为空')
      return
    }
    setSaving(true)
    try {
      await updateBookMeta(book.id, {
        title: trimmed,
        author: author.trim() || '佚名',
        intro: intro.trim(),
        groupId: groupId === '' ? undefined : groupId,
        cover,
        finished,
      })
      toast('已保存')
      onClose()
    } catch (e) {
      toast(`保存失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSaving(false)
    }
  }

  const groupName = groups.find((g) => g.id === book.groupId)?.name ?? '未分组'

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="编辑书籍信息" onClick={onClose}>
      <div className="modal__panel" onClick={(e) => e.stopPropagation()}>
        <div className="modal__title">编辑书籍信息</div>
        <div className="modal__desc">修改只影响书架展示，不会改动书籍正文。</div>

        {/* —— 封面 —— */}
        <div className="field">
          <span className="field__label">封面</span>
          <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
            <div
              style={{
                width: 76,
                aspectRatio: '3 / 4.3',
                borderRadius: '5px 12px 12px 5px',
                overflow: 'hidden',
                position: 'relative',
                background: coverGradient(title || book.title),
                boxShadow: 'var(--shadow-2)',
                flexShrink: 0,
              }}
              aria-hidden="true"
            >
              {cover ? (
                <img
                  src={cover}
                  alt=""
                  style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}
                />
              ) : null}
            </div>
            <div className="stack" style={{ gap: 8, flex: 1, minWidth: 0 }}>
              <label className="btn" style={{ cursor: 'pointer', justifyContent: 'center' }}>
                上传封面图片
                <input type="file" accept="image/*" hidden onChange={onPickCover} aria-label="上传封面图片" />
              </label>
              <button
                type="button"
                className="btn"
                onClick={() => setCover(undefined)}
                disabled={cover === undefined}
                aria-label="恢复默认封面"
              >
                恢复默认封面
              </button>
              <span className="text-sm text-mute">无封面时按书名生成固定渐变书脊。</span>
            </div>
          </div>
        </div>

        {/* —— 书名 —— */}
        <div className="field">
          <label className="field__label" htmlFor="book-meta-title">
            书名
          </label>
          <input id="book-meta-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} />
        </div>

        {/* —— 作者 —— */}
        <div className="field">
          <label className="field__label" htmlFor="book-meta-author">
            作者
          </label>
          <input id="book-meta-author" value={author} onChange={(e) => setAuthor(e.target.value)} maxLength={60} />
        </div>

        {/* —— 简介 —— */}
        <div className="field">
          <label className="field__label" htmlFor="book-meta-intro">
            简介
          </label>
          <textarea
            id="book-meta-intro"
            value={intro}
            onChange={(e) => setIntro(e.target.value)}
            rows={4}
            maxLength={2000}
            placeholder="写一句这本书是什么，便于日后在书架上辨认"
            style={{ resize: 'vertical', lineHeight: 1.7 }}
          />
        </div>

        {/* —— 分组 —— */}
        <div className="field">
          <label className="field__label" htmlFor="book-meta-group">
            分组
          </label>
          <select id="book-meta-group" value={groupId} onChange={(e) => setGroupId(e.target.value)}>
            <option value="">不分组</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </div>

        {/* —— 标记已读完 —— */}
        <div className="field row" style={{ gap: 12, alignItems: 'flex-start' }}>
          <span className="grow">
            <span className="field__label" style={{ marginBottom: 0 }}>
              标记为已读完
            </span>
            <span className="text-sm text-mute" style={{ display: 'block' }}>
              已读完的书不计入「在读」筛选
            </span>
          </span>
          <button
            type="button"
            className={`switch${finished ? ' switch--on' : ''}`}
            role="switch"
            aria-checked={finished}
            aria-label="标记为已读完"
            onClick={() => setFinished((v) => !v)}
          />
        </div>

        {/* —— 只读信息 —— */}
        <div
          style={{
            borderTop: '1px solid var(--line)',
            marginTop: 16,
            paddingTop: 12,
            fontSize: 12.5,
            color: 'var(--ink-mute)',
            lineHeight: 1.9,
          }}
        >
          <div className="row row--between">
            <span>格式</span>
            <span>{FORMAT_LABEL[book.format] ?? book.format}</span>
          </div>
          <div className="row row--between">
            <span>编码</span>
            <span>{book.encoding}</span>
          </div>
          <div className="row row--between">
            <span>字数</span>
            <span style={{ fontVariantNumeric: 'tabular-nums' }}>{withThousands(book.charCount)} 字</span>
          </div>
          <div className="row row--between">
            <span>章节数</span>
            <span>{book.chapterCount} 章</span>
          </div>
          <div className="row row--between">
            <span>分组</span>
            <span className="truncate">{groupName}</span>
          </div>
          <div className="row row--between">
            <span>加入时间</span>
            <span>{formatDate(book.addedAt)}</span>
          </div>
        </div>

        <div className="modal__actions">
          <button type="button" className="btn" onClick={onClose} disabled={saving}>
            取消
          </button>
          <button type="button" className="btn btn--primary" onClick={() => void handleSave()} disabled={saving}>
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}
