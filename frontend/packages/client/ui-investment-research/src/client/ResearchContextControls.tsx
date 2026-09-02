import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { InvestmentDataRequest } from '@deepseek-ai/dsh-client-investment-research-runtime/client'
import {
  InvestmentAssistantModuleSelect,
  type InvestmentAssistantModuleInjected,
} from './InvestmentShell.tsx'
import { asRecord, records, text } from './data.ts'
import {
  type ResearchChatContextController,
  type ResearchChatContextTarget,
  type ResearchChatInstrument,
} from './research-chat-context.ts'
import css from './InvestmentShell.module.css'

type RequestData = (request: InvestmentDataRequest) => Promise<unknown>

interface StrategyOption {
  readonly id: string
  readonly name: string
  readonly status: string
  readonly verificationStatus: string
  readonly recommended: boolean
  readonly kind: string
  readonly hypothesis: string
  readonly parameters: readonly string[]
  readonly symbols: readonly string[]
  readonly updatedAt: string
}

export interface InvestmentComposerContextInjected extends InvestmentAssistantModuleInjected {
  researchChatContext: ResearchChatContextController
  requestData: RequestData
}

export type InvestmentComposerContextProps = PropsRuntime<'conversation.input.left'>
  & InjectFace<InvestmentComposerContextInjected>

type ResearchContextPanel = 'strategy' | 'instrument'

interface RetrySelection {
  readonly target: ResearchChatContextTarget
  readonly source: ResearchContextPanel
}

interface SelectionFocusRestore {
  readonly token: number
  readonly source: ResearchContextPanel
  eligible: boolean
}

const POPOVER_MARGIN = 12
const POPOVER_GAP = 8
const POPOVER_MAX_HEIGHT = 560
const POPOVER_MAX_WIDTH = 420
const POPOVER_MEASURE_STYLE: CSSProperties = {
  position: 'fixed', left: 0, top: 0, maxHeight: POPOVER_MAX_HEIGHT, visibility: 'hidden',
}

const STATUS_LABELS: Readonly<Record<string, string>> = {
  active: '已启用', candidate: '候选', rejected: '已拒绝', retired: '已退役',
}

const VERIFICATION_LABELS: Readonly<Record<string, string>> = {
  passed: '已验证', pending: '待验证', failed: '验证未通过', archived: '已归档',
}

const STRATEGY_RISK_ORDER: Readonly<Record<string, number>> = {
  active: 0, candidate: 1, rejected: 2, retired: 3,
}

function lifecycleLabel(status: string): string {
  return STATUS_LABELS[status] ?? '状态未知'
}

function verificationLabel(status: string): string {
  return VERIFICATION_LABELS[status] ?? '验证状态未知'
}

function verificationTone(status: string): string {
  if (status === 'passed') return 'verification'
  if (status === 'pending') return 'pending'
  if (status === 'archived') return 'muted'
  return 'danger'
}

function strategyLabel(strategy: StrategyOption): string {
  return `${strategy.name}，类型 ${strategy.kind}，${lifecycleLabel(strategy.status)}，${verificationLabel(strategy.verificationStatus)}，${strategy.recommended ? '推荐' : '非推荐'}`
}

function strategyBadge(strategy: StrategyOption): { readonly label: string; readonly tone: string } {
  if (strategy.recommended) return { label: '推荐', tone: 'recommended' }
  if (strategy.verificationStatus === 'failed') return { label: '未通过', tone: 'danger' }
  if (strategy.verificationStatus === 'archived') return { label: '已归档', tone: 'muted' }
  if (!(strategy.verificationStatus in VERIFICATION_LABELS)) {
    return { label: '验证状态未知', tone: 'danger' }
  }
  if (strategy.status === 'rejected' || strategy.status === 'retired') {
    return { label: lifecycleLabel(strategy.status), tone: 'muted' }
  }
  if (strategy.verificationStatus === 'pending') return { label: '待验证', tone: 'pending' }
  return { label: lifecycleLabel(strategy.status), tone: 'pending' }
}

function strategyElementId(controlId: string, strategyId: string): string {
  return `${controlId}-strategy-${encodeURIComponent(strategyId)}`
}

function compactValue(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return value.map(compactValue).filter(Boolean).join('、')
  return ''
}

function strategyOption(item: Record<string, unknown>): StrategyOption | undefined {
  const id = text(item.id, '').trim()
  if (id === '') return undefined
  const status = text(item.status, 'unknown')
  const verificationStatus = text(item.verification_status, 'pending')
  const rawParameters = asRecord(item.params ?? item.parameters)
  return {
    id,
    name: text(item.name, id),
    status,
    verificationStatus,
    recommended: status === 'active' && verificationStatus === 'passed',
    kind: text(item.kind, '类型未返回'),
    hypothesis: text(item.hypothesis, text(item.thesis, '策略库暂未返回核心假设。')),
    parameters: Object.entries(rawParameters).flatMap(([key, value]) => {
      const rendered = compactValue(value)
      return rendered === '' ? [] : [`${key}：${rendered}`]
    }),
    symbols: Array.isArray(item.symbols)
      ? item.symbols.filter((value): value is string => typeof value === 'string' && value.trim() !== '')
      : [],
    updatedAt: text(item.updated_at, text(item.created_at, '未返回')),
  }
}

function strategyOptions(value: unknown): StrategyOption[] {
  return records(asRecord(value).items).flatMap((item) => {
    const option = strategyOption(item)
    return option === undefined ? [] : [option]
  })
}

function securityOptions(value: unknown): ResearchChatInstrument[] {
  return records(asRecord(value).items).flatMap((item) => {
    const code = text(item.code, '').trim()
    if (!/^\d{6}$/u.test(code)) return []
    const name = text(item.name, code)
    const market = text(item.market, '')
    const explicitType = item.type
    const type = explicitType === 'etf' || /ETF/iu.test(`${name} ${market}`) ? 'etf' : 'stock'
    return [{ code, name, market, type }]
  })
}

function instrumentLabel(instrument: ResearchChatInstrument): string {
  return `${instrument.name}，${instrument.code}，${instrument.type === 'etf' ? 'ETF' : 'A股'}`
}

function selectorContains(
  element: Node,
  controls: HTMLDivElement | null,
  popover: HTMLDivElement | null,
): boolean {
  return controls?.contains(element) === true || popover?.contains(element) === true
}

function isDocumentFocusFallback(element: Element | null): boolean {
  return element === document.body || element === document.documentElement
}

function prefersReducedMotion(): boolean {
  const matchMedia = (window as unknown as { matchMedia?: (query: string) => MediaQueryList }).matchMedia
  return matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
}

function scrollNearestIntoView(element: Element | null | undefined): void {
  if (element === null || element === undefined || typeof element.scrollIntoView !== 'function') return
  element.scrollIntoView({ block: 'nearest', behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
}

/** Composer toolbar controls for the current session's confirmed strategy and target. */
export function InvestmentComposerContextControls(props: InvestmentComposerContextProps) {
  const { useInvestmentUi, researchChatContext, requestData, session, input } = props
  const route = useInvestmentUi(snapshot => snapshot.route)
  const sessionId = String(session.sessionId)
  const controlId = useId().replace(/:/gu, '')
  const strategyDialogId = `${controlId}-strategy-dialog`
  const strategyListId = `${controlId}-strategy-list`
  const instrumentDialogId = `${controlId}-instrument-dialog`
  const instrumentListId = `${controlId}-instrument-list`
  const subscribe = useCallback(
    (listener: () => void) => researchChatContext.subscribe(sessionId, listener),
    [researchChatContext, sessionId],
  )
  const getSnapshot = useCallback(
    () => researchChatContext.snapshot(sessionId),
    [researchChatContext, sessionId],
  )
  const entry = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const [panel, setPanel] = useState<ResearchContextPanel | null>(null)
  const [strategies, setStrategies] = useState<StrategyOption[]>([])
  const [confirmedStrategy, setConfirmedStrategy] = useState<StrategyOption>()
  const [confirmedStrategyIssue, setConfirmedStrategyIssue] = useState<'missing' | 'unavailable' | ''>('')
  const [strategiesBusy, setStrategiesBusy] = useState(false)
  const [strategyError, setStrategyError] = useState('')
  const [strategyQuery, setStrategyQuery] = useState('')
  const [strategyLoadNonce, setStrategyLoadNonce] = useState(0)
  const [previewStrategyId, setPreviewStrategyId] = useState<string>()
  const [query, setQuery] = useState('')
  const [instruments, setInstruments] = useState<ResearchChatInstrument[]>([])
  const [searchBusy, setSearchBusy] = useState(false)
  const [searchError, setSearchError] = useState('')
  const [searchNonce, setSearchNonce] = useState(0)
  const [activeIndex, setActiveIndex] = useState(0)
  const [strategyActiveIndex, setStrategyActiveIndex] = useState(-1)
  const searchGeneration = useRef(0)
  const strategyDetailGeneration = useRef(0)
  const focusRestoreSequence = useRef(0)
  const focusRestoreRequest = useRef<SelectionFocusRestore>()
  const strategyItemRefs = useRef(new Map<string, HTMLDivElement>())
  const controlsRef = useRef<HTMLDivElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const strategyTriggerRef = useRef<HTMLButtonElement>(null)
  const instrumentTriggerRef = useRef<HTMLButtonElement>(null)
  const strategySearchRef = useRef<HTMLInputElement>(null)
  const instrumentSearchRef = useRef<HTMLInputElement>(null)
  const retrySelectionRef = useRef<HTMLButtonElement>(null)
  const [retrySelection, setRetrySelection] = useState<RetrySelection>()
  const [popoverStyle, setPopoverStyle] = useState<CSSProperties>(POPOVER_MEASURE_STYLE)
  const scrollStrategyIntoView = useCallback((strategyId: string) => {
    scrollNearestIntoView(strategyItemRefs.current.get(strategyId))
  }, [])
  const scrollStrategyConfirmIntoView = useCallback((strategyId: string) => {
    scrollNearestIntoView(document.getElementById(`${strategyElementId(controlId, strategyId)}-confirm`))
  }, [controlId])

  useEffect(() => {
    if (route !== 'portfolio') return
    void researchChatContext.load(sessionId, { refresh: true }).catch(() => {})
  }, [researchChatContext, route, sessionId])

  useEffect(() => {
    const strategyId = entry.confirmed?.strategy_id
    const generation = ++strategyDetailGeneration.current
    if (route !== 'portfolio' || strategyId === null || strategyId === undefined) {
      setConfirmedStrategy(undefined)
      setConfirmedStrategyIssue('')
      return
    }
    setConfirmedStrategyIssue('')
    requestData({ operation: 'trading-core.strategy-detail', input: { strategy_id: strategyId } })
      .then((value) => {
        if (generation !== strategyDetailGeneration.current) return
        setConfirmedStrategy(strategyOption(asRecord(value)))
        setConfirmedStrategyIssue('')
      })
      .catch((reason: unknown) => {
        if (generation !== strategyDetailGeneration.current) return
        setConfirmedStrategy(undefined)
        const message = reason instanceof Error ? reason.message : String(reason)
        setConfirmedStrategyIssue(/HTTP 404|策略不存在/u.test(message) ? 'missing' : 'unavailable')
      })
  }, [entry.confirmed?.strategy_id, requestData, route])

  useEffect(() => {
    if (panel !== 'strategy') return
    let alive = true
    setStrategiesBusy(true)
    setStrategyError('')
    requestData({ operation: 'trading-core.strategies', input: { limit: 200 } })
      .then((value) => {
        if (!alive) return
        setStrategies(strategyOptions(value))
        setStrategiesBusy(false)
      })
      .catch(() => {
        if (!alive) return
        setStrategyError('策略列表暂不可用，请稍后重试。')
        setStrategiesBusy(false)
      })
    return () => { alive = false }
  }, [panel, requestData, strategyLoadNonce])

  useEffect(() => {
    if (panel !== 'instrument') return
    const keyword = query.trim()
    const generation = ++searchGeneration.current
    if (keyword === '') {
      setInstruments([])
      setSearchBusy(false)
      setSearchError('')
      return
    }
    setSearchBusy(true)
    setSearchError('')
    const timer = window.setTimeout(() => {
      requestData({ operation: 'market-watch.security-search', input: { query: keyword, limit: 8 } })
        .then((value) => {
          if (generation !== searchGeneration.current) return
          setInstruments(securityOptions(value))
          setActiveIndex(0)
          setSearchBusy(false)
        })
        .catch(() => {
          if (generation !== searchGeneration.current) return
          setInstruments([])
          setSearchError('证券搜索暂不可用，请稍后重试。')
          setSearchBusy(false)
        })
    }, 180)
    return () => { window.clearTimeout(timer) }
  }, [panel, query, requestData, searchNonce])

  useEffect(() => {
    if (panel === null) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        const trigger = panel === 'strategy' ? strategyTriggerRef.current : instrumentTriggerRef.current
        setPanel(null)
        if (panel === 'strategy') {
          setStrategyQuery('')
          setPreviewStrategyId(undefined)
          setStrategyActiveIndex(-1)
        } else {
          setQuery('')
        }
        trigger?.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => { window.removeEventListener('keydown', onKeyDown) }
  }, [panel])

  useEffect(() => {
    const cancelRestoreForExternalTarget = (
      target: EventTarget | null,
      allowDocumentFallback: boolean,
    ): void => {
      const request = focusRestoreRequest.current
      if (request === undefined || !request.eligible) return
      if (!(target instanceof Node)) {
        request.eligible = false
        return
      }
      if (selectorContains(target, controlsRef.current, popoverRef.current)) return
      if (allowDocumentFallback && target instanceof Element && isDocumentFocusFallback(target)) return
      request.eligible = false
    }
    const onFocusIn = (event: FocusEvent): void => {
      cancelRestoreForExternalTarget(event.target, true)
    }
    const onPointerDown = (event: PointerEvent): void => {
      cancelRestoreForExternalTarget(event.target, false)
    }
    document.addEventListener('focusin', onFocusIn, true)
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => {
      document.removeEventListener('focusin', onFocusIn, true)
      document.removeEventListener('pointerdown', onPointerDown, true)
    }
  }, [])

  useLayoutEffect(() => {
    const request = focusRestoreRequest.current
    if (entry.phase !== 'error' || entry.errorAction !== 'save' || retrySelection === undefined) return
    if (request === undefined || !request.eligible || request.source !== retrySelection.source) return
    if (!isDocumentFocusFallback(document.activeElement)) return
    retrySelectionRef.current?.focus()
  }, [entry.errorAction, entry.phase, retrySelection])

  useEffect(() => {
    if (panel === null) return
    const onPointerDown = (event: PointerEvent): void => {
      if (!(event.target instanceof Node)) return
      if (controlsRef.current?.contains(event.target) === true) return
      if (popoverRef.current?.contains(event.target) === true) return
      setPanel(null)
      setPreviewStrategyId(undefined)
      if (panel === 'strategy') {
        setStrategyQuery('')
        setStrategyActiveIndex(-1)
      }
      else setQuery('')
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => { document.removeEventListener('pointerdown', onPointerDown, true) }
  }, [panel])

  useEffect(() => {
    if (previewStrategyId === undefined) return
    scrollStrategyIntoView(previewStrategyId)
    if (prefersReducedMotion()) scrollStrategyConfirmIntoView(previewStrategyId)
  }, [previewStrategyId, scrollStrategyConfirmIntoView, scrollStrategyIntoView])

  const selectedStrategy = useMemo(
    () => strategies.find(strategy => strategy.id === entry.confirmed?.strategy_id) ?? confirmedStrategy,
    [confirmedStrategy, entry.confirmed?.strategy_id, strategies],
  )
  const busy = session.running || input.phase !== 'plain'
    || entry.phase === 'saving' || entry.phase === 'loading'
  const filteredStrategies = useMemo(() => {
    const keyword = strategyQuery.trim().toLocaleLowerCase()
    if (keyword === '') return strategies
    return strategies.filter(strategy => `${strategy.name} ${strategy.id}`.toLocaleLowerCase().includes(keyword))
  }, [strategies, strategyQuery])
  const byRecent = (left: StrategyOption, right: StrategyOption): number => (
    right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id)
  )
  const recommended = filteredStrategies.filter(strategy => strategy.recommended).sort(byRecent)
  const other = filteredStrategies.filter(strategy => !strategy.recommended).sort((left, right) => (
    (STRATEGY_RISK_ORDER[left.status] ?? 9) - (STRATEGY_RISK_ORDER[right.status] ?? 9)
    || byRecent(left, right)
  ))
  const visibleStrategies = [...recommended, ...other]
  const placePopover = useCallback((): void => {
    if (panel === null) return
    const anchor = panel === 'strategy' ? strategyTriggerRef.current : instrumentTriggerRef.current
    const popover = popoverRef.current
    if (anchor === null || popover === null) return

    const anchorRect = anchor.getBoundingClientRect()
    const visualViewport = window.visualViewport
    const viewportLeft = visualViewport?.offsetLeft ?? 0
    const viewportTop = visualViewport?.offsetTop ?? 0
    const viewportWidth = visualViewport?.width ?? window.innerWidth
    const viewportHeight = visualViewport?.height ?? window.innerHeight
    const viewportRight = viewportLeft + viewportWidth
    const viewportBottom = viewportTop + viewportHeight
    const minLeft = viewportLeft + POPOVER_MARGIN
    const minTop = viewportTop + POPOVER_MARGIN
    const availableWidth = Math.max(0, viewportWidth - POPOVER_MARGIN * 2)
    const width = Math.min(POPOVER_MAX_WIDTH, availableWidth)
    const availableAbove = Math.max(0, anchorRect.top - POPOVER_GAP - minTop)
    const availableBelow = Math.max(0, viewportBottom - POPOVER_MARGIN - anchorRect.bottom - POPOVER_GAP)
    const opensAbove = availableAbove >= availableBelow
    const maxHeight = Math.min(POPOVER_MAX_HEIGHT, opensAbove ? availableAbove : availableBelow)
    const measuredHeight = popover.scrollHeight || popover.offsetHeight || maxHeight
    const height = Math.min(measuredHeight, maxHeight)
    const maxLeft = Math.max(minLeft, viewportRight - width - POPOVER_MARGIN)
    const maxTop = Math.max(minTop, viewportBottom - height - POPOVER_MARGIN)
    const left = Math.min(Math.max(anchorRect.left, minLeft), maxLeft)
    const preferredTop = opensAbove
      ? anchorRect.top - POPOVER_GAP - height
      : anchorRect.bottom + POPOVER_GAP
    const top = Math.min(Math.max(preferredTop, minTop), maxTop)

    setPopoverStyle({ position: 'fixed', left, top, width, maxWidth: availableWidth, maxHeight, visibility: 'visible' })
  }, [panel])

  useLayoutEffect(() => {
    if (panel === null) {
      setPopoverStyle(POPOVER_MEASURE_STYLE)
      return
    }
    placePopover()
    const visualViewport = window.visualViewport
    let revealFrame: number | undefined
    const onViewportResize = (): void => {
      placePopover()
      if (panel !== 'strategy' || previewStrategyId === undefined) return
      if (revealFrame !== undefined) window.cancelAnimationFrame(revealFrame)
      revealFrame = window.requestAnimationFrame(() => {
        revealFrame = undefined
        scrollStrategyConfirmIntoView(previewStrategyId)
      })
    }
    window.addEventListener('scroll', placePopover, true)
    window.addEventListener('resize', onViewportResize)
    visualViewport?.addEventListener('scroll', placePopover)
    visualViewport?.addEventListener('resize', onViewportResize)
    return () => {
      if (revealFrame !== undefined) window.cancelAnimationFrame(revealFrame)
      window.removeEventListener('scroll', placePopover, true)
      window.removeEventListener('resize', onViewportResize)
      visualViewport?.removeEventListener('scroll', placePopover)
      visualViewport?.removeEventListener('resize', onViewportResize)
    }
  }, [
    panel, placePopover, previewStrategyId, scrollStrategyConfirmIntoView,
    strategiesBusy, strategyError, filteredStrategies.length,
    query, searchBusy, searchError, instruments.length, entry.confirmed?.strategy_id, entry.confirmed?.instrument,
  ])
  const focusStrategyAt = (index: number): void => {
    if (visibleStrategies.length === 0) return
    const normalizedIndex = (index + visibleStrategies.length) % visibleStrategies.length
    const strategy = visibleStrategies[normalizedIndex]
    if (strategy === undefined) return
    setStrategyActiveIndex(normalizedIndex)
    document.getElementById(strategyElementId(controlId, strategy.id))?.focus()
  }
  const moveStrategyFocus = (strategyId: string, offset: -1 | 1): void => {
    const index = visibleStrategies.findIndex(strategy => strategy.id === strategyId)
    if (index >= 0) focusStrategyAt(index + offset)
  }

  const finishSelection = (source: ResearchContextPanel, focusRestoreToken: number): void => {
    const focusRestore = focusRestoreRequest.current
    const matchingRestore = focusRestore?.token === focusRestoreToken && focusRestore.source === source
    const activeElement = document.activeElement
    const shouldRestoreFocus = matchingRestore && focusRestore.eligible && activeElement !== null && (
      selectorContains(activeElement, controlsRef.current, popoverRef.current)
      || isDocumentFocusFallback(activeElement)
    )
    if (matchingRestore) focusRestoreRequest.current = undefined
    setPanel(null)
    if (source === 'strategy') {
      setStrategyQuery('')
      setPreviewStrategyId(undefined)
      setStrategyActiveIndex(-1)
      if (shouldRestoreFocus) strategyTriggerRef.current?.focus()
    } else {
      setQuery('')
      if (shouldRestoreFocus) instrumentTriggerRef.current?.focus()
    }
  }
  const saveTarget = (
    target: ResearchChatContextTarget,
    source: ResearchContextPanel,
    options: { readonly retry?: boolean } = {},
  ): void => {
    const focusRestoreToken = ++focusRestoreSequence.current
    const activeElement = document.activeElement
    focusRestoreRequest.current = {
      token: focusRestoreToken,
      source,
      eligible: options.retry === true || (
        activeElement !== null && selectorContains(activeElement, controlsRef.current, popoverRef.current)
      ),
    }
    setRetrySelection(undefined)
    void researchChatContext.save(sessionId, target)
      .then(() => { finishSelection(source, focusRestoreToken) })
      .catch(() => {
        if (researchChatContext.snapshot(sessionId).errorAction === 'conflict') {
          finishSelection(source, focusRestoreToken)
          return
        }
        setRetrySelection({ target, source })
      })
  }
  const saveStrategy = (strategy: StrategyOption | null): void => {
    saveTarget({
      strategy_id: strategy?.id ?? null,
      instrument: entry.confirmed?.instrument ?? null,
    }, 'strategy')
  }
  const saveInstrument = (instrument: ResearchChatInstrument | null): void => {
    saveTarget({
      strategy_id: entry.confirmed?.strategy_id ?? null,
      instrument,
    }, 'instrument')
  }

  if (route !== 'portfolio') return <InvestmentAssistantModuleSelect {...props} />

  const strategyAria = selectedStrategy === undefined
    ? `策略，当前：${entry.confirmed?.strategy_id ?? '未选择'}${confirmedStrategyIssue === 'missing' ? '，已失效，非推荐' : confirmedStrategyIssue === 'unavailable' ? '，状态暂不可用' : ''}`
    : `策略，当前：${strategyLabel(selectedStrategy)}`
  const selectedStrategyBadge = selectedStrategy === undefined ? undefined : strategyBadge(selectedStrategy)
  const instrument = entry.confirmed?.instrument ?? null
  return (
    <div ref={controlsRef} className={css.researchContextControls} data-saving={entry.phase === 'saving' || undefined}>
      <div className={css.researchContextControl}>
        <button
          ref={strategyTriggerRef}
          type="button"
          className={css.researchContextTrigger}
          aria-label={strategyAria}
          aria-haspopup="dialog"
          aria-controls={strategyDialogId}
          aria-expanded={panel === 'strategy'}
          disabled={busy}
          onClick={() => {
            setStrategyQuery('')
            setPreviewStrategyId(undefined)
            setStrategyActiveIndex(-1)
            if (panel === 'instrument') setQuery('')
            setPanel(panel === 'strategy' ? null : 'strategy')
          }}
        >
          <span aria-hidden="true">◇</span>
          <strong>{selectedStrategy?.name ?? (entry.confirmed?.strategy_id || '选策略')}</strong>
          {selectedStrategyBadge !== undefined && !selectedStrategy?.recommended && (
            <em data-tone={selectedStrategyBadge.tone}>{selectedStrategyBadge.label}</em>
          )}
          {selectedStrategy === undefined && confirmedStrategyIssue === 'missing' && <em>已失效</em>}
          {selectedStrategy === undefined && confirmedStrategyIssue === 'unavailable' && <em>状态未知</em>}
        </button>
        {panel === 'strategy' && typeof document !== 'undefined' && createPortal((
          <div
            id={strategyDialogId}
            ref={popoverRef}
            className={css.researchContextPopover}
            style={popoverStyle}
            role="dialog"
            aria-label="选择投研策略"
            onClick={(event) => { event.stopPropagation() }}
          >
            <div className={css.researchContextPopoverHead}><strong>选择策略</strong><small>全部可讨论，仅“已启用 + 已验证”推荐</small></div>
            <input
              ref={strategySearchRef}
              autoFocus
              type="search"
              role="searchbox"
              aria-label="搜索策略名称或标识"
              aria-controls={strategyListId}
              value={strategyQuery}
              disabled={busy}
              onChange={(event) => {
                setStrategyQuery(event.target.value)
                setStrategyActiveIndex(-1)
                setPreviewStrategyId(undefined)
              }}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown' && visibleStrategies.length > 0) {
                  event.preventDefault()
                  focusStrategyAt(strategyActiveIndex < 0 ? 0 : strategyActiveIndex + 1)
                } else if (event.key === 'ArrowUp' && visibleStrategies.length > 0) {
                  event.preventDefault()
                  focusStrategyAt(strategyActiveIndex < 0 ? visibleStrategies.length - 1 : strategyActiveIndex - 1)
                } else if (event.key === 'Enter' && visibleStrategies.length > 0) {
                  event.preventDefault()
                  focusStrategyAt(strategyActiveIndex < 0 ? 0 : strategyActiveIndex)
                }
              }}
              placeholder="搜索策略名称或标识"
            />
            {strategiesBusy && <div role="status" className={css.searchStatus}>正在加载策略…</div>}
            {strategyError !== '' && (
              <div role="alert" className={css.searchError}>
                {strategyError}
                <button
                  type="button"
                  onClick={() => {
                    setStrategyLoadNonce(value => value + 1)
                    strategySearchRef.current?.focus()
                  }}
                >重试加载策略</button>
              </div>
            )}
            {!strategiesBusy && strategyError === '' && (
              <>
                <div id={strategyListId} className={css.researchStrategyList} role="list">
                  <StrategyGroup
                    controlId={controlId}
                    label="推荐策略"
                    options={recommended}
                    selectedId={entry.confirmed?.strategy_id}
                    expandedId={previewStrategyId}
                    busy={busy}
                    registerItem={(strategyId, element) => {
                      if (element === null) strategyItemRefs.current.delete(strategyId)
                      else strategyItemRefs.current.set(strategyId, element)
                    }}
                    onToggle={(strategyId) => {
                      setPreviewStrategyId(current => current === strategyId ? undefined : strategyId)
                      setStrategyActiveIndex(visibleStrategies.findIndex(strategy => strategy.id === strategyId))
                    }}
                    onMoveFocus={moveStrategyFocus}
                    onExpansionComplete={(strategyId) => {
                      scrollStrategyConfirmIntoView(strategyId)
                      placePopover()
                    }}
                    onConfirm={saveStrategy}
                  />
                  <StrategyGroup
                    controlId={controlId}
                    label="其他策略"
                    options={other}
                    selectedId={entry.confirmed?.strategy_id}
                    expandedId={previewStrategyId}
                    busy={busy}
                    registerItem={(strategyId, element) => {
                      if (element === null) strategyItemRefs.current.delete(strategyId)
                      else strategyItemRefs.current.set(strategyId, element)
                    }}
                    onToggle={(strategyId) => {
                      setPreviewStrategyId(current => current === strategyId ? undefined : strategyId)
                      setStrategyActiveIndex(visibleStrategies.findIndex(strategy => strategy.id === strategyId))
                    }}
                    onMoveFocus={moveStrategyFocus}
                    onExpansionComplete={(strategyId) => {
                      scrollStrategyConfirmIntoView(strategyId)
                      placePopover()
                    }}
                    onConfirm={saveStrategy}
                  />
                </div>
                {filteredStrategies.length === 0 && (
                  <div className={css.researchContextEmpty} role="status">
                    <strong>{strategyQuery.trim() === '' ? '暂时没有可用策略' : '没有匹配的策略'}</strong>
                    <span>{strategyQuery.trim() === '' ? '策略上线后会显示在这里。' : '换个名称或策略标识试试。'}</span>
                  </div>
                )}
                {entry.confirmed?.strategy_id != null && (
                  <div className={css.researchContextPopoverFooter}>
                    <button type="button" className={css.researchContextClear} disabled={busy} onClick={() => { saveStrategy(null) }}>清除当前策略</button>
                  </div>
                )}
              </>
            )}
          </div>
        ), document.body)}
      </div>

      <div className={css.researchContextControl}>
        <button
          ref={instrumentTriggerRef}
          type="button"
          className={css.researchContextTrigger}
          aria-label={`标的，当前：${instrument === null ? '未选择' : instrumentLabel(instrument)}`}
          aria-haspopup="dialog"
          aria-controls={instrumentDialogId}
          aria-expanded={panel === 'instrument'}
          disabled={busy}
          onClick={() => {
            setQuery('')
            setActiveIndex(0)
            if (panel === 'strategy') {
              setStrategyQuery('')
              setPreviewStrategyId(undefined)
              setStrategyActiveIndex(-1)
            }
            setPanel(panel === 'instrument' ? null : 'instrument')
          }}
        >
          <span aria-hidden="true">⌖</span>
          <strong>{instrument?.name ?? '选标的'}</strong>
        </button>
        {panel === 'instrument' && typeof document !== 'undefined' && createPortal((
          <div
            id={instrumentDialogId}
            ref={popoverRef}
            className={css.researchContextPopover}
            style={popoverStyle}
            role="dialog"
            aria-label="选择投资标的"
            onClick={(event) => { event.stopPropagation() }}
          >
            <div className={css.researchContextPopoverHead}><strong>选择标的</strong><small>首期支持 A 股与场内 ETF</small></div>
            <p className={css.researchContextCapability}>ETF 首期提供行情、技术信号和相关新闻研究，不等同于成分股基本面分析。</p>
            <input
              ref={instrumentSearchRef}
              autoFocus
              value={query}
              role="combobox"
              aria-label="搜索 A 股或场内 ETF"
              aria-autocomplete="list"
              aria-expanded="true"
              aria-controls={instrumentListId}
              aria-activedescendant={searchBusy || instruments[activeIndex] === undefined ? undefined : `${controlId}-instrument-${activeIndex}`}
              disabled={busy}
              onChange={(event) => { setQuery(event.target.value) }}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown' && instruments.length > 0) {
                  event.preventDefault(); setActiveIndex(index => (index + 1) % instruments.length)
                } else if (event.key === 'ArrowUp' && instruments.length > 0) {
                  event.preventDefault(); setActiveIndex(index => (index - 1 + instruments.length) % instruments.length)
                } else if (event.key === 'Enter' && instruments[activeIndex] !== undefined) {
                  event.preventDefault(); saveInstrument(instruments[activeIndex] ?? null)
                }
              }}
              placeholder="输入代码或名称"
            />
            {searchBusy && <div role="status" className={css.searchStatus}>正在搜索证券…</div>}
            {searchError !== '' && (
              <div role="alert" className={css.searchError}>
                {searchError}
                <button
                  type="button"
                  onClick={() => {
                    setSearchNonce(value => value + 1)
                    instrumentSearchRef.current?.focus()
                  }}
                >重试搜索</button>
              </div>
            )}
            {!searchBusy && query.trim() === '' && (
              <div className={css.researchContextEmpty} role="status">
                <strong>搜索要研究的标的</strong>
                <span>输入证券代码或名称，点击结果即可选中。</span>
              </div>
            )}
            {!searchBusy && query.trim() !== '' && searchError === '' && instruments.length === 0 && (
              <div className={css.researchContextEmpty} role="status">
                <strong>没有找到匹配标的</strong>
                <span>检查代码或换个简称试试。</span>
              </div>
            )}
            <div id={instrumentListId} className={css.researchInstrumentList} role="listbox" aria-label="证券搜索结果">
              {!searchBusy && instruments.map((item, index) => (
                <button
                  id={`${controlId}-instrument-${index}`}
                  key={item.code}
                  type="button"
                  role="option"
                  tabIndex={-1}
                  aria-selected={instrument?.code === item.code}
                  aria-label={instrumentLabel(item)}
                  data-active={index === activeIndex || undefined}
                  disabled={busy}
                  onMouseEnter={() => { setActiveIndex(index) }}
                  onMouseDown={(event) => { event.preventDefault() }}
                  onClick={() => { saveInstrument(item) }}
                >
                  <span><strong>{item.name}</strong><small>{item.code} · {item.market}</small></span>
                  <em>{item.type === 'etf' ? 'ETF' : 'A股'}</em>
                </button>
              ))}
            </div>
            {instrument !== null && (
              <div className={css.researchContextPopoverFooter}>
                <button type="button" className={css.researchContextClear} disabled={busy} onClick={() => { saveInstrument(null) }}>清除当前标的</button>
              </div>
            )}
          </div>
        ), document.body)}
      </div>
      {entry.phase === 'loading' && <span className={css.researchContextStatus} role="status">正在恢复投研上下文…</span>}
      {entry.phase === 'error' && entry.errorAction === 'load' && (
        <span
          className={css.researchContextError}
          data-compact="true"
          role="alert"
          aria-label="投研上下文暂不可用"
          title="投研上下文暂不可用"
        >
          <button
            type="button"
            aria-label="重试读取投研上下文"
            title="投研上下文暂不可用，点击重试"
            onClick={() => { void researchChatContext.load(sessionId, { refresh: true }).catch(() => {}) }}
          ><span aria-hidden="true">!</span></button>
        </span>
      )}
      {entry.phase === 'error' && entry.errorAction !== 'load' && (
        <span className={css.researchContextError} role="alert">
          {entry.errorAction === 'conflict'
            ? entry.error
            : `保存失败，已保留上次选择：${entry.error}`}
          {entry.errorAction !== 'conflict' && (
            <button
              ref={retrySelectionRef}
              type="button"
              aria-label="重试保存投研上下文"
              onClick={() => {
                if (retrySelection !== undefined) {
                  saveTarget(retrySelection.target, retrySelection.source, { retry: true })
                }
              }}
            >重试</button>
          )}
        </span>
      )}
    </div>
  )
}

function StrategyGroup({
  controlId, label, options, selectedId, expandedId, busy, registerItem,
  onToggle, onMoveFocus, onExpansionComplete, onConfirm,
}: {
  controlId: string
  label: string
  options: readonly StrategyOption[]
  selectedId: string | null | undefined
  expandedId: string | undefined
  busy: boolean
  registerItem: (strategyId: string, element: HTMLDivElement | null) => void
  onToggle: (strategyId: string) => void
  onMoveFocus: (strategyId: string, offset: -1 | 1) => void
  onExpansionComplete: (strategyId: string) => void
  onConfirm: (strategy: StrategyOption) => void
}) {
  if (options.length === 0) return null
  return (
    <section className={css.researchStrategyGroup} aria-label={label} role="group">
      <h3>{label}</h3>
      {options.map((strategy) => {
        const expanded = expandedId === strategy.id
        const selected = selectedId === strategy.id
        const itemId = strategyElementId(controlId, strategy.id)
        const detailId = `${itemId}-detail`
        const badge = strategyBadge(strategy)
        return (
          <div
            key={strategy.id}
            ref={(element) => { registerItem(strategy.id, element) }}
            className={css.researchStrategyItem}
            data-expanded={expanded || undefined}
            data-selected={selected || undefined}
            role="listitem"
          >
            <button
              id={itemId}
              type="button"
              className={css.researchStrategyRow}
              aria-current={selected ? 'true' : undefined}
              aria-expanded={expanded}
              aria-controls={detailId}
              aria-label={strategyLabel(strategy)}
              disabled={busy}
              onClick={() => { onToggle(strategy.id) }}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown') {
                  event.preventDefault()
                  onMoveFocus(strategy.id, 1)
                } else if (event.key === 'ArrowUp') {
                  event.preventDefault()
                  onMoveFocus(strategy.id, -1)
                }
              }}
            >
              <span className={css.researchStrategyRowText}>
                <strong>{strategy.name}</strong>
                <small>
                  {strategy.kind}
                  {' · '}
                  {lifecycleLabel(strategy.status)}
                  {' · '}
                  {verificationLabel(strategy.verificationStatus)}
                </small>
              </span>
              <span className={css.researchStrategyRowMeta} aria-hidden="true">
                <em data-tone={badge.tone}>{badge.label}</em>
                <span className={css.researchStrategyChevron}>⌄</span>
              </span>
            </button>
            <section
              id={detailId}
              className={css.researchStrategyDisclosure}
              role="region"
              aria-label={`${strategy.name}策略详情`}
              aria-hidden={!expanded}
              data-expanded={expanded || undefined}
              onTransitionEnd={(event) => {
                if (expanded && event.target === event.currentTarget && event.propertyName === 'grid-template-rows') {
                  onExpansionComplete(strategy.id)
                }
              }}
            >
              <div className={css.researchStrategyDisclosureInner}>
                <div className={css.researchStrategyPreview}>
                  <div className={css.researchStrategyPreviewHead}>
                    <div>
                      <span>策略详情</span>
                      <h4>{strategy.name}</h4>
                    </div>
                    <div className={css.researchStrategyPreviewBadges}>
                      <em data-tone="lifecycle">{lifecycleLabel(strategy.status)}</em>
                      <em data-tone={verificationTone(strategy.verificationStatus)}>
                        {verificationLabel(strategy.verificationStatus)}
                      </em>
                      {selected && <em data-tone="current">当前使用</em>}
                    </div>
                  </div>
                  <p>{strategy.hypothesis}</p>
                  <dl>
                    <div><dt>类型</dt><dd>{strategy.kind}</dd></div>
                    <div><dt>适用证券</dt><dd>{strategy.symbols.length === 0 ? '未限定' : strategy.symbols.join('、')}</dd></div>
                    <div><dt>更新时间</dt><dd>{strategy.updatedAt}</dd></div>
                  </dl>
                  <div className={css.researchStrategyParams} aria-label="策略参数">
                    {strategy.parameters.length === 0
                      ? <span>关键参数未返回</span>
                      : strategy.parameters.map(parameter => <span key={parameter}>{parameter}</span>)}
                  </div>
                  <button
                    id={`${itemId}-confirm`}
                    type="button"
                    className={css.researchStrategyConfirm}
                    disabled={!expanded || busy || selected}
                    tabIndex={expanded ? 0 : -1}
                    aria-label={`确认使用${strategy.name}`}
                    onClick={() => { onConfirm(strategy) }}
                  >
                    {busy ? '保存中…' : selected ? '当前已使用' : '确认使用此策略'}
                    {!busy && !selected && <span aria-hidden="true">→</span>}
                  </button>
                </div>
              </div>
            </section>
          </div>
        )
      })}
    </section>
  )
}
