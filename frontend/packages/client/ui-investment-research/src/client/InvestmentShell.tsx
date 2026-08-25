import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type {
  SessionId, SessionSearchResultItem, WorkspaceId,
} from '@deepseek-ai/dsh-client-runtime/client'
import type {
  HostObservable, InjectFace, PropsRuntime,
} from '@deepseek-ai/dsh-client-ui-slots'
import type { SidebarSectionOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { HeroWelcomeOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { InvestmentDataRequest } from '@deepseek-ai/dsh-client-investment-research-runtime/client'
import { asRecord, money, number, percent, records, text } from './data.ts'
import { parseHoldingsImport } from './holdings-import.ts'
import type { InvestmentRoute, InvestmentUiSnapshot } from './state.ts'
import css from './InvestmentShell.module.css'

type RequestData = (request: InvestmentDataRequest) => Promise<unknown>

interface UiInjected {
  hooks: { investmentUi: HostObservable<InvestmentUiSnapshot> }
  navigate: (route: InvestmentRoute, stockQuery?: string) => void
}

export interface InvestmentSidebarInjected extends UiInjected {
  selectWorkspace: (workspaceId: WorkspaceId) => Promise<void>
}

export type InvestmentSidebarProps = PropsRuntime<'sidebar.workspaces'>
  & SidebarSectionOwnerProps
  & InjectFace<InvestmentSidebarInjected>

export interface InvestmentShellInjected extends UiInjected {
  requestData: RequestData
  setHistory: (open: boolean) => void
  startSession: () => Promise<void>
  openSession: (sessionId: SessionId) => Promise<void>
  searchSessions: (query: string, signal: AbortSignal) => Promise<readonly SessionSearchResultItem[]>
  renameSession: (sessionId: SessionId, title: string) => Promise<void>
  archiveSession: (sessionId: SessionId) => Promise<void>
  prepareAssistant: (prompt: string) => void
}

export type InvestmentShellProps = PropsRuntime<'shell.overlay'> & InjectFace<InvestmentShellInjected>
export type InvestmentBrandProps = PropsRuntime<'sidebar.brand'>
export type InvestmentNewSessionProps = PropsRuntime<'sidebar.newSession'>
export type InvestmentWelcomeProps = PropsRuntime<'conversation.hero.welcome'> & HeroWelcomeOwnerProps

const ROUTES: readonly { id: InvestmentRoute; label: string; note?: string; disabled?: boolean }[] = [
  { id: 'portfolio', label: '持仓分析', note: '风控' },
  { id: 'assistant', label: '智能助手', note: 'AI' },
  { id: 'opportunity', label: '机会发现', note: '实时' },
  { id: 'framework', label: '投研框架', note: '规划', disabled: true },
  { id: 'projects', label: '项目组合', note: '规划', disabled: true },
  { id: 'tasks', label: '投研任务', note: '规划', disabled: true },
  { id: 'knowledge', label: '知识库', note: '规划', disabled: true },
]

const SCAN_KINDS = [
  ['gainers', '涨幅榜'],
  ['volume_ratio', '量比异动'],
  ['limit', '涨跌停'],
  ['turnover', '换手异动'],
  ['amount', '成交额榜'],
] as const

function SearchIcon() {
  return (
    <svg className={css.searchIcon} viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="7" cy="7" r="4.25" />
      <path d="m10.25 10.25 3 3" />
    </svg>
  )
}

function PlusIcon() {
  return (
    <svg className={css.actionIcon} viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 3.25v9.5M3.25 8h9.5" />
    </svg>
  )
}

function HistoryIcon() {
  return (
    <svg className={css.actionIcon} viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3.35 4.2A5.5 5.5 0 1 1 2.5 8" />
      <path d="M2.25 3.15v2.7h2.7M8 4.85V8l2.15 1.3" />
    </svg>
  )
}

function ImportIcon() {
  return (
    <svg className={css.actionIcon} viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 2.5v7M5.25 7l2.75 2.75L10.75 7" />
      <path d="M3 11v2.5h10V11" />
    </svg>
  )
}

function NavGlyph({ route }: { route: InvestmentRoute }) {
  const glyph = {
    assistant: <><path d="M10 2.8 11.8 7l4.2 1.8-4.2 1.8-1.8 4.2-1.8-4.2L4 8.8 8.2 7 10 2.8Z" /><path d="m15.5 2.8.6 1.5 1.5.6-1.5.6-.6 1.5-.6-1.5-1.5-.6 1.5-.6.6-1.5Z" /></>,
    opportunity: <><path d="M3.5 15.5 8 11l3 2 5.5-7" /><path d="M12.5 6h4v4" /></>,
    portfolio: <><path d="M10 3a7 7 0 1 0 7 7h-7V3Z" /><path d="M12 3.3A7 7 0 0 1 16.7 8H12V3.3Z" /></>,
    framework: <><path d="m10 2.8 7.2 7.2-7.2 7.2L2.8 10 10 2.8Z" /><path d="m7.2 10 1.8 1.8 3.8-4" /></>,
    projects: <><rect x="3" y="4" width="14" height="12" rx="2" /><path d="M7 4V2.8h6V4M3 8h14" /></>,
    tasks: <><path d="M4 3.5h12v13H4z" /><path d="m7 9 2 2 4-4M7 14h6" /></>,
    knowledge: <><path d="M4 3.5h8.5A3.5 3.5 0 0 1 16 7v9.5H7.5A3.5 3.5 0 0 1 4 13V3.5Z" /><path d="M7.5 16.5A3.5 3.5 0 0 1 11 13h5" /></>,
  }[route]
  return <svg className={css.navGlyph} viewBox="0 0 20 20" aria-hidden="true">{glyph}</svg>
}

/** Profile identity from the approved shared investment shell. */
export function InvestmentBrand({ compact }: InvestmentBrandProps) {
  if (compact) return <span className={css.brandCompact}>✦</span>
  return (
    <div className={css.investmentBrand} aria-label="投研智能体">
      <span className={css.brandMark}>✦</span>
      <span className={css.brandCopy}>
        <strong>投研智能体</strong>
        <small>v2.4.0 · 智能投研系统</small>
      </span>
    </div>
  )
}

/** Session creation is owned by the profile top bar, so the shared duplicate is suppressed. */
export function InvestmentNewSession(_props: InvestmentNewSessionProps) {
  return null
}

const RESEARCH_PROMPTS = [
  ['个股研究', '分析贵州茅台近期基本面、估值与主要风险'],
  ['行业机会', '梳理当前半导体行业的景气信号与潜在机会'],
  ['持仓诊断', '从集中度、波动和相关性角度检查我的组合风险'],
  ['投研框架', '为一家新能源公司建立一套可复用的投研框架'],
] as const

/** Investment-specific blank-conversation welcome from the approved interaction draft. */
export function InvestmentWelcome({ disabled, onPrompt }: InvestmentWelcomeProps) {
  return (
    <section className={css.investmentWelcome} aria-labelledby="investment-welcome-title">
      <span className={css.welcomeMark} aria-hidden="true">✦</span>
      <h1 id="investment-welcome-title">今天想研究什么？</h1>
      <p>我可以结合投研框架、行情信号和持仓上下文，协助你拆解个股、行业机会与组合风险。</p>
      <div className={css.promptGrid} aria-label="快捷研究入口">
        {RESEARCH_PROMPTS.map(([label, prompt]) => (
          <button
            key={label}
            type="button"
            disabled={disabled}
            onClick={() => { onPrompt(prompt) }}
          >
            <strong>{label}</strong>
            <span>{prompt}</span>
          </button>
        ))}
      </div>
    </section>
  )
}

export function InvestmentSidebar({
  wide, useInvestmentUi, useSessions, useWorkspaces, navigate, selectWorkspace,
}: InvestmentSidebarProps) {
  const route = useInvestmentUi(s => s.route)
  const current = useSessions(s => s.current)
  const workspaces = useWorkspaces(s => s.items)
  const active = workspaces.find(workspace => current !== undefined && workspace.sessionIds.includes(current))
    ?? workspaces[0]

  return (
    <div className={wide ? css.sidebarRegion : `${css.sidebarRegion} ${css.sidebarRegionCompact}`}>
      {wide && workspaces.length > 0 && (
        <label className={css.workspaceSelect}>
          <span>当前工作区</span>
          <select
            value={active?.workspaceId ?? ''}
            onChange={(event) => { void selectWorkspace(event.target.value as WorkspaceId) }}
          >
            {workspaces.map(workspace => (
              <option key={workspace.workspaceId} value={workspace.workspaceId}>{workspace.title}</option>
            ))}
          </select>
        </label>
      )}
      <nav className={css.investmentNav} aria-label="投研功能导航">
        {ROUTES.map(item => (
          <button
            key={item.id}
            type="button"
            className={route === item.id ? css.navActive : undefined}
            aria-current={route === item.id ? 'page' : undefined}
            aria-label={item.label}
            disabled={item.disabled}
            title={item.disabled ? `${item.label}：等待后端能力接入` : wide ? undefined : item.label}
            onClick={() => {
              navigate(item.id)
            }}
          >
            <span className={css.navIcon}><NavGlyph route={item.id} /></span>
            {wide && <span className={css.navLabel}>{item.label}</span>}
            {wide && item.note !== undefined && <span className={css.navNote}>{item.note}</span>}
          </button>
        ))}
      </nav>
    </div>
  )
}

export function InvestmentShell({
  useInvestmentUi, useSessions, useWorkspaces, requestData, navigate, setHistory, startSession,
  openSession, searchSessions, renameSession, archiveSession, prepareAssistant,
}: InvestmentShellProps) {
  const snapshot = useInvestmentUi(s => s)
  const [search, setSearch] = useState(snapshot.stockQuery)
  const [startingSession, setStartingSession] = useState(false)
  const [switchingSessionId, setSwitchingSessionId] = useState<SessionId | undefined>()
  const [historyClosing, setHistoryClosing] = useState(false)
  const [sessionError, setSessionError] = useState<string | null>(null)
  const historyTriggerRef = useRef<HTMLButtonElement>(null)
  const historyCloseTimerRef = useRef(0)

  useEffect(() => { setSearch(snapshot.stockQuery) }, [snapshot.stockQuery])
  useEffect(() => () => { window.clearTimeout(historyCloseTimerRef.current) }, [])

  const closeHistory = useCallback(() => {
    if (historyClosing) return
    const delay = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 160
    setHistoryClosing(delay > 0)
    window.clearTimeout(historyCloseTimerRef.current)
    historyCloseTimerRef.current = window.setTimeout(() => {
      setHistory(false)
      setHistoryClosing(false)
      window.requestAnimationFrame(() => { historyTriggerRef.current?.focus() })
    }, delay)
  }, [historyClosing, setHistory])

  const switchSession = useCallback(async (sessionId: SessionId): Promise<void> => {
    if (switchingSessionId !== undefined) return
    const startedAt = Date.now()
    setSwitchingSessionId(sessionId)
    setSessionError(null)
    try {
      await openSession(sessionId)
      // Keep the acknowledgement visible long enough to be perceived even
      // when the Session was already warm in the client cache.
      const remaining = 320 - (Date.now() - startedAt)
      if (remaining > 0) await new Promise(resolve => window.setTimeout(resolve, remaining))
    } catch {
      setSessionError('对话载入失败，请稍后重试。')
      throw new Error('session open failed')
    } finally {
      setSwitchingSessionId(undefined)
    }
  }, [openSession, switchingSessionId])

  return (
    <>
      <header className={css.topbar}>
        <form
          className={css.globalSearch}
          onSubmit={(event) => {
            event.preventDefault()
            const query = search.trim()
            if (query !== '') navigate('opportunity', query)
          }}
        >
          <SearchIcon />
          <input
            value={search}
            onChange={(event) => { setSearch(event.target.value) }}
            placeholder="搜索股票代码…"
            aria-label="搜索股票代码"
          />
        </form>
        <div className={css.topActions} role="group" aria-label="对话操作">
          {snapshot.route === 'assistant' && (
            <>
              <button
                type="button"
                className={css.primaryButton}
                aria-label="新对话"
                aria-busy={startingSession}
                disabled={startingSession || switchingSessionId !== undefined}
                title="新对话"
                onClick={() => {
                  if (startingSession) return
                  setStartingSession(true)
                  setSessionError(null)
                  setHistory(false)
                  void startSession()
                    .catch(() => { setSessionError('新对话创建失败，请稍后重试。') })
                    .finally(() => { setStartingSession(false) })
                }}
              >
                <PlusIcon /><span className={css.actionLabel}>{startingSession ? '创建中…' : '新对话'}</span>
              </button>
              <button
                ref={historyTriggerRef}
                type="button"
                className={css.secondaryButton}
                aria-label="历史对话"
                aria-haspopup="dialog"
                aria-expanded={snapshot.historyOpen}
                aria-controls="investment-history-drawer"
                title="历史对话"
                onClick={() => { setHistoryClosing(false); setHistory(true) }}
              >
                <HistoryIcon /><span className={css.actionLabel}>历史对话</span>
              </button>
            </>
          )}
        </div>
      </header>
      {switchingSessionId !== undefined && (
        <div className={css.sessionProgress} role="status" aria-live="polite">
          <span>正在载入对话…</span>
        </div>
      )}
      {sessionError !== null && <div className={css.sessionError} role="alert">{sessionError}</div>}

      {snapshot.route !== 'assistant' && (
        <main className={css.workbench}>
          {snapshot.route === 'opportunity' && (
            <OpportunityPage
              requestData={requestData}
              initialQuery={snapshot.stockQuery}
              onAnalyze={prepareAssistant}
            />
          )}
          {snapshot.route === 'portfolio' && (
            <PortfolioPage requestData={requestData} onAnalyze={prepareAssistant} />
          )}
          {!['opportunity', 'portfolio'].includes(snapshot.route) && (
            <DeferredPage route={snapshot.route} />
          )}
        </main>
      )}

      {snapshot.historyOpen && (
        <HistoryDrawer
          useSessions={useSessions}
          useWorkspaces={useWorkspaces}
          onClose={closeHistory}
          openSession={switchSession}
          switchingSessionId={switchingSessionId}
          closing={historyClosing}
          searchSessions={searchSessions}
          renameSession={renameSession}
          archiveSession={archiveSession}
        />
      )}
    </>
  )
}

function HistoryDrawer({
  useSessions, useWorkspaces, onClose, openSession, switchingSessionId,
  closing, searchSessions, renameSession, archiveSession,
}: Pick<InvestmentShellProps, 'useSessions' | 'useWorkspaces' | 'searchSessions' | 'renameSession' | 'archiveSession'> & {
  onClose: () => void
  openSession: (sessionId: SessionId) => Promise<void>
  switchingSessionId: SessionId | undefined
  closing: boolean
}) {
  const list = useSessions(s => s)
  const archivedSessionIds = useWorkspaces(s => s.archivedSessionIds)
  const drawerRef = useRef<HTMLElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [contentMatches, setContentMatches] = useState<ReadonlySet<SessionId>>(new Set())
  const [menuId, setMenuId] = useState<SessionId | undefined>()
  const [renaming, setRenaming] = useState<SessionId | undefined>()
  const [renameValue, setRenameValue] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    searchRef.current?.focus()
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { onClose(); return }
      if (event.key !== 'Tab') return
      const focusable = drawerRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )
      if (focusable === undefined || focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last?.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first?.focus()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => { document.removeEventListener('keydown', handleKeyDown) }
  }, [onClose])

  useEffect(() => {
    const normalized = query.trim()
    if (normalized === '') { setContentMatches(new Set()); return }
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      searchSessions(normalized, controller.signal)
        .then((items) => { setContentMatches(new Set(items.map(item => item.sessionId))) })
        .catch(() => { if (!controller.signal.aborted) setContentMatches(new Set()) })
    }, 160)
    return () => { window.clearTimeout(timer); controller.abort() }
  }, [query, searchSessions])

  const items = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase('zh-CN')
    return list.ids
      .flatMap((id) => {
        const item = list.byId[id]
        return item === undefined ? [] : [item]
      })
      .filter(item => item.origin !== 'subagent')
      .filter(item => !archivedSessionIds.includes(item.id))
      .filter(item => !item.blank || item.id === list.current)
      .filter(item => normalized === ''
        || item.displayTitle.toLocaleLowerCase('zh-CN').includes(normalized)
        || contentMatches.has(item.id))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }, [archivedSessionIds, contentMatches, list, query])

  const groups = new Map<string, typeof items>()
  for (const item of items) {
    const days = Math.floor((startOfDay(Date.now()) - startOfDay(item.updatedAt)) / 86_400_000)
    const label = days <= 0 ? '今天' : days <= 7 ? '最近 7 天' : '更早'
    groups.set(label, [...(groups.get(label) ?? []), item])
  }

  return (
    <div
      className={css.drawerBackdrop}
      data-closing={closing ? 'true' : undefined}
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}
    >
      <aside
        ref={drawerRef}
        id="investment-history-drawer"
        className={css.historyDrawer}
        role="dialog"
        aria-modal="true"
        aria-label="历史对话"
      >
        <div className={css.drawerHead}>
          <div><strong>历史对话</strong><span>切换与管理真实会话</span></div>
          <button type="button" aria-label="关闭历史对话" onClick={onClose}>×</button>
        </div>
        <div className={css.drawerSearch}>
          <input
            ref={searchRef}
            value={query}
            onChange={(event) => { setQuery(event.target.value) }}
            placeholder="搜索对话内容"
            aria-label="搜索历史对话"
          />
        </div>
        {error !== '' && <div className={css.inlineError}>{error}</div>}
        <div className={css.historyList}>
          {[...groups].map(([label, rows]) => (
            <section key={label}>
              <h3>{label}</h3>
              {rows.map(item => (
                <div key={item.id} className={item.id === list.current ? css.historyActive : css.historyItem}>
                  {renaming === item.id ? (
                    <form
                      className={css.renameForm}
                      onSubmit={(event) => {
                        event.preventDefault()
                        const next = renameValue.trim()
                        if (next === '') return
                        renameSession(item.id, next)
                          .then(() => { setRenaming(undefined); setError('') })
                          .catch((reason: unknown) => {
                            setError(reason instanceof Error ? reason.message : String(reason))
                          })
                      }}
                    >
                      <input autoFocus value={renameValue} onChange={(event) => { setRenameValue(event.target.value) }} />
                      <button type="submit">保存</button>
                    </form>
                  ) : (
                    <>
                      <button
                        type="button"
                        className={css.historyMain}
                        aria-busy={switchingSessionId === item.id}
                        disabled={switchingSessionId !== undefined}
                        onClick={() => {
                          void openSession(item.id)
                            .then(() => {
                              if (window.matchMedia('(max-width: 900px)').matches) onClose()
                            })
                            .catch(() => {})
                        }}
                      >
                        <span className={css.historyTitleRow}>
                          <strong>{item.displayTitle}</strong>
                          {switchingSessionId === item.id && <small><i aria-hidden="true" />载入中</small>}
                        </span>
                        <span>{new Date(item.updatedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
                      </button>
                      <button
                        type="button"
                        className={css.moreButton}
                        aria-label="更多操作"
                        onClick={() => { setMenuId(menuId === item.id ? undefined : item.id) }}
                      >···</button>
                      {menuId === item.id && (
                        <div className={css.historyMenu}>
                          <button type="button" onClick={() => { setRenaming(item.id); setRenameValue(item.displayTitle); setMenuId(undefined) }}>重命名</button>
                          <button
                            type="button"
                            className={css.dangerText}
                            onClick={() => {
                              archiveSession(item.id)
                                .then(() => { setMenuId(undefined); setError('') })
                                .catch((reason: unknown) => {
                                  setError(reason instanceof Error ? reason.message : String(reason))
                                })
                            }}
                          >归档对话</button>
                        </div>
                      )}
                    </>
                  )}
                </div>
              ))}
            </section>
          ))}
          {items.length === 0 && <div className={css.emptyState}>没有找到匹配的对话</div>}
        </div>
        <div className={css.drawerFoot}>会话由当前工作区安全保存</div>
      </aside>
    </div>
  )
}

function OpportunityPage({
  requestData, initialQuery, onAnalyze,
}: { requestData: RequestData; initialQuery: string; onAnalyze: (prompt: string) => void }) {
  const [kind, setKind] = useState('gainers')
  const [nonce, setNonce] = useState(0)
  const [scan, setScan] = useState<unknown>()
  const [news, setNews] = useState<unknown>()
  const [selected, setSelected] = useState(initialQuery)
  const [signal, setSignal] = useState<unknown>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    const query = initialQuery.trim()
    if (query !== '') setSelected(query)
  }, [initialQuery])

  useEffect(() => {
    let alive = true
    setLoading(true); setError('')
    Promise.all([
      requestData({ operation: 'market-watch.scan', input: { kind, top_n: 12 } }),
      requestData({ operation: 'market-watch.news-flash', input: { limit: 12, enrich: true, personal: true } }),
    ]).then(([scanValue, newsValue]) => {
      if (!alive) return
      setScan(scanValue); setNews(newsValue); setLoading(false)
    }).catch((reason: unknown) => {
      if (!alive) return
      setError(reason instanceof Error ? reason.message : String(reason)); setLoading(false)
    })
    return () => { alive = false }
  }, [kind, nonce, requestData])

  const rows = useMemo(() => {
    const record = asRecord(scan)
    return [...records(record.items), ...records(record.limit_up), ...records(record.limit_down)]
  }, [scan])

  useEffect(() => {
    if (loading || error !== '') return
    if (rows.some(row => text(row.code, '') === selected)) return
    setSelected(text(rows[0]?.code, ''))
  }, [error, loading, rows, selected])

  useEffect(() => {
    const code = selected.trim()
    if (code === '') { setSignal(undefined); return }
    let alive = true
    requestData({ operation: 'market-watch.tech-signal', input: { code, lookback: 120 } })
      .then((value) => { if (alive) setSignal(value) })
      .catch(() => { if (alive) setSignal(undefined) })
    return () => { alive = false }
  }, [requestData, selected])

  const signalRecord = asRecord(signal)
  const indicators = asRecord(signalRecord.indicators)
  const support = asRecord(indicators.support_resistance)
  const headlines = Array.isArray(news) ? news : records(asRecord(news).items)

  return (
    <div className={css.pageScroll}>
      <PageHeader title="机会发现" description="基于实时扫描、技术信号和个性化事件发现研究线索">
        <button type="button" className={css.secondaryButton} onClick={() => { setNonce(value => value + 1) }}>刷新数据</button>
      </PageHeader>
      <div className={css.segmented}>
        {SCAN_KINDS.map(([value, label]) => (
          <button
            key={value}
            type="button"
            className={kind === value ? css.segmentActive : undefined}
            onClick={() => { setKind(value) }}
          >{label}</button>
        ))}
      </div>
      {error !== '' && <ErrorCard message={error} retry={() => { setNonce(value => value + 1) }} />}
      {loading && <div className={css.loadingCard}>正在连接投研后端并加载真实数据…</div>}
      {!loading && error === '' && (
        <div className={css.opportunityGrid}>
          <section className={css.cardList}>
            <div className={css.sectionHeading}><strong>市场扫描</strong><span>{rows.length} 个结果</span></div>
            {rows.map((row, index) => {
              const code = text(row.code, `row-${index}`)
              const pctChange = number(row.pct_change)
              const amountYi = number(row.amount_yi)
              return (
                <button
                  key={`${code}-${index}`}
                  type="button"
                  className={selected === code ? css.stockCardActive : css.stockCard}
                  onClick={() => { setSelected(code) }}
                >
                  <div><strong>{text(row.name, code)}</strong><span>{code}</span></div>
                  <div className={pctChange !== undefined && pctChange < 0 ? css.negative : css.positive}>
                    {percent(row.pct_change)}
                  </div>
                  <dl>
                    <div><dt>现价</dt><dd>{money(row.price)}</dd></div>
                    <div><dt>量比</dt><dd>{number(row.volume_ratio)?.toFixed(2) ?? '—'}</dd></div>
                    <div><dt>成交额</dt><dd>{amountYi === undefined ? '—' : `${amountYi.toFixed(2)} 亿`}</dd></div>
                  </dl>
                </button>
              )
            })}
            {rows.length === 0 && <div className={css.emptyState}>当前扫描没有返回结果</div>}
          </section>
          <section className={css.detailCard}>
            <div className={css.detailTitle}>
              <div><strong>{text(signalRecord.name, selected || '选择一只股票')}</strong><span>{text(signalRecord.code, selected)}</span></div>
              {selected !== '' && (
                <button
                  type="button"
                  className={css.primaryButton}
                  onClick={() => {
                    onAnalyze(`请深度分析 ${selected}，结合技术信号、基本面和主要风险给出研究结论。`)
                  }}
                >在智能助手中分析</button>
              )}
            </div>
            <div className={css.signalGrid}>
              <Metric label="K 线样本" value={number(signalRecord.bars)?.toFixed(0) ?? '—'} />
              <Metric label="支撑位" value={number(support.support)?.toFixed(2) ?? '—'} />
              <Metric label="压力位" value={number(support.resistance)?.toFixed(2) ?? '—'} />
              <Metric label="数据时间" value={text(signalRecord.as_of)} />
            </div>
            <div className={css.signalList}>
              <h3>技术信号</h3>
              {(Array.isArray(signalRecord.signals) ? signalRecord.signals : []).map((item, index) => <p key={index}>{String(item)}</p>)}
              {!Array.isArray(signalRecord.signals) && <p>选择扫描结果后加载技术信号。</p>}
            </div>
            <div className={css.newsList}>
              <h3>实时资讯</h3>
              {headlines.slice(0, 8).map((item, index) => {
                const row = asRecord(item)
                return <article key={text(row.id, String(index))}><strong>{text(row.title, text(row.summary, '市场快讯'))}</strong><span>{text(row.time, text(row.ts, ''))}</span></article>
              })}
              {headlines.length === 0 && <p>当前数据源未返回资讯。</p>}
            </div>
          </section>
        </div>
      )}
    </div>
  )
}

function HoldingsImportDialog({
  requestData, onClose, onImported,
}: { requestData: RequestData; onClose: () => void; onImported: (count: number) => void }) {
  const [source, setSource] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const result = useMemo(() => parseHoldingsImport(source), [source])
  const canSubmit = result.items.length > 0 && result.errors.length === 0 && !saving

  const save = async () => {
    if (!canSubmit) return
    setSaving(true)
    setError('')
    try {
      await requestData({
        operation: 'trading-core.holdings-save',
        input: { holdings: result.items },
      })
      onImported(result.items.length)
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : String(reason))
      setSaving(false)
    }
  }

  return (
    <div
      className={`${css.drawerBackdrop} ${css.importBackdrop}`}
      role="presentation"
      onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) onClose() }}
      onKeyDown={(event) => { if (event.key === 'Escape' && !saving) onClose() }}
    >
      <section className={css.importDialog} role="dialog" aria-modal="true" aria-labelledby="holdings-import-title">
        <div className={css.importHead}>
          <div>
            <strong id="holdings-import-title">导入持仓</strong>
            <span>支持 CSV、TSV 和从表格复制的文本</span>
          </div>
          <button type="button" aria-label="关闭导入持仓" disabled={saving} onClick={onClose}>×</button>
        </div>
        <div className={css.importBody}>
          <div className={css.importGuide}>
            <strong>导入会整体替换当前持仓</strong>
            <span>至少需要“股票代码、数量、成本价”三列，导入成功后会重新计算组合风险。</span>
          </div>
          <label className={css.fileButton}>
            <ImportIcon />选择 CSV / TSV 文件
            <input
              type="file"
              accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain"
              disabled={saving}
              onChange={(event) => {
                const file = event.currentTarget.files?.[0]
                if (file === undefined) return
                setError('')
                void file.text().then(setSource).catch(() => { setError('文件读取失败，请重试或直接粘贴表格内容。') })
                event.currentTarget.value = ''
              }}
            />
          </label>
          <label className={css.importField}>
            <span>或粘贴表格内容</span>
            <textarea
              autoFocus
              aria-label="持仓导入内容"
              value={source}
              disabled={saving}
              placeholder={'股票代码,数量,成本价\n600519,100,1500\n000858,200,135'}
              onChange={(event) => { setSource(event.target.value); setError('') }}
            />
          </label>
          {result.errors.length > 0 && (
            <div className={css.importErrors} role="alert">
              <strong>请先修正以下问题</strong>
              {result.errors.slice(0, 8).map(message => <span key={message}>{message}</span>)}
              {result.errors.length > 8 && <span>另有 {result.errors.length - 8} 个问题未展示。</span>}
            </div>
          )}
          {error !== '' && <div className={css.importErrors} role="alert"><strong>导入失败</strong><span>{error}</span></div>}
          {result.items.length > 0 && (
            <div className={css.importPreview}>
              <div className={css.sectionHeading}><strong>导入预览</strong><span>{result.items.length} 项</span></div>
              <div className={css.tableWrap}>
                <table>
                  <thead><tr><th>股票代码</th><th>数量</th><th>持仓成本</th></tr></thead>
                  <tbody>
                    {result.items.slice(0, 20).map(item => (
                      <tr key={item.ticker}>
                        <td>{item.ticker}</td>
                        <td>{item.quantity.toLocaleString('zh-CN')}</td>
                        <td>{money(item.cost_price)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {result.items.length > 20 && <p>仅预览前 20 项，保存时会导入全部数据。</p>}
            </div>
          )}
        </div>
        <div className={css.importActions}>
          <button type="button" className={css.secondaryButton} disabled={saving} onClick={onClose}>取消</button>
          <button type="button" className={css.primaryButton} disabled={!canSubmit} onClick={() => { void save() }}>
            {saving ? '正在导入…' : `替换并导入 ${result.items.length} 条`}
          </button>
        </div>
      </section>
    </div>
  )
}

function PortfolioPage({ requestData, onAnalyze }: { requestData: RequestData; onAnalyze: (prompt: string) => void }) {
  const [nonce, setNonce] = useState(0)
  const [holdings, setHoldings] = useState<unknown>()
  const [risk, setRisk] = useState<unknown>()
  const [alerts, setAlerts] = useState<unknown>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [importOpen, setImportOpen] = useState(false)
  const [notice, setNotice] = useState('')

  useEffect(() => {
    let alive = true
    setLoading(true); setError('')
    Promise.all([
      requestData({ operation: 'trading-core.holdings' }),
      requestData({ operation: 'trading-core.risk-portfolio' }),
      requestData({ operation: 'trading-core.risk-alerts' }),
    ]).then(([holdingsValue, riskValue, alertValue]) => {
      if (!alive) return
      setHoldings(holdingsValue); setRisk(riskValue); setAlerts(alertValue); setLoading(false)
    }).catch((reason: unknown) => {
      if (!alive) return
      setError(reason instanceof Error ? reason.message : String(reason)); setLoading(false)
    })
    return () => { alive = false }
  }, [nonce, requestData])

  const positions = records(asRecord(holdings).items)
  const riskRecord = asRecord(risk)
  const summary = asRecord(riskRecord.summary)
  const breaches = records(riskRecord.breaches)
  const alertItems = records(asRecord(alerts).items)
  const equalWeight = number(summary.equal_weight)

  return (
    <div className={css.pageScroll}>
      <PageHeader title="持仓分析" description="只展示后端已保存的持仓、风险预算与真实预警结果">
        <button type="button" className={css.secondaryButton} onClick={() => { setNotice(''); setImportOpen(true) }}>
          <ImportIcon /><span className={css.actionLabel}>导入持仓</span>
        </button>
        <button type="button" className={css.secondaryButton} onClick={() => { setNonce(value => value + 1) }}>刷新</button>
        <button
          type="button"
          className={css.primaryButton}
          onClick={() => {
            onAnalyze('请分析我当前保存的全部持仓，重点评估集中度、回撤风险和需要优先处理的预警。')
          }}
        >发起持仓深度分析</button>
      </PageHeader>
      {notice !== '' && <div className={css.importNotice} role="status">{notice}</div>}
      {error !== '' && <ErrorCard message={error} retry={() => { setNonce(value => value + 1) }} />}
      {loading && <div className={css.loadingCard}>正在读取持仓和风险模型…</div>}
      {!loading && error === '' && (
        <>
          <div className={css.metricRow}>
            <Metric label="持仓数量" value={number(summary.n_positions)?.toFixed(0) ?? String(positions.length)} />
            <Metric label="风险画像" value={text(riskRecord.profile_label)} />
            <Metric label="等权占比" value={equalWeight === undefined ? '—' : `${(equalWeight * 100).toFixed(1)}%`} />
            <Metric label="集中度 HHI" value={number(summary.hhi)?.toFixed(3) ?? '—'} />
          </div>
          <div className={css.portfolioGrid}>
            <section className={css.tableCard}>
              <div className={css.sectionHeading}><strong>当前持仓</strong><span>{positions.length} 项</span></div>
              <div className={css.tableWrap}>
                <table>
                  <thead><tr><th>股票代码</th><th>名称</th><th>数量</th><th>持仓成本</th></tr></thead>
                  <tbody>
                    {positions.map((row, index) => (
                      <tr key={`${text(row.ticker, '')}-${index}`}>
                        <td>
                          <button
                            type="button"
                            className={css.codeButton}
                            onClick={() => {
                              onAnalyze(`请分析持仓标的 ${text(row.ticker, '')} 的投资逻辑和主要风险。`)
                            }}
                          >{text(row.ticker)}</button>
                        </td>
                        <td>{text(row.name)}</td>
                        <td>{number(row.quantity)?.toLocaleString('zh-CN') ?? '—'}</td>
                        <td>{money(row.cost_price)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {positions.length === 0 && <div className={css.emptyState}>尚未保存持仓，可使用页面上方的“导入持仓”录入 CSV 或表格数据。</div>}
            </section>
            <section className={css.riskColumn}>
              <div className={css.panelCard}>
                <div className={css.sectionHeading}><strong>风险预算突破</strong><span>{breaches.length}</span></div>
                {breaches.map((item, index) => <RiskRow key={text(item.indicator, String(index))} item={item} />)}
                {breaches.length === 0 && <div className={css.goodState}>当前没有检测到风险预算突破</div>}
              </div>
              <div className={css.panelCard}>
                <div className={css.sectionHeading}><strong>风险预警中心</strong><span>{alertItems.length}</span></div>
                {alertItems.slice(0, 12).map((item, index) => <AlertRow key={text(item.id, String(index))} item={item} />)}
                {alertItems.length === 0 && <div className={css.emptyState}>当前没有预警记录</div>}
              </div>
            </section>
          </div>
        </>
      )}
      {importOpen && (
        <HoldingsImportDialog
          requestData={requestData}
          onClose={() => { setImportOpen(false) }}
          onImported={(count) => {
            setImportOpen(false)
            setNotice(`已导入 ${count} 条持仓，持仓与风险数据已刷新。`)
            setNonce(value => value + 1)
          }}
        />
      )}
    </div>
  )
}

function RiskRow({ item }: { item: Record<string, unknown> }) {
  return <div className={css.riskRow}><span data-severity={text(item.severity, '低')}>{text(item.severity, '低')}</span><div><strong>{text(item.label)}</strong><p>当前 {scalar(item.value)} · 上限 {scalar(item.limit)}</p></div></div>
}

function AlertRow({ item }: { item: Record<string, unknown> }) {
  return <article className={css.alertRow}><div><span data-severity={text(item.severity, '低')}>{text(item.severity, '低')}</span><strong>{text(item.title)}</strong></div><p>{text(item.detail)}</p><small>{text(item.ts, '')}</small></article>
}

function DeferredPage({ route }: { route: InvestmentRoute }) {
  const item = ROUTES.find(candidate => candidate.id === route)
  const descriptions: Partial<Record<InvestmentRoute, string>> = {
    framework: '后端已有 KYC、风险画像、策略池、回测和自进化接口；下一阶段将按真实策略生命周期实现。',
    projects: '将映射现有工作区和会话，不创建与 Workspace 平行的本地项目数据。',
    tasks: '需要先统一投研任务与 Goal / Schedule / Workflow 的状态模型。',
    knowledge: '将以工作区文件、附件和真实会话产物为数据源，不使用交互稿中的假研报。',
  }
  return <div className={css.deferred}><span><NavGlyph route={route} /></span><h1>{item?.label}</h1><p>{descriptions[route] ?? '该模块正在接入真实能力。'}</p><strong>真实能力接入中</strong></div>
}

function PageHeader({ title, description, children }: { title: string; description: string; children?: ReactNode }) {
  return <div className={css.pageHeader}><div><h1>{title}</h1><p>{description}</p></div><div>{children}</div></div>
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className={css.metric}><span>{label}</span><strong>{value}</strong></div>
}

function ErrorCard({ message, retry }: { message: string; retry: () => void }) {
  return <div className={css.errorCard}><div><strong>真实数据暂不可用</strong><p>{message}</p></div><button type="button" onClick={retry}>重试</button></div>
}

function startOfDay(value: number): number {
  const date = new Date(value)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

function scalar(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? String(value)
    : '—'
}
