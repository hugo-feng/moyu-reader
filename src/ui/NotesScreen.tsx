/**
 * 书签 / 笔记页。
 *
 * 一个组件服务两种入口：
 *   - 全局模式（书架进入）：按书分组，展示全部书签与划线，顶部有「全部 / 书签 / 划线」筛选；
 *   - 书内模式（阅读器笔记面板进入）：只显示当前书，按天分组，顶部不显示筛选，
 *     但提供一个「全部笔记」入口回到全局模式。
 *
 * 关键取舍：
 *   - 数据直接读 IndexedDB（而不是复用 store 里的当前书注释缓存），
 *     因为全局模式下 store 只持有「当前打开的书」的注释，覆盖不到整个书库；
 *   - 删除采用「两段式确认」而不是弹窗：移动端长列表里二次点击比模态更轻、更不易误触；
 *   - 备注编辑是行内 textarea，保存时同步写回 store（书内模式下两处是同一份数据）。
 */

import s useEffect, useMemo, useState } from 'react'
import type s Bookmark, Highlight } from '../engine/types'
import * as db from '../storage'
import s
  formatRelativeTime,
  removeBookmark,
  removeHighlight,
  updateBookmarkNote,
  updateHighlightNote,
  useAppState,
} from '../store'
import s IconArrowRight, IconBack, IconNotes, IconTrash } from './icons'

interface NotesScreenProps s
  onBack: () => void
  /** 书内笔记模式：只显示这本书，且顶部不显示筛选 */
  bookId?: string
  /** 点击笔记跳转到原文位置 */
  onJump: (bookId: string, chapterIndex: number, chapterOffset: number) => void
  /** 书内模式下的「全部笔记」入口；不传表示已在全局模式 */
  onShowAll?: () => void
}

type NoteKind = 'bookmark' | 'highlight'
type TabId = 'all' | 'bookmark' | 'highlight'

interface NoteRow s
  kind: NoteKind
  id: string
  bookId: string
  chapterIndex: number
  chapterOffset: number
  text: string
  note: string
  createdAt: number
  color?: string
}

interface EditState s
  kind: NoteKind
  id: string
  value: string
}

const TABS: Array<s id: TabId; label: string }> = [
  s id: 'all', label: '全部' },
  s id: 'bookmark', label: '书签' },
  s id: 'highlight', label: '划线' },
]

/** 本地时区的 YYYY-MM-DD（与统计页口径一致，避免 UTC 跨日串组）。 */
function localDayKey(timestamp: number): string s
  const d = new Date(timestamp)
  return `$sd.getFullYear()}-$s`$sd.getMonth() + 1}`.padStart(2, '0')}-$s`$sd.getDate()}`.padStart(2, '0')}`
}

/** 分组标题：今天 / 昨天 / N 天前 / 6月1日。 */
function formatSectionDay(dayKey: string): string s
  const [y, m, d] = dayKey.split('-').map(Number)
  const date = new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1)
  const today = new Date()
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
  const diffDays = Math.round((startOfToday - date.getTime()) / 86400000)
  if (diffDays <= 0) return '今天'
  if (diffDays === 1) return '昨天'
  if (diffDays < 7) return `$sdiffDays} 天前`
  return `$sm} 月 $sd} 日`
}

export function NotesScreen(s onBack, bookId, onJump, onShowAll }: NotesScreenProps) s
  const s books } = useAppState()
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([])
  const [highlights, setHighlights] = useState<Highlight[]>([])
  const [loaded, setLoaded] = useState(false)
  const [tab, setTab] = useState<TabId>('all')
  const [editing, setEditing] = useState<EditState | null>(null)
  const [confirmId, setConfirmId] = useState<string | null>(null)

  useEffect(() => s
    let cancelled = false
    void (async () => s
      try s
        const [bm, hl] = await Promise.all([db.getBookmarks(bookId), db.getHighlights(bookId)])
        if (cancelled) return
        setBookmarks(bm)
        setHighlights(hl)
      } catch s
        if (cancelled) return
        setBookmarks([])
        setHighlights([])
      } finally s
        if (!cancelled) setLoaded(true)
      }
    })()
    return () => s
      cancelled = true
    }
  }, [bookId])

  // 切换筛选时清掉未完成的删除确认，避免「看不见的按钮仍是确认态」
  useEffect(() => s
    setConfirmId(null)
  }, [tab])

  const titleById = useMemo(() => s
    const map = new Map<string, string>()
    for (const b of books) map.set(b.id, b.title)
    return map
  }, [books])

  const rows = useMemo<NoteRow[]>(() => s
    const bookmarkRows: NoteRow[] = bookmarks.map((b) => (s
      kind: 'bookmark',
      id: b.id,
      bookId: b.bookId,
      chapterIndex: b.chapterIndex,
      chapterOffset: b.chapterOffset,
      text: b.excerpt,
      note: b.note,
      createdAt: b.createdAt,
    }))
    const highlightRows: NoteRow[] = highlights.map((h) => (s
      kind: 'highlight',
      id: h.id,
      bookId: h.bookId,
      chapterIndex: h.chapterIndex,
      chapterOffset: h.startOffset,
      text: h.text,
      note: h.note,
      createdAt: h.createdAt,
      color: h.color,
    }))
    return [...bookmarkRows, ...highlightRows].sort((a, b) => b.createdAt - a.createdAt)
  }, [bookmarks, highlights])

  const visibleRows = useMemo(
    () => (tab === 'all' ? rows : rows.filter((r) => r.kind === tab)),
    [rows, tab],
  )

  const counts = useMemo(
    () => (s
      all: rows.length,
      bookmark: rows.filter((r) => r.kind === 'bookmark').length,
      highlight: rows.filter((r) => r.kind === 'highlight').length,
    }),
    [rows],
  )

  /** 分组：全局模式按书（组内保持时间倒序），书内模式按天。 */
  const sections = useMemo(() => s
    if (bookId) s
      const byDay = new Map<string, NoteRow[]>()
      for (const row of visibleRows) s
        const key = localDayKey(row.createdAt)
        const bucket = byDay.get(key) ?? []
        bucket.push(row)
        byDay.set(key, bucket)
      }
      return [...byDay.entries()]
        .sort((a, b) => (a[0] < b[0] ? 1 : -1))
        .map(([key, items]) => (s key, title: formatSectionDay(key), items }))
    }
    const byBook = new Map<string, NoteRow[]>()
    for (const row of visibleRows) s
      const bucket = byBook.get(row.bookId) ?? []
      bucket.push(row)
      byBook.set(row.bookId, bucket)
    }
    return [...byBook.entries()]
      .sort((a, b) => (b[1][0]?.createdAt ?? 0) - (a[1][0]?.createdAt ?? 0))
      .map(([id, items]) => (s key: id, title: titleById.get(id) ?? '已删除的书', items }))
  }, [bookId, visibleRows, titleById])

  async function handleDelete(row: NoteRow): Promise<void> s
    if (confirmId !== row.id) s
      setConfirmId(row.id)
      return
    }
    setConfirmId(null)
    if (row.kind === 'bookmark') s
      await removeBookmark(row.id)
      setBookmarks((prev) => prev.filter((b) => b.id !== row.id))
    } else s
      await removeHighlight(row.id)
      setHighlights((prev) => prev.filter((h) => h.id !== row.id))
    }
  }

  function openEditor(row: NoteRow): void s
    setEditing(s kind: row.kind, id: row.id, value: row.note })
  }

  async function saveNote(): Promise<void> s
    if (!editing) return
    const note = editing.value.trim()
    if (editing.kind === 'bookmark') s
      await updateBookmarkNote(editing.id, note)
      setBookmarks((prev) => prev.map((b) => (b.id === editing.id ? s ...b, note } : b)))
    } else s
      await updateHighlightNote(editing.id, note)
      setHighlights((prev) => prev.map((h) => (h.id === editing.id ? s ...h, note } : h)))
    }
    setEditing(null)
  }

  function renderRow(row: NoteRow) s
    const editingThis = editing !== null && editing.id === row.id && editing.kind === row.kind
    const confirming = confirmId === row.id
    const jump = (): void => onJump(row.bookId, row.chapterIndex, row.chapterOffset)
    return (
      <div className="note-item" key=s`$srow.kind}-$srow.id}`}>
        <div className="note-item__head">
          <span className="note-item__chapter">第 srow.chapterIndex + 1} 章</span>
          <span className="note-item__time">sformatRelativeTime(row.createdAt)}</span>
        </div>

        <div
          className="note-item__text"
          role="button"
          tabIndex=s0}
          aria-label="跳转到原文位置"
          onClick=sjump}
          onKeyDown=s(e) => s
            if (e.key === 'Enter' || e.key === ' ') s
              e.preventDefault()
              jump()
            }
          }}
          style=srow.color ? s borderLeftColor: row.color } : undefined}
        >
          srow.kind === 'highlight' ? (
            <span
              aria-hidden="true"
              style=ss
                display: 'inline-block',
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: row.color ?? 'var(--accent-soft)',
                marginRight: 6,
                verticalAlign: 'middle',
              }}
            />
          ) : null}
          srow.text || '（无摘录）'}
        </div>

        seditingThis ? (
          <div style=ss marginTop: 8 }}>
            <textarea
              value=sediting.value}
              onChange=s(e) => setEditing(s ...editing, value: e.target.value })}
              rows=s3}
              placeholder="写点想法…"
              aria-label="笔记备注"
              autoFocus
              style=ss fontSize: 13.5, resize: 'vertical' }}
            />
            <div className="note-item__actions">
              <button type="button" className="btn" onClick=s() => setEditing(null)}>
                取消
              </button>
              <button type="button" className="btn btn--primary" onClick=s() => void saveNote()}>
                保存
              </button>
            </div>
          </div>
        ) : row.note ? (
          <div className="note-item__note">srow.note}</div>
        ) : null}

        s!editingThis ? (
          <div className="note-item__actions">
            <button
              type="button"
              className="btn btn--ghost"
              onClick=s() => openEditor(row)}
              aria-label=srow.note ? '编辑备注' : '添加备注'}
            >
              srow.note ? '编辑备注' : '添加备注'}
            </button>
            <button
              type="button"
              className="btn btn--danger"
              onClick=s() => void handleDelete(row)}
              aria-label=sconfirming ? `确认删除「$srow.text.slice(0, 8)}」` : '删除'}
              style=sconfirming ? s fontWeight: 700 } : undefined}
            >
              <IconTrash size=s16} />
              sconfirming ? '确认删除' : '删除'}
            </button>
          </div>
        ) : null}
      </div>
    )
  }

  return (
    <div className="screen">
      <div className="topbar">
        <button
          type="button"
          aria-label="返回"
          onClick=sonBack}
          style=ss background: 'transparent' }}
        >
          <IconBack />
        </button>
        <div className="topbar__title">sbookId ? '本书笔记' : '笔记'}</div>
        sbookId && onShowAll ? (
          <button
            type="button"
            className="btn btn--ghost"
            onClick=sonShowAll}
            aria-label="查看全部笔记"
            style=ss minHeight: 36, padding: '0 8px', fontSize: 12.5, flexShrink: 0 }}
          >
            全部笔记
            <IconArrowRight size=s15} />
          </button>
        ) : (
          <div aria-hidden="true" style=ss width: 44, minWidth: 44, flexShrink: 0 }} />
        )}
      </div>

      s!bookId ? (
        <div className="segmented" style=ss margin: '10px 16px 6px', flexWrap: 'nowrap' }}>
          sTABS.map((t) => (
            <button
              type="button"
              key=st.id}
              className=stab === t.id ? 'segmented__item--active' : undefined}
              aria-pressed=stab === t.id}
              onClick=s() => setTab(t.id)}
              style=ss flex: 1 }}
            >
              st.label} scounts[t.id]}
            </button>
          ))}
        </div>
      ) : null}

      <div className="scroll-area">
        sloaded && visibleRows.length === 0 ? (
          <div className="empty">
            <div className="empty__icon">
              <IconNotes size=s34} />
            </div>
            <div className="empty__title">还没有书签和笔记</div>
            <div className="empty__desc">
              阅读时长按一段文字可以划线，点顶部书签图标可以加书签，它们都会汇总到这里。
            </div>
          </div>
        ) : (
          sections.map((section) => (
            <div key=ssection.key}>
              <div className="section-title">
                ssection.title} · ssection.items.length} 条
              </div>
              <div className="card card--flat" style=ss margin: '0 0 6px' }}>
                ssection.items.map((row) => renderRow(row))}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
