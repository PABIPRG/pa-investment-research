import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode, RefObject } from 'react'
import { createPortal } from 'react-dom'
import packageManifest from '@deepseek-ai/dsh-client-ui-investment-research/package.json' with { type: 'json' }
import type {
  SessionId, SessionSearchResultItem,
} from '@deepseek-ai/dsh-client-runtime/client'
import type {
  HostObservable, InjectFace, PropsRuntime,
} from '@deepseek-ai/dsh-client-ui-slots'
import { IconChevronDownOutline14, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SidebarSectionOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { HeroWelcomeOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { InvestmentDataRequest } from '@deepseek-ai/dsh-client-investment-research-runtime/client'
import type { AssistantIntent } from './assistant-intent.ts'
import { SmartAnalysisPage } from './AnalysisPage.tsx'
import { asRecord, money, number, percent, productErrorText, records, text } from './data.ts'
import {
  DetailDialog, EventReportDialog, RiskDetailDialog, eventPrimaryTicker, riskIntentTarget,
} from './DetailDialogs.tsx'
import { parseHoldingsImport } from './holdings-import.ts'
import {
  EvolutionPage,
  IndustryChainPage,
  ReportCenter,
  StrategyResearchPage,
} from './ProductPages.tsx'
import { ResearchWorkbenchPage } from './ResearchWorkbenchPage.tsx'
import type {
  AssistantDisplayMode, AssistantModule, InvestmentDraftKey, InvestmentNavigationContext,
  InvestmentRoute, InvestmentUiSnapshot,
} from './state.ts'
import css from './InvestmentShell.module.css'

type RequestData = (request: InvestmentDataRequest) => Promise<unknown>

export const INVESTMENT_APP_VERSION = packageManifest.version

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
        setState(current => ({ ...current, phase: 'error', error: productErrorText(reason) }))
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
  navigate: (route: InvestmentRoute, context?: InvestmentNavigationContext) => void
}

export type InvestmentSidebarInjected = UiInjected

export type InvestmentSidebarProps = PropsRuntime<'sidebar.workspaces'>
  & SidebarSectionOwnerProps
  & InjectFace<InvestmentSidebarInjected>

export interface InvestmentShellInjected extends UiInjected {
  requestData: RequestData
  setHistory: (open: boolean) => void
  setReports: (open: boolean) => void
  setAssistantMode: (mode: AssistantDisplayMode) => void
  setAssistantModule: (module: AssistantModule) => void
  setModuleDraft: (key: InvestmentDraftKey, value: string) => void
  selectStrategy: (strategyId: string) => void
  startSession: () => Promise<void>
  openSession: (sessionId: SessionId) => Promise<void>
  searchSessions: (query: string, signal: AbortSignal) => Promise<readonly SessionSearchResultItem[]>
  renameSession: (sessionId: SessionId, title: string) => Promise<void>
  archiveSession: (sessionId: SessionId) => Promise<void>
  prepareAssistant: (intent: AssistantIntent, module?: AssistantModule) => void
  toggleTheme: () => void
}

export type InvestmentShellProps = PropsRuntime<'shell.overlay'> & InjectFace<InvestmentShellInjected>
export type InvestmentBrandProps = PropsRuntime<'sidebar.brand'>
export type InvestmentNewSessionProps = PropsRuntime<'sidebar.newSession'>
export type InvestmentWelcomeProps = PropsRuntime<'conversation.hero.welcome'> & HeroWelcomeOwnerProps

type NavigationRoute = Exclude<InvestmentRoute, 'stock-detail' | 'assistant' | 'projects'>

const ROUTES: readonly { id: NavigationRoute; label: string; note?: string }[] = [
  { id: 'dashboard', label: '研究工作台', note: '总览' },
  { id: 'analysis', label: '智能分析', note: 'AI' },
  { id: 'opportunity', label: '实时盯盘', note: '实时' },
  { id: 'framework', label: '策略研究', note: '策略' },
  { id: 'tasks', label: '自进化', note: '闭环' },
  { id: 'portfolio', label: '我的投研', note: '组合' },
  { id: 'knowledge', label: '产业链', note: '图谱' },
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

function AssistantResizeIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg
      className={css.actionIcon}
      viewBox="0 0 16 16"
      aria-hidden="true"
      data-icon={expanded ? 'assistant-collapse' : 'assistant-expand'}
    >
      {expanded
        ? <><path d="M7 2.5V7H2.5" /><path d="m2.5 7 4.5-4.5" /><path d="M9 13.5V9h4.5" /><path d="M13.5 9 9 13.5" /></>
        : <><path d="M6.5 2.5h-4v4" /><path d="m2.5 2.5 4.5 4.5" /><path d="M9.5 13.5h4v-4" /><path d="M13.5 13.5 9 9" /></>}
    </svg>
  )
}

function ReportIcon() {
  return (
    <svg className={css.actionIcon} viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3.25 2.5h6.5l3 3v8H3.25z" />
      <path d="M9.75 2.5v3h3M5.25 8h5.5M5.25 10.5h5.5" />
    </svg>
  )
}

function ThemeIcon({ scheme }: { scheme: 'light' | 'dark' }) {
  return (
    <svg className={css.themeIcon} viewBox="0 0 16 16" aria-hidden="true" data-icon={scheme === 'dark' ? 'moon' : 'sun'}>
      {scheme === 'dark'
        ? <path d="M12.75 10.1A5.35 5.35 0 0 1 5.9 3.25 5.35 5.35 0 1 0 12.75 10.1Z" />
        : <>
          <circle cx="8" cy="8" r="2.75" />
          <path d="M8 1.25v1.5M8 13.25v1.5M1.25 8h1.5M13.25 8h1.5M3.23 3.23l1.06 1.06M11.71 11.71l1.06 1.06M12.77 3.23l-1.06 1.06M4.29 11.71l-1.06 1.06" />
        </>}
    </svg>
  )
}

function useActiveColorScheme(): 'light' | 'dark' {
  const read = (): 'light' | 'dark' => document.body.hasAttribute('data-ds-dark-theme') ? 'dark' : 'light'
  const [scheme, setScheme] = useState<'light' | 'dark'>(read)
  useEffect(() => {
    const observer = new MutationObserver(() => { setScheme(read()) })
    observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
    setScheme(read())
    return () => { observer.disconnect() }
  }, [])
  return scheme
}

function ImportIcon() {
  return (
    <svg className={css.actionIcon} viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 2.5v7M5.25 7l2.75 2.75L10.75 7" />
      <path d="M3 11v2.5h10V11" />
    </svg>
  )
}

function NavGlyph({ route }: { route: NavigationRoute }) {
  const glyph = {
    dashboard: <><rect x="3" y="3" width="6" height="6" rx="1" /><rect x="11" y="3" width="6" height="6" rx="1" /><rect x="3" y="11" width="6" height="6" rx="1" /><rect x="11" y="11" width="6" height="6" rx="1" /></>,
    analysis: <><path d="M10 2.8 11.8 7l4.2 1.8-4.2 1.8-1.8 4.2-1.8-4.2L4 8.8 8.2 7 10 2.8Z" /><path d="m15.5 2.8.6 1.5 1.5.6-1.5.6-.6 1.5-.6-1.5-1.5-.6 1.5-.6.6-1.5Z" /></>,
    opportunity: <><path d="M3.5 15.5 8 11l3 2 5.5-7" /><path d="M12.5 6h4v4" /></>,
    'stock-detail': <><path d="M3.5 15.5 8 11l3 2 5.5-7" /><path d="M12.5 6h4v4" /></>,
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
        <small>v{INVESTMENT_APP_VERSION} · 智能投研系统</small>
      </span>
    </div>
  )
}

/** Session creation is owned by the profile top bar, so the shared duplicate is suppressed. */
export function InvestmentNewSession(_props: InvestmentNewSessionProps) {
  return null
}

interface ResearchExpert {
  readonly id: 'stock' | 'industry' | 'portfolio' | 'strategy' | 'watch'
  readonly label: string
  readonly role: string
  readonly summary: string
  readonly prompt: string
  readonly tools: readonly string[]
  readonly sources: readonly string[]
  readonly outputs: readonly string[]
}

const RESEARCH_EXPERTS: readonly ResearchExpert[] = [
  {
    id: 'stock', label: '个股研究专家', role: '基本面 · 估值 · 风险',
    summary: '拆解公司经营、估值位置、催化与主要下行风险，形成可继续跟踪的研究结论。',
    prompt: '请调用 analyze_stock 工具完成个股研究；如需组合或行业信息，请再通过 investment_context 工具按需读取上下文。',
    tools: ['analyze_stock', 'investment_context'],
    sources: ['公司与行情分析结果', '关联行业与持仓上下文'],
    outputs: ['核心投资逻辑', '估值与关键指标', '风险清单', '后续观察信号'],
  },
  {
    id: 'industry', label: '产业链研究专家', role: '行业景气 · 上下游 · 影响传导',
    summary: '从产业链结构、供需变化和事件传导路径识别机会与风险。',
    prompt: '请调用 investment_context 工具读取 industry 上下文，梳理目标行业的景气信号、产业链传导与相关标的。',
    tools: ['investment_context（industry）'],
    sources: ['产业链图谱', '行业事件与关联标的'],
    outputs: ['景气判断', '上中下游影响', '受益与承压环节', '验证信号'],
  },
  {
    id: 'portfolio', label: '组合风控专家', role: '持仓诊断 · 风险预算 · 处置建议',
    summary: '复核持仓集中度、画像预算与关联预警，给出分级处理顺序。',
    prompt: '请调用 investment_context 工具读取 portfolio 上下文，诊断当前组合的集中度、风险预算突破与关联事件，并给出分级建议。',
    tools: ['investment_context（portfolio）'],
    sources: ['真实持仓', '组合风险预算', '风险预警'],
    outputs: ['风险排序', '触发原因', '受影响持仓', '复核与调整建议'],
  },
  {
    id: 'strategy', label: '策略验证专家', role: '假设 · 回测 · 影子验证',
    summary: '复核策略假设、样本外阈值和纸面验证证据，判断下一生命周期动作。',
    prompt: '请调用 investment_context 工具读取 strategy 上下文，复核当前策略的假设、样本外证据和影子验证准入条件。',
    tools: ['investment_context（strategy）'],
    sources: ['策略库', '样本内/样本外回测', '影子账户证据'],
    outputs: ['假设可证伪性', '阈值判定', '证据缺口', '继续/退回/归档建议'],
  },
  {
    id: 'watch', label: '实时盯盘专家', role: '异动 · 事件 · 观察清单',
    summary: '结合盘中异动、关注列表和关联事件，整理当下最值得核验的信号。',
    prompt: '请调用 investment_context 工具读取 watch 上下文，整理当前异动、关联事件和需要继续观察的信号。',
    tools: ['investment_context（watch）'],
    sources: ['盘中异动', '关注列表', '关联事件'],
    outputs: ['异动摘要', '可能原因', '关联标的', '观察与失效条件'],
  },
]

/** Blank Session chrome only; structured analysis belongs to SmartAnalysisPage. */
export function InvestmentWelcome(_props: InvestmentWelcomeProps) {
  return (
    <section className={css.investmentWelcome} aria-labelledby="investment-welcome-title">
      <span className={css.welcomeMark} aria-hidden="true">✦</span>
      <h1 id="investment-welcome-title">AI 研究助理</h1>
      <p>输入自然语言问题即可。需要业务事实时，助理会通过当前模块的受控工具按需读取。</p>
    </section>
  )
}

export function InvestmentSidebar({
  wide, useInvestmentUi, navigate,
}: InvestmentSidebarProps) {
  const route = useInvestmentUi(s => s.route)
  const activeRoute: NavigationRoute = route === 'stock-detail'
    ? 'opportunity'
    : route === 'projects' ? 'framework' : route === 'assistant' ? 'analysis' : route

  return (
    <div className={wide ? css.sidebarRegion : `${css.sidebarRegion} ${css.sidebarRegionCompact}`}>
      <nav className={css.investmentNav} aria-label="投研功能导航">
        {ROUTES.map(item => (
          <button
            key={item.id}
            type="button"
            className={activeRoute === item.id ? css.navActive : undefined}
            aria-current={activeRoute === item.id ? 'page' : undefined}
            aria-label={item.label}
            title={wide ? undefined : item.label}
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
    setQuery(`${item.name} ${item.code}`)
    setFocused(false)
    navigate('stock-detail', { stockCode: item.code })
  }

  const submit = (): void => {
    const keyword = query.trim()
    const item = items[activeIndex] ?? items[0]
    if (item !== undefined) { select(item); return }
    if (/^\d{6}$/.test(keyword)) {
      setFocused(false)
      navigate('stock-detail', { stockCode: keyword })
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

const GENERAL_ASSISTANT_OPTION = {
  id: 'general', label: '通用研究', note: '根据当前页面按需选择工具',
} as const

const ASSISTANT_MODULE_OPTIONS: readonly { id: AssistantModule; label: string; note: string }[] = [
  GENERAL_ASSISTANT_OPTION,
  ...RESEARCH_EXPERTS.map(expert => ({ id: expert.id, label: expert.label, note: expert.role })),
]

export interface InvestmentAssistantModuleInjected {
  hooks: { investmentUi: HostObservable<InvestmentUiSnapshot> }
  setAssistantModule: (module: AssistantModule) => void
}

export type InvestmentAssistantModuleProps = PropsRuntime<'conversation.input.left'>
  & InjectFace<InvestmentAssistantModuleInjected>

/** Profile-specific research scope picker in the shared composer tool row. */
export function InvestmentAssistantModuleSelect({
  useInvestmentUi, setAssistantModule,
}: InvestmentAssistantModuleProps) {
  const mode = useInvestmentUi(snapshot => snapshot.assistantMode)
  const module = useInvestmentUi(snapshot => snapshot.assistantModule)
  const [open, setOpen] = useState(false)
  const selected = ASSISTANT_MODULE_OPTIONS.find(item => item.id === module) ?? GENERAL_ASSISTANT_OPTION

  useEffect(() => {
    if (mode === 'closed') setOpen(false)
  }, [mode])

  if (mode === 'closed') return null
  return (
    <Menu
      open={open}
      items={ASSISTANT_MODULE_OPTIONS.map(item => ({ id: item.id, label: item.label }))}
      selectedId={module}
      side="top"
      compact
      onClose={() => { setOpen(false) }}
      onSelect={(id) => {
        setOpen(false)
        setAssistantModule(id as AssistantModule)
      }}
      anchor={(
        <button
          type="button"
          className={css.assistantModuleTrigger}
          aria-label={`研究模块，当前：${selected.label}`}
          title={selected.note}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => { setOpen(current => !current) }}
        >
          <span>{selected.label}</span>
          <i className={open ? css.assistantModuleChevronOpen : undefined} aria-hidden="true">
            <IconChevronDownOutline14 />
          </i>
        </button>
      )}
    />
  )
}

/** Natural-language module intent for the shared Host conversation composer. */
export function assistantModulePrompt(module: AssistantModule): string {
  if (module === 'general') return ''
  return RESEARCH_EXPERTS.find(expert => expert.id === module)?.prompt ?? ''
}

function AssistantFloatingSurface({
  mode, module, starting, historyOpen, launcherRef, historyRef,
  onMode, onNew, onHistory,
}: {
  mode: AssistantDisplayMode
  module: AssistantModule
  starting: boolean
  historyOpen: boolean
  launcherRef: RefObject<HTMLButtonElement>
  historyRef: RefObject<HTMLButtonElement>
  onMode: (mode: AssistantDisplayMode) => void
  onNew: () => void
  onHistory: () => void
}) {
  const selected = ASSISTANT_MODULE_OPTIONS.find(item => item.id === module) ?? GENERAL_ASSISTANT_OPTION
  if (mode === 'closed') {
    return (
      <button
        ref={launcherRef}
        type="button"
        className={css.assistantLauncher}
        data-action="assistant-open"
        aria-label="打开 AI 研究助理"
        aria-controls="investment-assistant-panel"
        aria-expanded="false"
        onClick={() => { onMode('docked') }}
      ><span aria-hidden="true">AI</span></button>
    )
  }
  return (
    <>
      {mode === 'expanded' && (
        <div className={css.assistantBackdrop} role="presentation" onMouseDown={() => { onMode('docked') }} />
      )}
      <section
        id="investment-assistant-panel"
        className={css.assistantPanel}
        data-testid="assistant-panel"
        data-mode={mode}
        role={mode === 'expanded' ? 'dialog' : 'complementary'}
        aria-modal={mode === 'expanded' ? 'true' : undefined}
        aria-label="AI 研究助理"
      >
        <header className={css.assistantHeader}>
          <div className={css.assistantIdentity}>
            <span aria-hidden="true">✦</span>
            <div><strong>AI 研究助理</strong><small>{selected.note}</small></div>
          </div>
          <div className={css.assistantHeaderActions}>
            <button
              type="button"
              data-action={mode === 'expanded' ? 'assistant-collapse' : 'assistant-expand'}
              aria-label={mode === 'expanded' ? '收起 AI 助理' : '近全屏展开 AI 助理'}
              title={mode === 'expanded' ? '收起' : '近全屏展开'}
              onClick={() => { onMode(mode === 'expanded' ? 'docked' : 'expanded') }}
            ><AssistantResizeIcon expanded={mode === 'expanded'} /></button>
            <button type="button" data-action="assistant-close" aria-label="关闭 AI 研究助理" title="关闭" onClick={() => { onMode('closed') }}>×</button>
          </div>
        </header>
        <div className={css.assistantToolbar}>
          <div>
            <button type="button" data-action="assistant-new" disabled={starting} aria-busy={starting} onClick={onNew}><PlusIcon />{starting ? '创建中…' : '新对话'}</button>
            <button ref={historyRef} type="button" data-action="assistant-history" aria-haspopup="dialog" aria-expanded={historyOpen} onClick={onHistory}><HistoryIcon />历史</button>
          </div>
        </div>
      </section>
    </>
  )
}

export function InvestmentShell({
  useInvestmentUi, useSessions, useWorkspaces, requestData, navigate, setHistory, setReports,
  setAssistantMode, setModuleDraft, selectStrategy, startSession, openSession, searchSessions, renameSession,
  archiveSession, prepareAssistant, toggleTheme,
}: InvestmentShellProps) {
  const snapshot = useInvestmentUi(s => s)
  const [startingSession, setStartingSession] = useState(false)
  const [switchingSessionId, setSwitchingSessionId] = useState<SessionId | undefined>()
  const [historyClosing, setHistoryClosing] = useState(false)
  const [sessionError, setSessionError] = useState<string | null>(null)
  const historyTriggerRef = useRef<HTMLButtonElement>(null)
  const reportTriggerRef = useRef<HTMLButtonElement>(null)
  const assistantTriggerRef = useRef<HTMLButtonElement>(null)
  const workbenchRef = useRef<HTMLElement>(null)
  const previousAssistantModeRef = useRef<AssistantDisplayMode>('closed')
  const isAnalysisRoute = snapshot.route === 'analysis' || snapshot.route === 'assistant'
  const [analysisVisited, setAnalysisVisited] = useState(isAnalysisRoute)
  const assistantMode = snapshot.assistantMode
  const assistantModule = snapshot.assistantModule
  const colorScheme = useActiveColorScheme()

  useEffect(() => {
    if (isAnalysisRoute) setAnalysisVisited(true)
  }, [isAnalysisRoute])
  useEffect(() => {
    document.body.dataset.investmentAssistantMode = assistantMode
    if (assistantMode === 'closed') document.body.dataset.investmentWorkbenchActive = ''
    else delete document.body.dataset.investmentWorkbenchActive
    return () => {
      delete document.body.dataset.investmentWorkbenchActive
      delete document.body.dataset.investmentAssistantMode
    }
  }, [assistantMode])
  useEffect(() => {
    const previous = previousAssistantModeRef.current
    previousAssistantModeRef.current = assistantMode
    if (previous !== 'closed' && assistantMode === 'closed') {
      window.requestAnimationFrame(() => { assistantTriggerRef.current?.focus() })
    }
  }, [assistantMode])
  useEffect(() => {
    const workbench = workbenchRef.current
    if (workbench === null) return
    if (assistantMode === 'expanded') {
      workbench.setAttribute('inert', '')
      workbench.setAttribute('aria-hidden', 'true')
    } else {
      workbench.removeAttribute('inert')
      workbench.removeAttribute('aria-hidden')
    }
  }, [assistantMode])
  useEffect(() => {
    if (assistantMode === 'closed') return
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || snapshot.historyOpen || snapshot.reportsOpen) return
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        setAssistantMode(assistantMode === 'expanded' ? 'docked' : 'closed')
        return
      }
      if (event.key !== 'Tab' || assistantMode !== 'expanded') return
      const panel = document.getElementById('investment-assistant-panel')
      const conversation = document.querySelector<HTMLElement>('[data-conversation-scroll]')
      const selector = 'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      const focusable = [
        ...(panel?.querySelectorAll<HTMLElement>(selector) ?? []),
        ...(conversation?.querySelectorAll<HTMLElement>(selector) ?? []),
      ].filter(element => element.offsetParent !== null)
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => { window.removeEventListener('keydown', handleKeyDown) }
  }, [assistantMode, setAssistantMode, snapshot.historyOpen, snapshot.reportsOpen])

  const closeHistory = useCallback(() => {
    if (historyClosing) return
    setHistory(false)
    setHistoryClosing(false)
    window.requestAnimationFrame(() => { historyTriggerRef.current?.focus() })
  }, [historyClosing, setHistory])

  const closeReports = useCallback(() => {
    setReports(false)
    window.requestAnimationFrame(() => { reportTriggerRef.current?.focus() })
  }, [setReports])

  const switchSession = useCallback(async (sessionId: SessionId): Promise<void> => {
    if (switchingSessionId !== undefined) return
    setSwitchingSessionId(sessionId)
    setSessionError(null)
    try {
      await openSession(sessionId)
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
            ref={reportTriggerRef}
            type="button"
            className={css.secondaryButton}
            aria-label="投研报告"
            aria-haspopup="dialog"
            aria-expanded={snapshot.reportsOpen}
            aria-controls="investment-report-center"
            title="投研报告"
            onClick={() => { setReports(true) }}
          >
            <ReportIcon /><span className={css.actionLabel}>投研报告</span>
          </button>
          <button
            type="button"
            className={css.themeToggle}
            aria-label={colorScheme === 'dark' ? '当前深色模式，切换为浅色模式' : '当前浅色模式，切换为深色模式'}
            title={colorScheme === 'dark' ? '切换为浅色模式' : '切换为深色模式'}
            onClick={toggleTheme}
          >
            <ThemeIcon scheme={colorScheme} />
          </button>
        </div>
      </header>
      {switchingSessionId !== undefined && (
        <div className={css.sessionProgress} role="status" aria-live="polite">
          <span>正在载入对话…</span>
        </div>
      )}
      {sessionError !== null && <div className={css.sessionError} role="alert">{sessionError}</div>}

      <main ref={workbenchRef} className={css.workbench}>
        {analysisVisited && (
          <div className={css.routeSurface} hidden={!isAnalysisRoute}>
            <SmartAnalysisPage
              requestData={requestData}
              stockQuery={snapshot.analysisQuery}
              backtestQuery={snapshot.backtestQuery}
              onStockQuery={(value) => { setModuleDraft('analysisQuery', value) }}
              onBacktestQuery={(value) => { setModuleDraft('backtestQuery', value) }}
              onOpenReports={() => { setReports(true) }}
              onOpenAssistant={prepareAssistant}
              onOpenPortfolio={() => { navigate('portfolio') }}
            />
          </div>
        )}
        {snapshot.route === 'dashboard' && (
          <ResearchWorkbenchPage
            requestData={requestData}
            navigate={navigate}
            onAnalyze={prepareAssistant}
            onOpenReports={() => { setReports(true) }}
          />
        )}
        {snapshot.route === 'opportunity' && (
          <OpportunityPage
            requestData={requestData}
            initialQuery={snapshot.selectedStockCode || snapshot.watchQuery}
            onAnalyze={prepareAssistant}
            onView={(code) => { navigate('stock-detail', { stockCode: code }) }}
          />
        )}
        {snapshot.route === 'stock-detail' && (
          <StockDetailPage
            requestData={requestData}
            code={snapshot.selectedStockCode}
            onBack={() => { navigate('opportunity') }}
            onAnalyze={prepareAssistant}
          />
        )}
        {snapshot.route === 'portfolio' && (
          <PortfolioPage
            requestData={requestData}
            onAnalyze={prepareAssistant}
            onViewStock={(code) => { navigate('stock-detail', { stockCode: code }) }}
          />
        )}
        {(snapshot.route === 'framework' || snapshot.route === 'projects') && (
          <StrategyResearchPage
            requestData={requestData}
            selectedStrategyId={snapshot.selectedStrategyId}
            onSelectStrategy={selectStrategy}
            onOpenShadow={(strategyId) => { navigate('projects', { strategyId }) }}
            onOpenReports={() => { setReports(true) }}
            onAnalyze={prepareAssistant}
            initialView={snapshot.route === 'projects' ? 'shadow' : 'pool'}
            onOpenEvolution={() => { navigate('tasks') }}
          />
        )}
        {snapshot.route === 'tasks' && (
          <EvolutionPage
            requestData={requestData}
            onAnalyze={prepareAssistant}
            onOpenStock={(code) => { navigate('stock-detail', { stockCode: code }) }}
          />
        )}
        {snapshot.route === 'knowledge' && (
          <IndustryChainPage
            requestData={requestData}
            query={snapshot.chainQuery}
            onQuery={(query) => { setModuleDraft('chainQuery', query) }}
            onAnalyze={prepareAssistant}
            onOpenStock={(code) => { navigate('stock-detail', { stockCode: code }) }}
          />
        )}
      </main>

      <AssistantFloatingSurface
        mode={assistantMode}
        module={assistantModule}
        starting={startingSession}
        historyOpen={snapshot.historyOpen}
        launcherRef={assistantTriggerRef}
        historyRef={historyTriggerRef}
        onMode={setAssistantMode}
        onNew={() => {
          if (startingSession) return
          setStartingSession(true)
          setSessionError(null)
          setHistory(false)
          void startSession()
            .catch(() => { setSessionError('新对话创建失败，请稍后重试。') })
            .finally(() => { setStartingSession(false) })
        }}
        onHistory={() => { setHistoryClosing(false); setHistory(true) }}
      />

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
      {snapshot.reportsOpen && (
        <ReportCenter requestData={requestData} onClose={closeReports} onAnalyze={prepareAssistant} />
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
      className={`${css.drawerBackdrop} ${css.historyBackdrop}`}
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
                            .then(onClose)
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
        <div className={css.drawerFoot}>对话会自动保存在本机</div>
      </aside>
    </div>
  )
}

/** Opportunity workbench with independently settling market data regions. */
export function OpportunityPage({
  requestData, initialQuery, onAnalyze, onView,
}: { requestData: RequestData; initialQuery: string; onAnalyze: (intent: AssistantIntent) => void; onView: (code: string) => void }) {
  const [kind, setKind] = useState('gainers')
  const [nonce, setNonce] = useState(0)
  const [selected, setSelected] = useState(initialQuery)
  const scan = useRequestResource(requestData)
  const news = useRequestResource(requestData)
  const signal = useRequestResource(requestData)

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
    // A stock deliberately carried back from the detail page may not appear in
    // the current scan bucket. Keep that research subject instead of silently
    // replacing it with the first ranked row.
    if (selected.trim() !== '') return
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
  const busy = resources.some(resource => resource.phase === 'loading' || resource.phase === 'refreshing')

  return (
    <div className={css.pageScroll}>
      <PageHeader title="实时盯盘" description="基于实时扫描、技术信号和基础实时资讯发现研究线索">
        <button
          type="button"
          className={css.secondaryButton}
          aria-busy={busy}
          disabled={busy}
          onClick={() => { setNonce(value => value + 1) }}
        >{busy ? '加载中…' : '刷新数据'}</button>
      </PageHeader>
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
                    onAnalyze({ kind: 'stock', code: selected, name: text(signalRecord.name, '') })
                  }}
                >带入智能分析</button>
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

function AddHoldingDialog({
  code, name, suggestedCost, saving, error, onClose, onConfirm,
}: {
  code: string
  name: string
  suggestedCost: number | undefined
  saving: boolean
  error: string
  onClose: () => void
  onConfirm: (quantity: number, costPrice: number) => void
}) {
  const [quantity, setQuantity] = useState('100')
  const [costPrice, setCostPrice] = useState(suggestedCost?.toFixed(2) ?? '')
  const resolvedQuantity = Number(quantity)
  const resolvedCost = Number(costPrice)
  const valid = Number.isFinite(resolvedQuantity) && resolvedQuantity > 0
    && Number.isFinite(resolvedCost) && resolvedCost > 0

  return (
    <DetailDialog
      title={`加入持仓 · ${name}`}
      description={`${code}｜录入数量和成本后，会与当前持仓一起保存并重新计算组合风险。`}
      eyebrow="持仓录入"
      onClose={onClose}
      actions={<>
        <button type="button" className={css.secondaryButton} disabled={saving} onClick={onClose}>取消</button>
        <button
          type="button"
          className={css.primaryButton}
          disabled={!valid || saving}
          onClick={() => { onConfirm(resolvedQuantity, resolvedCost) }}
        >{saving ? '正在保存…' : '确认加入持仓'}</button>
      </>}
    >
      <div className={css.detailFormGrid}>
        <label>
          <span>持仓数量</span>
          <input className={css.fieldInput} inputMode="decimal" value={quantity} onChange={(event) => { setQuantity(event.target.value) }} />
        </label>
        <label>
          <span>持仓成本</span>
          <input className={css.fieldInput} inputMode="decimal" value={costPrice} onChange={(event) => { setCostPrice(event.target.value) }} />
        </label>
      </div>
      {error !== '' && <div className={css.inlineError} role="alert">{error}</div>}
    </DetailDialog>
  )
}

function StockDetailLoading({ code }: { code: string }) {
  return (
    <div className={css.stockLoading} role="status" aria-live="polite">
      <div className={css.stockLoadingLead}>
        <span className={css.stockLoadingMark} aria-hidden="true"><i /></span>
        <div>
          <strong>正在准备 {code} 的个股研究视图</strong>
          <p>同步实时行情、技术位置与个股资讯，完成后会自动展示。</p>
        </div>
      </div>
      <div className={css.stockLoadingGrid} aria-hidden="true">
        <section className={css.stockLoadingHero}>
          <div className={css.stockLoadingIdentity}><i /><i /></div>
          <div className={css.stockLoadingMetrics}>
            {Array.from({ length: 8 }, (_, index) => <span key={index}><i /><b /></span>)}
          </div>
        </section>
        <div className={css.stockLoadingSide}>
          <section className={css.stockLoadingPanel}><i /><b /><b /></section>
          <section className={css.stockLoadingPanel}><i /><b /><b /><b /></section>
        </div>
      </div>
    </div>
  )
}

function StockDetailPage({
  requestData, code, onBack, onAnalyze,
}: { requestData: RequestData; code: string; onBack: () => void; onAnalyze: (intent: AssistantIntent) => void }) {
  const [nonce, setNonce] = useState(0)
  const [ownershipNonce, setOwnershipNonce] = useState(0)
  const [detail, setDetail] = useState<unknown>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [holdings, setHoldings] = useState<readonly Record<string, unknown>[]>([])
  const [watchlist, setWatchlist] = useState<readonly Record<string, unknown>[]>([])
  const [coreWatchlist, setCoreWatchlist] = useState<readonly string[]>()
  const [ownershipReady, setOwnershipReady] = useState(false)
  const [actionBusy, setActionBusy] = useState('')
  const [actionNotice, setActionNotice] = useState('')
  const [holdingOpen, setHoldingOpen] = useState(false)
  const [holdingError, setHoldingError] = useState('')

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
        setError(productErrorText(reason)); setLoading(false)
      })
    return () => { alive = false }
  }, [code, nonce, requestData])

  useEffect(() => {
    let alive = true
    setOwnershipReady(false)
    void Promise.allSettled([
      requestData({ operation: 'trading-core.holdings' }),
      requestData({ operation: 'market-watch.watchlist' }),
      requestData({ operation: 'trading-core.watchlist' }),
    ]).then(([holdingsResult, marketResult, coreResult]) => {
      if (!alive) return
      if (holdingsResult.status === 'fulfilled') setHoldings(records(asRecord(holdingsResult.value).items))
      if (marketResult.status === 'fulfilled') setWatchlist(records(asRecord(marketResult.value).items))
      if (coreResult.status === 'fulfilled') {
        const tickers = asRecord(coreResult.value).tickers
        setCoreWatchlist(Array.isArray(tickers) ? tickers.filter((item): item is string => typeof item === 'string') : [])
      }
      setOwnershipReady(true)
    })
    return () => { alive = false }
  }, [code, ownershipNonce, requestData])

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
  const inHoldings = holdings.some(item => text(item.ticker, '') === resolvedCode)
  const inWatchlist = watchlist.some(item => text(item.code, '') === resolvedCode)

  const addWatchlist = async (): Promise<void> => {
    if (actionBusy !== '' || inWatchlist) return
    setActionBusy('watchlist'); setActionNotice('')
    const tasks = [requestData({ operation: 'market-watch.watch-add', input: { code: resolvedCode, name } })]
    if (coreWatchlist !== undefined) {
      tasks.push(requestData({
        operation: 'trading-core.watchlist-save', input: { tickers: [...new Set([...coreWatchlist, resolvedCode])] },
      }))
    }
    const results = await Promise.allSettled(tasks)
    const succeeded = results.filter(result => result.status === 'fulfilled').length
    setActionNotice(tasks.length === 2 && succeeded === 2
      ? `已将 ${name} 加入自选，实时盯盘与个性化研究已同步。`
      : succeeded > 0
        ? `${name} 已在一个模块加入自选，另一模块同步失败；可点击刷新后重试。`
        : `加入自选失败：${productErrorText((results[0] as PromiseRejectedResult).reason)}`)
    setActionBusy(''); setOwnershipNonce(value => value + 1)
  }

  const addHolding = async (quantity: number, costPrice: number): Promise<void> => {
    if (actionBusy !== '' || inHoldings) return
    setActionBusy('holding'); setHoldingError('')
    const normalized = holdings.flatMap((item) => {
      const ticker = text(item.ticker, '')
      const itemQuantity = number(item.quantity)
      const itemCost = number(item.cost_price)
      return ticker === '' || itemQuantity === undefined || itemCost === undefined
        ? []
        : [{ ticker, quantity: itemQuantity, cost_price: itemCost }]
    })
    try {
      await requestData({
        operation: 'trading-core.holdings-save',
        input: { holdings: [...normalized, { ticker: resolvedCode, quantity, cost_price: costPrice }] },
      })
      setHoldingOpen(false)
      setActionNotice(`已将 ${name} 加入持仓，组合风险会按最新持仓重新计算。`)
      setOwnershipNonce(value => value + 1)
    } catch (reason) {
      setHoldingError(productErrorText(reason))
    } finally {
      setActionBusy('')
    }
  }

  return (
    <div className={css.pageScroll}>
      <PageHeader title={loading ? `${code} · 个股详情` : `${name} · ${resolvedCode}`} description="实时行情、技术位置、资金与个股资讯的统一研究视图">
        <button type="button" className={css.secondaryButton} onClick={onBack}>返回实时盯盘</button>
        <button type="button" className={css.secondaryButton} onClick={() => { setNonce(value => value + 1) }}>刷新详情</button>
        {!loading && error === '' && (
          <button
            type="button"
            className={css.secondaryButton}
            disabled={!ownershipReady || actionBusy !== '' || inWatchlist}
            onClick={() => { void addWatchlist() }}
          >{actionBusy === 'watchlist' ? '正在加入…' : inWatchlist ? '已在自选' : '加入自选'}</button>
        )}
        {!loading && error === '' && (
          <button
            type="button"
            className={css.secondaryButton}
            disabled={!ownershipReady || actionBusy !== '' || inHoldings}
            onClick={() => { setHoldingError(''); setHoldingOpen(true) }}
          >{inHoldings ? '已在持仓' : '加入持仓'}</button>
        )}
        {!loading && error === '' && (
          <button
            type="button"
            className={css.primaryButton}
            onClick={() => {
              onAnalyze({ kind: 'stock', code: resolvedCode, name })
            }}
          >带入智能分析</button>
        )}
      </PageHeader>
      {actionNotice !== '' && <div className={css.importNotice} role="status">{actionNotice}</div>}
      {error !== '' && <ErrorCard title="个股详情暂不可用" message={error} retry={() => { setNonce(value => value + 1) }} />}
      {loading && <StockDetailLoading code={code} />}
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
      {holdingOpen && (
        <AddHoldingDialog
          code={resolvedCode}
          name={name}
          suggestedCost={number(quote.price)}
          saving={actionBusy === 'holding'}
          error={holdingError}
          onClose={() => { if (actionBusy !== 'holding') setHoldingOpen(false) }}
          onConfirm={(quantity, costPrice) => { void addHolding(quantity, costPrice) }}
        />
      )}
    </div>
  )
}

function HoldingsImportDialog({
  requestData, onClose, onImported,
}: { requestData: RequestData; onClose: () => void; onImported: (count: number) => void }) {
  const dialogRef = useRef<HTMLElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const savingRef = useRef(false)
  const [source, setSource] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const result = useMemo(() => parseHoldingsImport(source), [source])
  const canSubmit = result.items.length > 0 && result.errors.length === 0 && !saving

  useEffect(() => { savingRef.current = saving }, [saving])
  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    closeButtonRef.current?.focus()
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !savingRef.current) { onClose(); return }
      if (event.key !== 'Tab') return
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), textarea:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )
      if (focusable === undefined || focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      window.requestAnimationFrame(() => { previousFocus?.focus() })
    }
  }, [onClose])

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
      setError(productErrorText(reason))
      setSaving(false)
    }
  }

  const dialog = (
    <div
      className={`${css.drawerBackdrop} ${css.importBackdrop}`}
      role="presentation"
      onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) onClose() }}
    >
      <section ref={dialogRef} className={css.importDialog} role="dialog" aria-modal="true" aria-labelledby="holdings-import-title">
        <div className={css.importHead}>
          <div>
            <strong id="holdings-import-title">导入持仓</strong>
            <span>支持 CSV、TSV 和从表格复制的文本</span>
          </div>
          <button ref={closeButtonRef} type="button" aria-label="关闭导入持仓" disabled={saving} onClick={onClose}>×</button>
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
export function PortfolioPage({ requestData, onAnalyze, onViewStock = () => {} }: {
  requestData: RequestData
  onAnalyze: (intent: AssistantIntent) => void
  onViewStock?: (code: string) => void
}) {
  const [nonce, setNonce] = useState(0)
  const [importOpen, setImportOpen] = useState(false)
  const [notice, setNotice] = useState('')
  const [selectedEvent, setSelectedEvent] = useState<Record<string, unknown>>()
  const [selectedRisk, setSelectedRisk] = useState<Record<string, unknown>>()
  const holdings = useRequestResource(requestData)
  const risk = useRequestResource(requestData)
  const alerts = useRequestResource(requestData)
  const events = useRequestResource(requestData)
  const watchlist = useRequestResource(requestData)
  const coreWatchlist = useRequestResource(requestData)
  const [removingWatch, setRemovingWatch] = useState('')

  useEffect(() => {
    holdings.run({ operation: 'trading-core.holdings' })
    risk.run({ operation: 'trading-core.risk-portfolio' })
    alerts.run({ operation: 'trading-core.risk-alerts' })
    events.run({
      operation: 'trading-core.personalized-cards',
      input: { limit: 20, bucket: 'all', match: true, comment: false },
    })
    watchlist.run({ operation: 'market-watch.watchlist' })
    coreWatchlist.run({ operation: 'trading-core.watchlist' })
  }, [alerts.run, coreWatchlist.run, events.run, holdings.run, nonce, risk.run, watchlist.run])

  const positions = records(asRecord(holdings.state.value).items)
  const riskRecord = asRecord(risk.state.value)
  const summary = asRecord(riskRecord.summary)
  const breaches = records(riskRecord.breaches)
  const alertRecord = asRecord(alerts.state.value)
  const alertItems = records(alertRecord.items)
  const eventItems = records(asRecord(events.state.value).cards)
  const watchItems = records(asRecord(watchlist.state.value).items)
  const rawCoreTickers = asRecord(coreWatchlist.state.value).tickers
  const coreTickers = Array.isArray(rawCoreTickers)
    ? rawCoreTickers.filter((item): item is string => typeof item === 'string')
    : []
  const equalWeight = number(summary.equal_weight)
  const resources = [holdings.state, risk.state, alerts.state, events.state, watchlist.state, coreWatchlist.state]
  const busy = resources.some(resource => resource.phase === 'loading' || resource.phase === 'refreshing')

  const removeWatch = async (code: string): Promise<void> => {
    if (removingWatch !== '') return
    setRemovingWatch(code); setNotice('')
    const tasks = [requestData({ operation: 'market-watch.watch-remove', input: { code } })]
    if (coreWatchlist.state.loaded) {
      tasks.push(requestData({
        operation: 'trading-core.watchlist-save', input: { tickers: coreTickers.filter(ticker => ticker !== code) },
      }))
    }
    const results = await Promise.allSettled(tasks)
    const succeeded = results.filter(result => result.status === 'fulfilled').length
    setNotice(tasks.length === 2 && succeeded === 2
      ? `已将 ${code} 移出自选，两个研究模块已同步。`
      : succeeded > 0
        ? `${code} 已从一个模块移出，另一模块同步失败；请刷新后重试。`
        : `移出自选失败：${productErrorText((results[0] as PromiseRejectedResult).reason)}`)
    setRemovingWatch(''); setNonce(value => value + 1)
  }

  return (
    <div className={css.pageScroll}>
      <PageHeader title="我的投研" description="汇总后端已保存的持仓、风险预算与真实预警结果，承接研究到组合决策">
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
            onAnalyze({ kind: 'portfolio' })
          }}
        >带入智能分析持仓</button>
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
      <section className={`${css.panelCard} ${css.watchlistPanel}`} aria-busy={watchlist.busy} aria-labelledby="watchlist-title">
        <div className={css.sectionHeading}>
          <div><strong id="watchlist-title">自选股</strong><small>实时盯盘与个性化研究共用的关注列表</small></div>
          <ResourceLabel state={watchlist.state} settled={`${watchItems.length} 项`} />
        </div>
        {watchlist.state.error !== '' && (
          <ErrorCard
            title={watchlist.state.loaded ? '自选股更新失败' : '自选股暂不可用'}
            message={watchlist.state.error}
            retry={() => { watchlist.run({ operation: 'market-watch.watchlist' }) }}
            retained={watchlist.state.loaded}
          />
        )}
        {!watchlist.state.loaded && watchlist.state.error === '' && <LoadingSkeleton rows={2} />}
        {watchlist.state.loaded && (
          <div className={css.watchlistGrid}>
            {watchItems.map((item, index) => {
              const code = text(item.code, '')
              return (
                <article key={`${code}-${index}`}>
                  <button type="button" className={css.watchlistStock} onClick={() => { onViewStock(code) }}>
                    <strong>{text(item.name, code)}</strong>
                    <span>{code}</span>
                  </button>
                  <div>
                    <button type="button" className={css.secondaryButton} onClick={() => { onViewStock(code) }}>查看详情</button>
                    <button
                      type="button"
                      className={css.secondaryButton}
                      disabled={removingWatch !== ''}
                      onClick={() => { void removeWatch(code) }}
                    >{removingWatch === code ? '移出中…' : '移出'}</button>
                  </div>
                </article>
              )
            })}
            {watchItems.length === 0 && <div className={css.emptyState}>还没有自选股，可从个股详情点击“加入自选”。</div>}
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
                              onAnalyze({ kind: 'stock', code: text(row.ticker, ''), name: text(row.name, '') })
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
                {breaches.map((item, index) => (
                  <RiskRow
                    key={text(item.indicator, String(index))}
                    item={item}
                    onOpen={() => { setSelectedRisk({ ...item, source: text(item.source, 'portfolio') }) }}
                  />
                ))}
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
                {alertItems.slice(0, 12).map((item, index) => (
                  <AlertRow
                    key={text(item.id, String(index))}
                    item={item}
                    onOpen={() => {
                      setSelectedRisk({
                        ...item,
                        degraded: alertRecord.degraded === true,
                        degraded_reason: text(alertRecord.degraded_reason, '关联事件暂未更新，组合与画像预警仍可用。'),
                      })
                    }}
                  />
                ))}
                {alertItems.length === 0 && <div className={css.emptyState}>当前没有预警记录</div>}
              </>
            )}
          </div>
        </section>
      </div>
      <section data-testid="portfolio-events" className={`${css.panelCard} ${css.portfolioEvents}`} aria-busy={events.busy} aria-labelledby="portfolio-events-title">
        <div className={css.sectionHeading}>
          <div><strong id="portfolio-events-title">研究事件</strong><small>点击事件，以 Markdown 文档查看来源、关联原因与风险说明；持久报告仍以报告标识为准</small></div>
          <ResourceLabel state={events.state} settled={`${eventItems.length} 条`} />
        </div>
        {events.state.error !== '' && (
          <ErrorCard
            title={events.state.loaded ? '研究事件更新失败' : '研究事件暂不可用'}
            message={events.state.error}
            retry={() => { events.run({ operation: 'trading-core.personalized-cards', input: { limit: 20, bucket: 'all', match: true, comment: false } }) }}
            retained={events.state.loaded}
          />
        )}
        {!events.state.loaded && events.state.error === '' && <LoadingSkeleton rows={3} />}
        {events.state.loaded && (
          <div className={css.portfolioEventList}>
            {eventItems.map((item, index) => {
              const itemRisk = asRecord(item.risk)
              const eventId = text(item.event_id, text(item.source_event_id, ''))
              const persistent = text(item.report_id, '') !== ''
              return (
                <button
                  key={text(item.card_id, String(index))}
                  type="button"
                  data-event-id={eventId === '' ? undefined : eventId}
                  data-action="event-report-open"
                  aria-haspopup="dialog"
                  onClick={() => { setSelectedEvent(item) }}
                >
                  <span>
                    <strong>{text(item.title, '市场事件')}</strong>
                    <small>{text(item.source, '来源未知')} · {text(item.time, '时间未知')}</small>
                  </span>
                  <span>
                    {text(item.direction, '') !== '' && <b>{text(item.direction)}</b>}
                    {text(itemRisk.level, '') !== '' && <b data-severity={text(itemRisk.level)}>{text(itemRisk.level)}风险</b>}
                    <i>{persistent ? '查看投研报告' : '查看事件详情'} →</i>
                  </span>
                </button>
              )
            })}
            {eventItems.length === 0 && <div className={css.emptyState}>当前没有与持仓、自选或策略关联的研究事件。</div>}
          </div>
        )}
      </section>
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
      {selectedRisk !== undefined && (
        <RiskDetailDialog
          item={selectedRisk}
          onClose={() => { setSelectedRisk(undefined) }}
          onAnalyze={() => {
            const target = riskIntentTarget(selectedRisk)
            setSelectedRisk(undefined)
            if (target.strategyId !== undefined) onAnalyze({ kind: 'strategy', strategyId: target.strategyId })
            else if (target.code !== undefined) onAnalyze({ kind: 'stock', code: target.code })
            else onAnalyze({ kind: 'portfolio' })
          }}
        />
      )}
      {selectedEvent !== undefined && (
        <EventReportDialog
          item={selectedEvent}
          requestData={requestData}
          onClose={() => { setSelectedEvent(undefined) }}
          onAnalyze={() => {
            const ticker = eventPrimaryTicker(selectedEvent)
            const reference = text(selectedEvent.title, '')
            setSelectedEvent(undefined)
            if (ticker !== undefined) onAnalyze({ kind: 'stock', code: ticker.code, name: ticker.name })
            else onAnalyze({ kind: 'industry', reference })
          }}
        />
      )}
    </div>
  )
}

function RiskRow({ item, onOpen }: { item: Record<string, unknown>; onOpen: () => void }) {
  const riskId = text(item.id, text(item.indicator, text(item.label, 'risk')))
  return <div className={css.riskRow}><span data-severity={text(item.severity, '低')}>{text(item.severity, '低')}</span><div><strong>{text(item.label)}</strong><p>当前 {scalar(item.value)} · 上限 {scalar(item.limit)}</p></div><button type="button" data-action="risk-detail" data-risk-id={riskId} aria-haspopup="dialog" onClick={onOpen}>详情</button></div>
}

function AlertRow({ item, onOpen }: { item: Record<string, unknown>; onOpen: () => void }) {
  const riskId = text(item.id, text(item.indicator, text(item.title, 'risk')))
  return <article className={css.alertRow}><div><span data-severity={text(item.severity, '低')}>{text(item.severity, '低')}</span><strong>{text(item.title)}</strong><button type="button" data-action="risk-detail" data-risk-id={riskId} aria-haspopup="dialog" onClick={onOpen}>详情</button></div><p>{text(item.detail)}</p><small>{text(item.ts, '')}</small></article>
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
