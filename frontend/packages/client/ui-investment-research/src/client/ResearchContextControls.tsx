import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InvestmentDataRequest } from '@deepseek-ai/dsh-client-investment-research-runtime/client'
import {
  InvestmentAssistantModuleSelect,
  type InvestmentAssistantModuleInjected,
  InvestmentPromptTemplateSelect,
  type InvestmentPromptTemplateInjected,
} from './InvestmentShell.tsx'
import { asRecord, records, text } from './data.ts'
import {
  type ResearchChatContextController,
  type ResearchChatInstrument,
} from './research-chat-context.ts'
import css from './InvestmentShell.module.css'

type RequestData = (request: InvestmentDataRequest) => Promise<unknown>

export interface InvestmentComposerContextInjected
  extends InvestmentAssistantModuleInjected, InvestmentPromptTemplateInjected {
  researchChatContext: ResearchChatContextController
  requestData: RequestData
}

export type InvestmentComposerContextProps = PropsRuntime<'conversation.input.left'>
  & InjectFace<InvestmentComposerContextInjected>

const POPOVER_MARGIN = 12
const POPOVER_GAP = 8
const POPOVER_MAX_HEIGHT = 560
const POPOVER_MAX_WIDTH = 420
const POPOVER_MEASURE_STYLE: CSSProperties = {
  position: 'fixed', left: 0, top: 0, maxHeight: POPOVER_MAX_HEIGHT, visibility: 'hidden',
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

function containsSelectionSurface(
  element: Node,
  controls: HTMLDivElement | null,
  popover: HTMLDivElement | null,
): boolean {
  return controls?.contains(element) === true || popover?.contains(element) === true
}

/** Composer controls: Smart Analysis module plus an optional A-share or venue ETF target. */
export function InvestmentComposerContextControls(props: InvestmentComposerContextProps) {
  const route = props.useInvestmentUi(snapshot => snapshot.route)
  if (route === 'analysis' || route === 'assistant') {
    return <InvestmentPromptTemplateSelect {...props} />
  }
  if (route !== 'portfolio') return <InvestmentAssistantModuleSelect {...props} />
  return <MyResearchComposerContextControls {...props} />
}

function MyResearchComposerContextControls(props: InvestmentComposerContextProps) {
  const { researchChatContext, requestData, session, input } = props
  const sessionId = String(session.sessionId)
  const controlId = useId().replace(/:/gu, '')
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
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [instruments, setInstruments] = useState<ResearchChatInstrument[]>([])
  const [searchBusy, setSearchBusy] = useState(false)
  const [searchError, setSearchError] = useState('')
  const [searchNonce, setSearchNonce] = useState(0)
  const [activeIndex, setActiveIndex] = useState(0)
  const [retryInstrument, setRetryInstrument] = useState<ResearchChatInstrument | null>()
  const [popoverStyle, setPopoverStyle] = useState<CSSProperties>(POPOVER_MEASURE_STYLE)
  const searchGeneration = useRef(0)
  const controlsRef = useRef<HTMLDivElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const instrumentTriggerRef = useRef<HTMLButtonElement>(null)
  const instrumentSearchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    void researchChatContext.load(sessionId, { refresh: true }).catch(() => {})
  }, [researchChatContext, sessionId])

  useEffect(() => {
    if (!open) return
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
  }, [open, query, requestData, searchNonce])

  const closeSelector = useCallback((restoreFocus = false): void => {
    setOpen(false)
    setQuery('')
    if (restoreFocus) instrumentTriggerRef.current?.focus()
  }, [])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      closeSelector(true)
    }
    const onPointerDown = (event: PointerEvent): void => {
      if (!(event.target instanceof Node)) return
      if (containsSelectionSurface(event.target, controlsRef.current, popoverRef.current)) return
      closeSelector()
    }
    window.addEventListener('keydown', onKeyDown)
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('pointerdown', onPointerDown, true)
    }
  }, [closeSelector, open])

  const placePopover = useCallback((): void => {
    if (!open) return
    const anchor = instrumentTriggerRef.current
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
  }, [open])

  useLayoutEffect(() => {
    if (!open) {
      setPopoverStyle(POPOVER_MEASURE_STYLE)
      return
    }
    placePopover()
    const visualViewport = window.visualViewport
    window.addEventListener('scroll', placePopover, true)
    window.addEventListener('resize', placePopover)
    visualViewport?.addEventListener('scroll', placePopover)
    visualViewport?.addEventListener('resize', placePopover)
    return () => {
      window.removeEventListener('scroll', placePopover, true)
      window.removeEventListener('resize', placePopover)
      visualViewport?.removeEventListener('scroll', placePopover)
      visualViewport?.removeEventListener('resize', placePopover)
    }
  }, [entry.confirmed?.instrument, instruments.length, open, placePopover, query, searchBusy, searchError])

  const busy = session.running || input.phase !== 'plain'
    || entry.phase === 'saving' || entry.phase === 'loading'
  const instrument = entry.confirmed?.instrument ?? null

  const saveInstrument = (next: ResearchChatInstrument | null): void => {
    const activeElement = document.activeElement
    const restoreRequested = activeElement instanceof Node
      && containsSelectionSurface(activeElement, controlsRef.current, popoverRef.current)
    const shouldRestoreFocus = (): boolean => {
      if (!restoreRequested) return false
      const currentFocus = document.activeElement
      return currentFocus === document.body || currentFocus === document.documentElement
        || (currentFocus instanceof Node
          && containsSelectionSurface(currentFocus, controlsRef.current, popoverRef.current))
    }
    setRetryInstrument(undefined)
    void researchChatContext.save(sessionId, { strategy_id: null, instrument: next })
      .then(() => { closeSelector(shouldRestoreFocus()) })
      .catch(() => {
        if (researchChatContext.snapshot(sessionId).errorAction === 'conflict') {
          closeSelector(shouldRestoreFocus())
          return
        }
        setRetryInstrument(next)
      })
  }

  return (
    <div ref={controlsRef} className={css.researchContextControls} data-saving={entry.phase === 'saving' || undefined}>
      <div className={css.researchContextControl}>
        <InvestmentPromptTemplateSelect
          {...props}
          appearance="context"
          visibleWhenClosed
        />
      </div>
      <div className={css.researchContextControl}>
        <button
          ref={instrumentTriggerRef}
          type="button"
          className={css.researchContextTrigger}
          aria-label={`标的，当前：${instrument === null ? '未选择' : instrumentLabel(instrument)}`}
          aria-haspopup="dialog"
          aria-controls={instrumentDialogId}
          aria-expanded={open}
          disabled={busy}
          onClick={() => {
            setQuery('')
            setActiveIndex(0)
            setOpen(current => !current)
          }}
        >
          <span className={css.researchContextIcon} data-context-control-icon aria-hidden="true">⌖</span>
          <strong>{instrument?.name ?? '选标的'}</strong>
          <i className={open ? css.assistantModuleChevronOpen : undefined} aria-hidden="true">
            <IconChevronDownOutline14 />
          </i>
        </button>
        {open && typeof document !== 'undefined' && createPortal((
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
        <span className={css.researchContextError} data-compact="true" role="alert" aria-label="投研上下文暂不可用">
          <button
            type="button"
            aria-label="上下文不可用，重试读取"
            title="投研上下文暂不可用，点击重试"
            onClick={() => { void researchChatContext.load(sessionId, { refresh: true }).catch(() => {}) }}
          >上下文不可用 · 重试</button>
        </span>
      )}
      {entry.phase === 'error' && entry.errorAction !== 'load' && (
        <span className={css.researchContextError} role="alert">
          {entry.errorAction === 'conflict' ? entry.error : `保存失败，已保留上次选择：${entry.error}`}
          {entry.errorAction === 'save' && retryInstrument !== undefined && (
            <button
              type="button"
              aria-label="重试保存投研上下文"
              onClick={() => { saveInstrument(retryInstrument) }}
            >重试</button>
          )}
        </span>
      )}
    </div>
  )
}
