import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
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
import {
  AnalysisPage,
  DashboardPage,
  EvolutionPage,
  ShadowPage,
  StrategyPage,
} from './V2Pages.tsx'
import { IndustryChainPage } from './IndustryChainPage.tsx'
import { MyResearchPage } from './MyResearchPage.tsx'
import {
  buildInvestmentAssistantRequest,
  type InvestmentAssistantActionInput,
  type InvestmentAssistantRequest,
} from './assistant-context.ts'
import type { InvestmentRoute, InvestmentUiSnapshot } from './state.ts'
import css from './InvestmentShell.module.css'

type RequestData = (request: InvestmentDataRequest) => Promise<unknown>

type ResourcePhase = 'idle' | 'loading' | 'refreshing' | 'success' | 'error'

interface ResourceState {
  readonly phase: ResourcePhase
  readonly loaded: boolean
  readonly value: unknown
  readonly error: string
}

interface RequestResource {
  readonly state: ResourceState
  readonly busy: boolean
  run: (request: InvestmentDataRequest) => void
  reset: () => void
}

const EMPTY_RESOURCE: ResourceState = Object.freeze({
  phase: 'idle', loaded: false, value: undefined, error: '',
})

function errorText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

/**
 * Own browser request flights by serialized key and ignore superseded settlements.
 * A same-key refresh retains its prior value; a different request key clears
 * mismatched data. Effect replay and A-B-A selection reuse an unsettled flight.
 */
function useRequestResource(requestData: RequestData): RequestResource {
  const [state, setState] = useState<ResourceState>(EMPTY_RESOURCE)
  const generationRef = useRef(0)
  const flightsRef = useRef(new Map<string, Promise<unknown>>())
  const settledKeyRef = useRef<string>()

  useEffect(() => () => { generationRef.current += 1 }, [])

  const run = useCallback((request: InvestmentDataRequest): void => {
    const key = JSON.stringify(request)
    const generation = ++generationRef.current
    setState((current) => {
      const retain = current.loaded && settledKeyRef.current === key
      return {
        phase: retain ? 'refreshing' : 'loading',
        loaded: retain,
        value: retain ? current.value : undefined,
        error: '',
      }
    })
    let flight = flightsRef.current.get(key)
    if (flight === undefined) {
      flight = Promise.resolve().then(() => requestData(request))
      flightsRef.current.set(key, flight)
      const release = (): void => {
        if (flightsRef.current.get(key) === flight) flightsRef.current.delete(key)
      }
      void flight.then(release, release)
    }
    void flight
      .then((value) => {
        if (generation !== generationRef.current) return
        settledKeyRef.current = key
        setState({ phase: 'success', loaded: true, value, error: '' })
      }, (reason: unknown) => {
        if (generation !== generationRef.current) return
        setState(current => ({ ...current, phase: 'error', error: errorText(reason) }))
      })
  }, [requestData])

  const reset = useCallback((): void => {
    generationRef.current += 1
    settledKeyRef.current = undefined
    setState(EMPTY_RESOURCE)
  }, [])

  return {
    state,
    busy: state.phase === 'loading' || state.phase === 'refreshing',
    run,
    reset,
  }
}

/** Only expose backend-provided HTTP(S) article addresses as external links. */
export function safeExternalNewsUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  try {
    const url = new URL(value.trim())
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username !== '' || url.password !== '') {
      return undefined
    }
    return url.toString()
  } catch {
    return undefined
  }
}

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
  prepareAssistant: (request: InvestmentAssistantRequest) => Promise<void>
  toggleTheme: () => void
}

export type InvestmentShellProps = PropsRuntime<'shell.overlay'> & InjectFace<InvestmentShellInjected>
export type InvestmentBrandProps = PropsRuntime<'sidebar.brand'>
export type InvestmentNewSessionProps = PropsRuntime<'sidebar.newSession'>
export type InvestmentWelcomeProps = PropsRuntime<'conversation.hero.welcome'> & HeroWelcomeOwnerProps

type NavigationRoute = Exclude<InvestmentRoute, 'assistant' | 'stock-detail'>

const ROUTE_GROUPS: readonly { label: string; items: readonly { id: NavigationRoute; label: string }[] }[] = [
  { label: '总览', items: [{ id: 'dashboard', label: '研究工作台' }] },
  { label: '分析与盯盘', items: [{ id: 'analysis', label: '智能分析' }, { id: 'watch', label: '实时盯盘' }] },
  { label: '策略闭环', items: [{ id: 'strategy', label: '策略研究' }, { id: 'shadow', label: '影子验证' }, { id: 'evolution', label: '自进化' }] },
  { label: '个人与图谱', items: [{ id: 'portfolio', label: '我的投研' }, { id: 'chain', label: '产业链' }] },
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

function ThemeIcon() {
  return (
    <svg className={css.themeIcon} viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="5.25" />
      <path d="M8 2.75a5.25 5.25 0 0 1 0 10.5Z" />
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
    dashboard: <><rect x="3" y="3" width="6" height="6" rx="1" /><rect x="11" y="3" width="6" height="6" rx="1" /><rect x="3" y="11" width="6" height="6" rx="1" /><rect x="11" y="11" width="6" height="6" rx="1" /></>,
    analysis: <><path d="M10 2.8 11.8 7l4.2 1.8-4.2 1.8-1.8 4.2-1.8-4.2L4 8.8 8.2 7 10 2.8Z" /><path d="m15.5 2.8.6 1.5 1.5.6-1.5.6-.6 1.5-.6-1.5-1.5-.6 1.5-.6.6-1.5Z" /></>,
    watch: <><path d="M3.5 15.5 8 11l3 2 5.5-7" /><path d="M12.5 6h4v4" /></>,
    'stock-detail': <><path d="M3.5 15.5 8 11l3 2 5.5-7" /><path d="M12.5 6h4v4" /></>,
    portfolio: <><path d="M10 3a7 7 0 1 0 7 7h-7V3Z" /><path d="M12 3.3A7 7 0 0 1 16.7 8H12V3.3Z" /></>,
    strategy: <><path d="m10 2.8 7.2 7.2-7.2 7.2L2.8 10 10 2.8Z" /><path d="m7.2 10 1.8 1.8 3.8-4" /></>,
    shadow: <><path d="M3 10s2.5-4 7-4 7 4 7 4-2.5 4-7 4-7-4-7-4Z" /><circle cx="10" cy="10" r="2" /></>,
    evolution: <><path d="M4 7a6.5 6.5 0 0 1 11-2l1.5 2" /><path d="M16.5 3.5V7H13" /><path d="M16 13a6.5 6.5 0 0 1-11 2l-1.5-2" /><path d="M3.5 16.5V13H7" /></>,
    chain: <><circle cx="5" cy="5" r="2" /><circle cx="15" cy="6" r="2" /><circle cx="7" cy="15" r="2" /><path d="m6.8 6.2 6.4-1M6 7l1 6M9 14l4.5-6.5" /></>,
  }[route]
  return <svg className={css.navGlyph} viewBox="0 0 20 20" aria-hidden="true">{glyph}</svg>
}

/** Profile identity from the approved shared investment shell. */
export function InvestmentBrand({ compact }: InvestmentBrandProps) {
  if (compact) return <span className={css.brandCompact}>PA</span>
  return (
    <div className={css.investmentBrand} aria-label="投研智能体">
      <span className={css.brandMark}>PA</span>
      <span className={css.brandCopy}>
        <strong>投研智能体</strong>
        <small>智能研究工作台</small>
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
  const activeRoute: NavigationRoute | undefined = route === 'stock-detail' ? 'watch' : route === 'assistant' ? undefined : route
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
        {ROUTE_GROUPS.map(group => (
          <div className={css.navGroup} key={group.label}>
            {wide && <span className={css.navGroupLabel}>{group.label}</span>}
            {group.items.map(item => (
              <button
                key={item.id}
                type="button"
                className={activeRoute === item.id ? css.navActive : undefined}
                aria-current={activeRoute === item.id ? 'page' : undefined}
                aria-label={item.label}
                title={wide ? undefined : item.label}
                onClick={() => { navigate(item.id) }}
              >
                <span className={css.navIcon}><NavGlyph route={item.id} /></span>
                {wide && <span className={css.navLabel}>{item.label}</span>}
              </button>
            ))}
          </div>
        ))}
      </nav>
    </div>
  )
}

interface SecuritySearchItem {
  readonly code: string
  readonly name: string
  readonly market: string
}

function securitySearchItems(value: unknown): SecuritySearchItem[] {
  return records(asRecord(value).items).flatMap((item) => {
    const code = text(item.code, '')
    if (code === '') return []
    return [{ code, name: text(item.name, code), market: text(item.market, '') }]
  })
}

function GlobalStockSearch({
  requestData, navigate,
}: { requestData: RequestData; navigate: UiInjected['navigate'] }) {
  const [query, setQuery] = useState('')
  const [items, setItems] = useState<SecuritySearchItem[]>([])
  const [focused, setFocused] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)

  useEffect(() => {
    const keyword = query.trim()
    if (!focused || keyword === '') {
      setItems([]); setLoading(false); setError('')
      return
    }
    let alive = true
    setLoading(true); setError('')
    const timer = window.setTimeout(() => {
      requestData({ operation: 'market-watch.security-search', input: { query: keyword, limit: 8 } })
        .then((value) => {
          if (!alive) return
          setItems(securitySearchItems(value)); setActiveIndex(0); setLoading(false)
        })
        .catch(() => {
          if (!alive) return
          setItems([]); setError('证券搜索暂不可用，请稍后重试。'); setLoading(false)
        })
    }, 180)
    return () => { alive = false; window.clearTimeout(timer) }
  }, [focused, query, requestData])

  const select = (item: SecuritySearchItem): void => {
    setQuery('')
    setItems([])
    setError('')
    setActiveIndex(0)
    setFocused(false)
    navigate('stock-detail', item.code)
  }

  const submit = (): void => {
    const keyword = query.trim()
    const item = items[activeIndex] ?? items[0]
    if (item !== undefined) { select(item); return }
    if (/^\d{6}$/.test(keyword)) {
      setQuery('')
      setItems([])
      setError('')
      setActiveIndex(0)
      setFocused(false)
      navigate('stock-detail', keyword)
      return
    }
    setFocused(true)
    setError(keyword === '' ? '' : '请选择匹配的证券后查看详情。')
  }

  const listOpen = focused && query.trim() !== ''
  return (
    <form
      className={css.globalSearch}
      role="search"
      onSubmit={(event) => { event.preventDefault(); submit() }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false)
      }}
    >
      <SearchIcon />
      <input
        value={query}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={listOpen}
        aria-controls="investment-security-results"
        aria-activedescendant={items[activeIndex] === undefined ? undefined : `security-result-${items[activeIndex].code}`}
        onFocus={() => { setFocused(true) }}
        onChange={(event) => { setQuery(event.target.value); setFocused(true) }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' && items.length > 0) {
            event.preventDefault(); setActiveIndex(index => (index + 1) % items.length)
          } else if (event.key === 'ArrowUp' && items.length > 0) {
            event.preventDefault(); setActiveIndex(index => (index - 1 + items.length) % items.length)
          } else if (event.key === 'Escape') {
            setFocused(false)
          }
        }}
        placeholder="搜索 A 股代码或名称…"
        aria-label="搜索 A 股代码或名称"
      />
      {listOpen && (
        <div id="investment-security-results" className={css.searchResults} role="listbox">
          {loading && <div className={css.searchStatus}>正在搜索证券…</div>}
          {!loading && error !== '' && <div className={css.searchError}>{error}</div>}
          {!loading && error === '' && items.map((item, index) => (
            <button
              key={item.code}
              id={`security-result-${item.code}`}
              type="button"
              role="option"
              aria-selected={activeIndex === index}
              className={activeIndex === index ? css.searchResultActive : undefined}
              onMouseEnter={() => { setActiveIndex(index) }}
              onClick={() => { select(item) }}
            >
              <span><strong>{item.name}</strong><small>{item.market}</small></span>
              <code>{item.code}</code>
            </button>
          ))}
          {!loading && error === '' && items.length === 0 && <div className={css.searchStatus}>没有找到匹配的 A 股证券</div>}
        </div>
      )}
    </form>
  )
}

export function InvestmentShell({
  useInvestmentUi, useSessions, useWorkspaces, requestData, navigate, setHistory, startSession,
  openSession, searchSessions, renameSession, archiveSession, prepareAssistant, toggleTheme,
}: InvestmentShellProps) {
  const snapshot = useInvestmentUi(s => s)
  const [startingSession, setStartingSession] = useState(false)
  const [switchingSessionId, setSwitchingSessionId] = useState<SessionId | undefined>()
  const [historyClosing, setHistoryClosing] = useState(false)
  const [sessionError, setSessionError] = useState<string | null>(null)
  const [assistantOpen, setAssistantOpen] = useState(false)
  const [assistantStarting, setAssistantStarting] = useState(false)
  const [assistantError, setAssistantError] = useState('')
  const [assistantContextLabel, setAssistantContextLabel] = useState('整体投研')
  const assistantGenerationRef = useRef(0)
  const historyTriggerRef = useRef<HTMLButtonElement>(null)
  const historyCloseTimerRef = useRef(0)

  useEffect(() => () => { window.clearTimeout(historyCloseTimerRef.current) }, [])

  useEffect(() => {
    if (!assistantOpen) return
    document.body.dataset.investmentAssistantOpen = ''
    return () => { delete document.body.dataset.investmentAssistantOpen }
  }, [assistantOpen])

  useEffect(() => { setAssistantOpen(false) }, [snapshot.route])

  const askAssistant = useCallback((input: InvestmentAssistantActionInput): void => {
    const generation = ++assistantGenerationRef.current
    setAssistantOpen(true)
    setAssistantStarting(true)
    setAssistantError('')
    void buildInvestmentAssistantRequest(requestData, snapshot.route, snapshot.stockQuery, input)
      .then((request) => {
        if (generation === assistantGenerationRef.current) setAssistantContextLabel(request.context.moduleLabel)
        return prepareAssistant(request)
      })
      .catch((reason: unknown) => {
        if (generation === assistantGenerationRef.current) {
          setAssistantError(reason instanceof Error ? reason.message : '投研助理启动失败，请重试。')
        }
      })
      .finally(() => {
        if (generation === assistantGenerationRef.current) setAssistantStarting(false)
      })
  }, [prepareAssistant, requestData, snapshot.route, snapshot.stockQuery])

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
        <GlobalStockSearch requestData={requestData} navigate={navigate} />
        <div className={css.topActions} role="group" aria-label="页面操作">
          <button
            type="button"
            className={css.themeToggle}
            aria-label="切换深色或浅色模式"
            title="切换深色或浅色模式"
            onClick={toggleTheme}
          >
            <ThemeIcon />
          </button>
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
          {snapshot.route === 'dashboard' && (
            <DashboardPage
              requestData={requestData}
              onAnalyze={askAssistant}
              onNavigate={(route) => { navigate(route) }}
            />
          )}
          {snapshot.route === 'analysis' && (
            <AnalysisPage requestData={requestData} onAnalyze={askAssistant} onPortfolio={() => { navigate('portfolio') }} />
          )}
          {snapshot.route === 'watch' && (
            <OpportunityPage
              requestData={requestData}
              initialQuery={snapshot.stockQuery}
              showOverview
              onAnalyze={askAssistant}
              onView={(code) => { navigate('stock-detail', code) }}
            />
          )}
          {snapshot.route === 'stock-detail' && (
            <StockDetailPage
              requestData={requestData}
              code={snapshot.stockQuery}
              onBack={() => { navigate('watch') }}
              onAnalyze={askAssistant}
            />
          )}
          {snapshot.route === 'strategy' && <StrategyPage requestData={requestData} onAnalyze={askAssistant} />}
          {snapshot.route === 'shadow' && <ShadowPage requestData={requestData} onAnalyze={askAssistant} />}
          {snapshot.route === 'evolution' && <EvolutionPage requestData={requestData} onAnalyze={askAssistant} />}
          {snapshot.route === 'portfolio' && (
            <MyResearchPage requestData={requestData} onAskAssistant={askAssistant} />
          )}
          {snapshot.route === 'chain' && (
            <IndustryChainPage requestData={requestData} onAskAssistant={askAssistant} />
          )}
        </main>
      )}

      {snapshot.route !== 'assistant' && (
        <button type="button" className={css.assistantDock} aria-label="打开投研助理" onClick={() => { askAssistant('') }}>
          <span>AI</span><strong>投研助理</strong>
        </button>
      )}

      {assistantOpen && (
        <section className={css.assistantPanelHeader} role="dialog" aria-label="投研助理面板">
          <div>
            <strong>投研助理</strong>
            <span>{assistantStarting ? '正在汇集投研数据并创建新对话…' : assistantContextLabel}</span>
            {assistantError !== '' && <em role="alert">{assistantError}</em>}
          </div>
          <button type="button" disabled={assistantStarting} onClick={() => { askAssistant('') }}>新对话</button>
          <button type="button" aria-label="关闭投研助理" onClick={() => { setAssistantOpen(false) }}>×</button>
        </section>
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

/** Opportunity workbench with independently settling market data regions. */
export function OpportunityPage({
  requestData, initialQuery, showOverview = false, onAnalyze, onView,
}: {
  requestData: RequestData
  initialQuery: string
  showOverview?: boolean
  onAnalyze: (prompt: string) => void
  onView: (code: string) => void
}) {
  const [kind, setKind] = useState('gainers')
  const [nonce, setNonce] = useState(0)
  const [selected, setSelected] = useState(initialQuery)
  const scan = useRequestResource(requestData)
  const news = useRequestResource(requestData)
  const signal = useRequestResource(requestData)
  const overview = useRequestResource(requestData)
  const alertRules = useRequestResource(requestData)

  useEffect(() => {
    if (!showOverview) return
    overview.run({ operation: 'market-watch.overview' })
    alertRules.run({ operation: 'market-watch.alerts' })
  }, [alertRules.run, nonce, overview.run, showOverview])

  useEffect(() => {
    const query = initialQuery.trim()
    if (query !== '') setSelected(query)
  }, [initialQuery])

  useEffect(() => {
    scan.run({ operation: 'market-watch.scan', input: { kind, top_n: 12 } })
  }, [kind, nonce, scan.run])

  useEffect(() => {
    news.run({ operation: 'market-watch.news-flash', input: { limit: 12, enrich: false, personal: false } })
  }, [news.run, nonce])

  const rows = useMemo(() => {
    const record = asRecord(scan.state.value)
    return [...records(record.items), ...records(record.limit_up), ...records(record.limit_down)]
  }, [scan.state.value])

  useEffect(() => {
    if (scan.state.phase !== 'success') return
    if (rows.some(row => text(row.code, '') === selected)) return
    setSelected(text(rows[0]?.code, ''))
  }, [rows, scan.state.phase, selected])

  useEffect(() => {
    const code = selected.trim()
    if (code === '') { signal.reset(); return }
    signal.run({ operation: 'market-watch.tech-signal', input: { code, lookback: 120 } })
  }, [nonce, selected, signal.reset, signal.run])

  const signalRecord = asRecord(signal.state.value)
  const indicators = asRecord(signalRecord.indicators)
  const support = asRecord(indicators.support_resistance)
  const newsRecord = asRecord(news.state.value)
  const headlines = Array.isArray(news.state.value)
    ? news.state.value
    : records(newsRecord.items)
  const newsSettled = newsRecord.stale === true
    ? '缓存资讯'
    : newsRecord.complete === false ? '部分来源' : undefined
  const resources = selected.trim() === ''
    ? [scan.state, news.state]
    : [scan.state, news.state, signal.state]
  if (showOverview) resources.unshift(overview.state, alertRules.state)
  const busy = resources.some(resource => resource.phase === 'loading' || resource.phase === 'refreshing')
  const overviewRows = records(asRecord(overview.state.value).items)
  const rules = records(asRecord(alertRules.state.value).items)

  return (
    <div className={css.pageScroll}>
      <PageHeader title="实时盯盘" description="扫描行情异动、技术信号与市场快讯，快速发现值得研究的线索。">
        <button
          type="button"
          className={css.secondaryButton}
          aria-busy={busy}
          disabled={busy}
          onClick={() => { setNonce(value => value + 1) }}
        >{busy ? '加载中…' : '刷新数据'}</button>
      </PageHeader>
      {showOverview && (
        <div className={css.watchOverviewGrid}>
          <section className={css.tableCard} aria-busy={overview.busy} aria-labelledby="watch-overview-title">
            <div className={css.sectionHeading}>
              <strong id="watch-overview-title">自选实时行情</strong>
              <ResourceLabel state={overview.state} settled={`${overviewRows.length} 只自选`} />
            </div>
            {overview.state.error !== '' && (
              <ErrorCard
                title={overview.state.loaded ? '自选行情更新失败' : '自选行情暂不可用'}
                message={overview.state.error}
                retry={() => { overview.run({ operation: 'market-watch.overview' }) }}
                retained={overview.state.loaded}
              />
            )}
            {!overview.state.loaded && overview.state.error === '' && <LoadingSkeleton rows={3} />}
            {overview.state.loaded && overviewRows.length === 0 && (
              <div className={css.emptyState}>自选列表为空，可让投研助理添加关注标的。</div>
            )}
            {overview.state.loaded && overviewRows.length > 0 && (
              <div className={css.v2TableWrap}>
                <table>
                  <thead><tr><th>标的</th><th>现价</th><th>涨跌幅</th><th>量比</th><th>主力净流入</th><th>规则状态</th></tr></thead>
                  <tbody>
                    {overviewRows.map((row, index) => {
                      const code = text(row.code, String(index))
                      const hits = records(row.hit)
                      const near = records(row.near)
                      return (
                        <tr key={code}>
                          <td><button type="button" className={css.codeButton} onClick={() => { onView(code) }}><strong>{text(row.name, code)}</strong><small>{code}</small></button></td>
                          <td>{money(row.price)}</td>
                          <td className={(number(row.pct_change) ?? 0) < 0 ? css.negative : css.positive}>{percent(row.pct_change)}</td>
                          <td>{number(row.volume_ratio)?.toFixed(2) ?? '—'}</td>
                          <td>{number(row.fund_flow_yi)?.toFixed(2) ?? '—'} 亿</td>
                          <td><span className={css.watchRuleState} data-hit={hits.length > 0 ? 'true' : undefined}>{hits.length > 0 ? `命中 ${hits.length}` : near.length > 0 ? `逼近 ${near.length}` : '正常'}</span></td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
          <section className={css.panelCard} aria-busy={alertRules.busy} aria-labelledby="watch-rules-title">
            <div className={css.sectionHeading}>
              <strong id="watch-rules-title">条件预警</strong>
              <ResourceLabel state={alertRules.state} settled={`${rules.length} 条规则`} />
            </div>
            {alertRules.state.error !== '' && (
              <ErrorCard
                title={alertRules.state.loaded ? '预警规则更新失败' : '预警规则暂不可用'}
                message={alertRules.state.error}
                retry={() => { alertRules.run({ operation: 'market-watch.alerts' }) }}
                retained={alertRules.state.loaded}
              />
            )}
            {!alertRules.state.loaded && alertRules.state.error === '' && <LoadingSkeleton rows={3} />}
            {alertRules.state.loaded && rules.slice(0, 4).map((rule, index) => (
              <div className={css.watchRule} key={text(rule.id, String(index))}>
                <div><strong>{text(rule.name, '未命名规则')}</strong><span>{text(rule.ticker, '全部自选')}</span></div>
                <span data-enabled={rule.enabled === false ? 'false' : 'true'}>{rule.enabled === false ? '已暂停' : '监控中'}</span>
              </div>
            ))}
            {alertRules.state.loaded && rules.length === 0 && <div className={css.emptyState}>暂未配置预警规则。</div>}
            <button type="button" className={css.secondaryButton} onClick={() => { onAnalyze('请帮我创建一条盯盘预警规则，并先询问标的、触发条件与通知频率。') }}>创建预警</button>
          </section>
        </div>
      )}
      <div className={css.segmented} role="group" aria-label="市场扫描类型">
        {SCAN_KINDS.map(([value, label]) => (
          <button
            key={value}
            type="button"
            className={kind === value ? css.segmentActive : undefined}
            aria-pressed={kind === value}
            onClick={() => { setKind(value) }}
          >{label}</button>
        ))}
      </div>
      <ResourceProgress label="机会数据" resources={resources} />
      <div className={css.opportunityGrid}>
        <section className={css.cardList} aria-busy={scan.busy} aria-labelledby="market-scan-title">
          <div className={css.sectionHeading}>
            <strong id="market-scan-title">市场扫描</strong>
            <ResourceLabel state={scan.state} settled={`${rows.length} 个结果`} />
          </div>
          {scan.state.error !== '' && (
            <ErrorCard
              title={scan.state.loaded ? '市场扫描更新失败' : '市场扫描暂不可用'}
              message={scan.state.error}
              retry={() => { scan.run({ operation: 'market-watch.scan', input: { kind, top_n: 12 } }) }}
              retained={scan.state.loaded}
            />
          )}
          {!scan.state.loaded && scan.state.error === '' && <LoadingSkeleton rows={5} />}
          {scan.state.loaded && (
            <>
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
            </>
          )}
        </section>
        <section className={css.detailCard} aria-label="股票研究详情">
          <div className={css.detailTitle}>
            <div><strong>{text(signalRecord.name, selected || '选择一只股票')}</strong><span>{text(signalRecord.code, selected)}</span></div>
            {selected !== '' && (
              <div className={css.detailActions}>
                <button type="button" className={css.secondaryButton} onClick={() => { onView(selected) }}>查看个股详情</button>
                <button
                  type="button"
                  className={css.primaryButton}
                  onClick={() => {
                    onAnalyze(`请深度分析 ${selected}，结合技术信号、基本面和主要风险给出研究结论。`)
                  }}
                >在智能助手中分析</button>
              </div>
            )}
          </div>
          <div className={css.dataRegion} aria-busy={signal.busy} aria-labelledby="technical-signal-title">
            <div className={css.sectionHeading}>
              <strong id="technical-signal-title">技术信号</strong>
              <ResourceLabel state={signal.state} />
            </div>
            {signal.state.error !== '' && selected !== '' && (
              <ErrorCard
                title={signal.state.loaded ? '技术信号更新失败' : '技术信号暂不可用'}
                message={signal.state.error}
                retry={() => {
                  signal.run({ operation: 'market-watch.tech-signal', input: { code: selected, lookback: 120 } })
                }}
                retained={signal.state.loaded}
              />
            )}
            {selected !== '' && !signal.state.loaded && signal.state.error === '' && <LoadingSkeleton rows={3} />}
            {signal.state.loaded && (
              <>
                <div className={css.signalGrid}>
                  <Metric label="K 线样本" value={number(signalRecord.bars)?.toFixed(0) ?? '—'} />
                  <Metric label="支撑位" value={number(support.support)?.toFixed(2) ?? '—'} />
                  <Metric label="压力位" value={number(support.resistance)?.toFixed(2) ?? '—'} />
                  <Metric label="数据时间" value={text(signalRecord.as_of)} />
                </div>
                <div className={css.signalList}>
                  <h3>技术信号</h3>
                  {(Array.isArray(signalRecord.signals) ? signalRecord.signals : []).map((item, index) => (
                    <p key={index}>{String(item)}</p>
                  ))}
                  {!Array.isArray(signalRecord.signals) && <p>当前数据源未返回技术信号。</p>}
                </div>
              </>
            )}
            {selected === '' && <div className={css.emptyState}>选择扫描结果后加载技术信号。</div>}
          </div>
          <div className={css.newsList} aria-busy={news.busy} aria-labelledby="market-news-title">
            <div className={css.sectionHeading}>
              <h3 id="market-news-title">实时资讯（基础）</h3>
              <ResourceLabel state={news.state} {...(newsSettled === undefined ? {} : { settled: newsSettled })} />
            </div>
            {news.state.error !== '' && (
              <ErrorCard
                title={news.state.loaded ? '实时资讯更新失败' : '实时资讯暂不可用'}
                message={news.state.error}
                retry={() => {
                  news.run({ operation: 'market-watch.news-flash', input: { limit: 12, enrich: false, personal: false } })
                }}
                retained={news.state.loaded}
              />
            )}
            {!news.state.loaded && news.state.error === '' && <LoadingSkeleton rows={4} />}
            {news.state.loaded && (
              <>
                {headlines.slice(0, 8).map((item, index) => {
                  const row = asRecord(item)
                  const title = text(row.title, text(row.summary, '市场快讯'))
                  const source = text(row.source, text(row.tag, '资讯源'))
                  const url = safeExternalNewsUrl(row.url)
                  return (
                    <article key={text(row.id, String(index))}>
                      <div className={css.newsHeadline}>
                        {url === undefined
                          ? <strong>{title}</strong>
                          : (
                            <a href={url} target="_blank" rel="noopener noreferrer" aria-label={`${title}（打开原文）`}>
                              <strong>{title}</strong><span aria-hidden="true">↗</span>
                            </a>
                          )}
                        <small>{source}{url === undefined ? ' · 暂无原文链接' : ' · 原文'}</small>
                      </div>
                      <time>{text(row.time, text(row.ts, ''))}</time>
                    </article>
                  )
                })}
                {headlines.length === 0 && <p>当前数据源未返回资讯。</p>}
              </>
            )}
          </div>
        </section>
      </div>
    </div>
  )
}

function StockDetailPage({
  requestData, code, onBack, onAnalyze,
}: { requestData: RequestData; code: string; onBack: () => void; onAnalyze: (prompt: string) => void }) {
  const [nonce, setNonce] = useState(0)
  const [detail, setDetail] = useState<unknown>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    const normalized = code.trim()
    if (normalized === '') {
      setError('缺少股票代码，请重新搜索。'); setLoading(false)
      return
    }
    let alive = true
    setLoading(true); setError('')
    requestData({ operation: 'market-watch.security-detail', input: { code: normalized, lookback: 120 } })
      .then((value) => { if (alive) { setDetail(value); setLoading(false) } })
      .catch((reason: unknown) => {
        if (!alive) return
        setError(reason instanceof Error ? reason.message : String(reason)); setLoading(false)
      })
    return () => { alive = false }
  }, [code, nonce, requestData])

  const record = asRecord(detail)
  const quote = asRecord(record.quote)
  const technical = asRecord(record.technical)
  const indicators = asRecord(technical.indicators)
  const movingAverages = asRecord(indicators.ma)
  const support = asRecord(indicators.support_resistance)
  const last = asRecord(technical.last)
  const newsItems = records(record.news)
  const technicalSignals = Array.isArray(technical.signals) ? technical.signals : []
  const warnings = Array.isArray(record.warnings) ? record.warnings : []
  const resolvedCode = text(record.code, code)
  const name = text(record.name, resolvedCode)
  const pctChange = number(quote.pct_change)
  const amountYi = number(quote.amount_yi)
  const fundFlow = number(record.fund_flow_yi)

  return (
    <div className={css.pageScroll}>
      <PageHeader title={loading ? '个股详情' : `${name} · ${resolvedCode}`} description="实时行情、技术位置、资金与个股资讯的统一研究视图">
        <button type="button" className={css.secondaryButton} onClick={onBack}>返回实时盯盘</button>
        <button type="button" className={css.secondaryButton} onClick={() => { setNonce(value => value + 1) }}>刷新详情</button>
        {!loading && error === '' && (
          <button
            type="button"
            className={css.primaryButton}
            onClick={() => {
              onAnalyze(`请深度分析 ${name}（${resolvedCode}），结合当前行情、技术信号、基本面和主要风险给出研究结论。`)
            }}
          >在智能助手中分析</button>
        )}
      </PageHeader>
      {error !== '' && <ErrorCard title="个股详情暂不可用" message={error} retry={() => { setNonce(value => value + 1) }} />}
      {loading && <div className={css.loadingCard}>正在加载 {code} 的真实行情与研究数据…</div>}
      {!loading && error === '' && (
        <div className={css.stockDetailGrid}>
          <section className={css.stockHeroCard}>
            <div className={css.stockIdentity}>
              <div><strong>{name}</strong><span>{resolvedCode}</span></div>
              <div>
                <strong>{money(quote.price)}</strong>
                <span className={pctChange !== undefined && pctChange < 0 ? css.negative : css.positive}>{percent(quote.pct_change)}</span>
              </div>
            </div>
            <div className={css.metricRow}>
              <Metric label="今开" value={money(last.open)} />
              <Metric label="最高" value={money(last.high)} />
              <Metric label="最低" value={money(last.low)} />
              <Metric label="昨收/收盘" value={money(last.close)} />
            </div>
            <div className={css.metricRow}>
              <Metric label="成交额" value={amountYi === undefined ? '—' : `${amountYi.toFixed(2)} 亿`} />
              <Metric label="换手率" value={percent(quote.turnover)} />
              <Metric label="量比" value={number(quote.volume_ratio)?.toFixed(2) ?? '—'} />
              <Metric label="主力净流入" value={fundFlow === undefined ? '—' : `${fundFlow.toFixed(3)} 亿`} />
            </div>
            <small className={css.dataTimestamp}>数据时间：{text(record.as_of)}</small>
          </section>

          <section className={css.panelCard}>
            <div className={css.sectionHeading}><strong>技术位置</strong><span>{number(technical.bars)?.toFixed(0) ?? '—'} 根日 K</span></div>
            <div className={css.signalGrid}>
              <Metric label="支撑位" value={number(support.support)?.toFixed(2) ?? '—'} />
              <Metric label="压力位" value={number(support.resistance)?.toFixed(2) ?? '—'} />
              <Metric label="MA20" value={number(movingAverages.ma20)?.toFixed(2) ?? '—'} />
              <Metric label="MA60" value={number(movingAverages.ma60)?.toFixed(2) ?? '—'} />
            </div>
            <div className={css.signalList}>
              <h3>当前信号</h3>
              {technicalSignals.map((item, index) => <p key={index}>{String(item)}</p>)}
              {technicalSignals.length === 0 && <p>{warnings.length > 0 ? String(warnings[0]) : '当前没有可展示的技术信号。'}</p>}
            </div>
          </section>

          <section className={`${css.panelCard} ${css.stockNewsCard}`}>
            <div className={css.sectionHeading}><strong>个股资讯</strong><span>{newsItems.length} 条</span></div>
            <div className={css.newsList}>
              {newsItems.map((item, index) => (
                <article key={`${text(item.title, '')}-${index}`}>
                  <strong>{text(item.title, '个股资讯')}</strong>
                  <span>{text(item.source)} · {text(item.time)}</span>
                </article>
              ))}
              {newsItems.length === 0 && <p>当前数据源未返回个股资讯。</p>}
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
      setError(errorText(reason))
      setSaving(false)
    }
  }

  const dialog = (
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

  return typeof document === 'undefined' ? dialog : createPortal(dialog, document.body)
}

/** Portfolio workbench with independently settling holdings, risk, and alert regions. */
export function PortfolioPage({ requestData, onAnalyze }: { requestData: RequestData; onAnalyze: (prompt: string) => void }) {
  const [nonce, setNonce] = useState(0)
  const [importOpen, setImportOpen] = useState(false)
  const [notice, setNotice] = useState('')
  const holdings = useRequestResource(requestData)
  const risk = useRequestResource(requestData)
  const alerts = useRequestResource(requestData)

  useEffect(() => {
    holdings.run({ operation: 'trading-core.holdings' })
    risk.run({ operation: 'trading-core.risk-portfolio' })
    alerts.run({ operation: 'trading-core.risk-alerts' })
  }, [alerts.run, holdings.run, nonce, risk.run])

  const positions = records(asRecord(holdings.state.value).items)
  const riskRecord = asRecord(risk.state.value)
  const summary = asRecord(riskRecord.summary)
  const breaches = records(riskRecord.breaches)
  const alertItems = records(asRecord(alerts.state.value).items)
  const equalWeight = number(summary.equal_weight)
  const resources = [holdings.state, risk.state, alerts.state]
  const busy = resources.some(resource => resource.phase === 'loading' || resource.phase === 'refreshing')

  return (
    <div className={css.pageScroll}>
      <PageHeader title="我的投研" description="管理持仓，检查风险预算，并把当前上下文带入智能分析。">
        <button type="button" className={css.secondaryButton} onClick={() => { setNotice(''); setImportOpen(true) }}>
          <ImportIcon /><span className={css.actionLabel}>导入持仓</span>
        </button>
        <button
          type="button"
          className={css.secondaryButton}
          aria-busy={busy}
          disabled={busy}
          onClick={() => { setNonce(value => value + 1) }}
        >{busy ? '加载中…' : '刷新'}</button>
        <button
          type="button"
          className={css.primaryButton}
          onClick={() => {
            onAnalyze('请分析我当前保存的全部持仓，重点评估集中度、回撤风险和需要优先处理的预警。')
          }}
        >发起持仓深度分析</button>
      </PageHeader>
      {notice !== '' && <div className={css.importNotice} role="status">{notice}</div>}
      <ResourceProgress label="持仓数据" resources={resources} />
      <section className={css.riskSummary} aria-busy={risk.busy} aria-labelledby="risk-summary-title">
        <div className={css.sectionHeading}>
          <strong id="risk-summary-title">组合风险概览</strong>
          <ResourceLabel state={risk.state} />
        </div>
        {risk.state.error !== '' && (
          <ErrorCard
            title={risk.state.loaded ? '组合风险更新失败' : '组合风险暂不可用'}
            message={risk.state.error}
            retry={() => { risk.run({ operation: 'trading-core.risk-portfolio' }) }}
            retained={risk.state.loaded}
          />
        )}
        {!risk.state.loaded && risk.state.error === '' && <LoadingSkeleton rows={2} />}
        {risk.state.loaded && (
          <div className={css.metricRow}>
            <Metric label="持仓数量" value={number(summary.n_positions)?.toFixed(0) ?? String(positions.length)} />
            <Metric label="风险画像" value={text(riskRecord.profile_label)} />
            <Metric label="等权占比" value={equalWeight === undefined ? '—' : `${(equalWeight * 100).toFixed(1)}%`} />
            <Metric label="集中度 HHI" value={number(summary.hhi)?.toFixed(3) ?? '—'} />
          </div>
        )}
      </section>
      <div className={css.portfolioGrid}>
        <section className={css.tableCard} aria-busy={holdings.busy} aria-labelledby="holdings-title">
          <div className={css.sectionHeading}>
            <strong id="holdings-title">当前持仓</strong>
            <ResourceLabel state={holdings.state} settled={`${positions.length} 项`} />
          </div>
          {holdings.state.error !== '' && (
            <ErrorCard
              title={holdings.state.loaded ? '持仓更新失败' : '持仓暂不可用'}
              message={holdings.state.error}
              retry={() => { holdings.run({ operation: 'trading-core.holdings' }) }}
              retained={holdings.state.loaded}
            />
          )}
          {!holdings.state.loaded && holdings.state.error === '' && <LoadingSkeleton rows={5} />}
          {holdings.state.loaded && (
            <>
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
            </>
          )}
        </section>
        <section className={css.riskColumn} aria-label="持仓风险详情">
          <div className={css.panelCard} aria-busy={risk.busy}>
            <div className={css.sectionHeading}>
              <strong>风险预算突破</strong>
              <ResourceLabel state={risk.state} settled={String(breaches.length)} />
            </div>
            {risk.state.loaded && (
              <>
                {breaches.map((item, index) => <RiskRow key={text(item.indicator, String(index))} item={item} />)}
                {breaches.length === 0 && <div className={css.goodState}>当前没有检测到风险预算突破</div>}
              </>
            )}
          </div>
          <div className={css.panelCard} aria-busy={alerts.busy}>
            <div className={css.sectionHeading}>
              <strong>风险预警中心</strong>
              <ResourceLabel state={alerts.state} settled={String(alertItems.length)} />
            </div>
            {alerts.state.error !== '' && (
              <ErrorCard
                title={alerts.state.loaded ? '风险预警更新失败' : '风险预警暂不可用'}
                message={alerts.state.error}
                retry={() => { alerts.run({ operation: 'trading-core.risk-alerts' }) }}
                retained={alerts.state.loaded}
              />
            )}
            {!alerts.state.loaded && alerts.state.error === '' && <LoadingSkeleton rows={3} />}
            {alerts.state.loaded && (
              <>
                {alertItems.slice(0, 12).map((item, index) => <AlertRow key={text(item.id, String(index))} item={item} />)}
                {alertItems.length === 0 && <div className={css.emptyState}>当前没有预警记录</div>}
              </>
            )}
          </div>
        </section>
      </div>
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

function PageHeader({ title, description, children }: { title: string; description: string; children?: ReactNode }) {
  return <div className={css.pageHeader}><div><h1>{title}</h1><p>{description}</p></div><div>{children}</div></div>
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className={css.metric}><span>{label}</span><strong>{value}</strong></div>
}

function ResourceProgress({ label, resources }: { label: string; resources: readonly ResourceState[] }) {
  const busy = resources.filter(resource => resource.phase === 'loading' || resource.phase === 'refreshing')
  const completed = resources.filter(resource => resource.phase !== 'idle' && !busy.includes(resource)).length
  const available = resources.filter(resource => resource.loaded).length
  const failed = resources.some(resource => resource.phase === 'error')
  const refreshing = resources.some(resource => resource.phase === 'refreshing')
  const idle = resources.every(resource => resource.phase === 'idle')
  const message = idle
    ? `准备加载${label}…`
    : busy.length > 0
      ? `${refreshing ? '正在更新' : '正在加载'}${label}，已完成 ${completed}/${resources.length} 项；数据会在完成后逐项显示。`
      : failed
        ? `${label}部分暂不可用，已显示 ${available}/${resources.length} 项。`
        : `${label}已加载，共 ${available}/${resources.length} 项可用。`
  return <div className={css.progressStatus} role="status" aria-live="polite">{message}</div>
}

function ResourceLabel({ state, settled }: { state: ResourceState; settled?: string }) {
  const label = state.phase === 'loading'
    ? '加载中…'
    : state.phase === 'refreshing'
      ? '更新中…'
      : state.phase === 'error'
        ? state.loaded ? '保留上次数据' : '加载失败'
        : settled
  return label === undefined ? null : <span className={css.resourceLabel}>{label}</span>
}

function LoadingSkeleton({ rows }: { rows: number }) {
  return (
    <div className={css.loadingSkeleton} aria-hidden="true">
      {Array.from({ length: rows }, (_, index) => <span key={index} />)}
    </div>
  )
}

function ErrorCard({
  title, message, retry, retained = false,
}: { title: string; message: string; retry: () => void; retained?: boolean }) {
  return (
    <div className={css.errorCard} role="alert" data-retained={retained || undefined}>
      <div><strong>{title}</strong><p>{message}</p></div>
      <button type="button" aria-label={`重试${title}`} onClick={retry}>重试</button>
    </div>
  )
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
