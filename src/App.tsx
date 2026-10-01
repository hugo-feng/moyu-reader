/**
 * 应用外壳与路由。
 *
 * 刻意不引入 react-router：这是单页移动应用，导航是「标签页 + 全屏覆盖层」
 * 两种形态，用一个 `view` 状态机描述比路由表更直观，也少一个依赖。
 *
 * 结构：
 *   view = 'shelf'      → 书架标签（含统计 / 笔记 / 设置 三个子标签）
 *   view = 'reader'     → 全屏阅读器（覆盖一切）
 *   overlay = 'search' | 'notes' | 'import' | null → 从书架推入的全屏页
 */

import { useEffect, useMemo, useState } from 'react'
import { BookshelfScreen } from './ui/BookshelfScreen'
import { ReaderScreen } from './ui/ReaderScreen'
import { StatsScreen } from './ui/StatsScreen'
import { NotesScreen } from './ui/NotesScreen'
import { SearchScreen } from './ui/SearchScreen'
import { SettingsScreen } from './ui/SettingsScreen'
import { ImportScreen } from './ui/ImportScreen'
import {
  applyThemeToDocument,
  closeBook,
  dismissToast,
  initApp,
  installLifecycleHooks,
  openBook,
  refreshBooks,
  useAppState,
} from './store'
import { IconNotes, IconSettings, IconShelf, IconStats } from './ui/icons'

type Tab = 'shelf' | 'stats' | 'notes' | 'settings'
type Overlay =
  | { kind: 'none' }
  | { kind: 'search'; bookId?: string }
  | { kind: 'notes'; bookId?: string }
  | { kind: 'import' }

export function App() {
  const state = useAppState()
  const [tab, setTab] = useState<Tab>('shelf')
  const [overlay, setOverlay] = useState<Overlay>({ kind: 'none' })
  const [pendingJump, setPendingJump] = useState<{ bookId: string; chapterIndex: number; chapterOffset: number } | null>(null)

  // 初始化：读设置 + 读书库
  useEffect(() => {
    void initApp()
    return installLifecycleHooks()
  }, [])

  // 主题落到文档，深色模式偏好变化时同步
  useEffect(() => {
    applyThemeToDocument(state.settings.theme, state.settings.followSystemDark)
  }, [state.settings.theme, state.settings.followSystemDark])

  const currentBook = useMemo(
    () => state.books.find((b) => b.id === state.currentBookId) ?? null,
    [state.books, state.currentBookId],
  )

  const handleOpenBook = async (bookId: string) => {
    await openBook(bookId)
    setOverlay({ kind: 'none' })
  }

  /** 从搜索/笔记跳转到指定位置：打开书，再定位到章节与偏移。 */
  const handleJump = async (bookId: string, chapterIndex: number, chapterOffset: number) => {
    setPendingJump({ bookId, chapterIndex, chapterOffset })
    await openBook(bookId)
    setOverlay({ kind: 'none' })
  }

  const handleCloseReader = () => {
    closeBook()
    setPendingJump(null)
    void refreshBooks()
  }

  if (!state.ready) {
    return (
      <div className="app">
        <div className="empty" style={{ flex: 1 }}>
          <div className="empty__title">墨阅</div>
          <div className="empty__desc">正在准备书库…</div>
        </div>
      </div>
    )
  }

  return (
    <div className="app">
      {/* 阅读器是全屏覆盖层：打开时其他界面完全卸载，避免无意义的重渲染 */}
      {state.currentBookId && currentBook ? (
        <ReaderScreen
          book={currentBook}
          chapters={state.currentChapters}
          onClose={handleCloseReader}
          onOpenSearch={(bookId) => setOverlay({ kind: 'search', bookId })}
          onOpenNotes={(bookId) => setOverlay({ kind: 'notes', bookId })}
          initialJump={pendingJump && pendingJump.bookId === state.currentBookId ? pendingJump : null}
        />
      ) : (
        <>
          <div className="screen">
            {tab === 'shelf' && (
              <BookshelfScreen
                onOpenBook={(id) => void handleOpenBook(id)}
                onOpenStats={() => setTab('stats')}
                onOpenNotes={(bookId) => setOverlay({ kind: 'notes', bookId })}
                onOpenSearch={(bookId) => setOverlay({ kind: 'search', bookId: bookId || undefined })}
                onOpenImport={() => setOverlay({ kind: 'import' })}
              />
            )}
            {tab === 'stats' && (
              <StatsScreen onBack={() => setTab('shelf')} onOpenBook={(id) => void handleOpenBook(id)} />
            )}
            {tab === 'notes' && (
              <NotesScreen
                onBack={() => setTab('shelf')}
                onJump={(bookId, chapterIndex, chapterOffset) => void handleJump(bookId, chapterIndex, chapterOffset)}
              />
            )}
            {tab === 'settings' && <SettingsScreen onBack={() => setTab('shelf')} />}
          </div>

          <nav className="tabbar" aria-label="主导航">
            <TabButton active={tab === 'shelf'} label="书架" onClick={() => setTab('shelf')}>
              <IconShelf />
            </TabButton>
            <TabButton active={tab === 'stats'} label="统计" onClick={() => setTab('stats')}>
              <IconStats />
            </TabButton>
            <TabButton active={tab === 'notes'} label="笔记" onClick={() => setTab('notes')}>
              <IconNotes />
            </TabButton>
            <TabButton active={tab === 'settings'} label="设置" onClick={() => setTab('settings')}>
              <IconSettings />
            </TabButton>
          </nav>
        </>
      )}

      {/* 全屏覆盖层 */}
      {overlay.kind === 'search' && (
        <div className="app" style={{ position: 'absolute', inset: 0, zIndex: 100 }}>
          <SearchScreen
            bookId={overlay.bookId}
            onBack={() => setOverlay({ kind: 'none' })}
            onJump={(bookId, chapterIndex, chapterOffset) => void handleJump(bookId, chapterIndex, chapterOffset)}
          />
        </div>
      )}
      {overlay.kind === 'notes' && (
        <div className="app" style={{ position: 'absolute', inset: 0, zIndex: 100 }}>
          <NotesScreen
            bookId={overlay.bookId}
            onBack={() => setOverlay({ kind: 'none' })}
            onJump={(bookId, chapterIndex, chapterOffset) => void handleJump(bookId, chapterIndex, chapterOffset)}
            onShowAll={overlay.bookId ? () => setOverlay({ kind: 'notes' }) : undefined}
          />
        </div>
      )}
      {overlay.kind === 'import' && (
        <div className="app" style={{ position: 'absolute', inset: 0, zIndex: 100 }}>
          <ImportScreen onBack={() => setOverlay({ kind: 'none' })} />
        </div>
      )}

      {/* 提示条 */}
      {state.toasts.map((t) => (
        <div key={t.id} className="toast" onClick={() => dismissToast(t.id)} role="status">
          {t.text}
        </div>
      ))}
    </div>
  )
}

function TabButton({
  active,
  label,
  onClick,
  children,
}: {
  active: boolean
  label: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      className={`tabbar__item ${active ? 'tabbar__item--active' : ''}`}
      onClick={onClick}
      aria-label={label}
      aria-current={active ? 'page' : undefined}
    >
      {children}
      <span>{label}</span>
    </button>
  )
}
