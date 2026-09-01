import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useSyncExternalStore,
} from 'react'
import css from './InvestmentShell.module.css'
import type { AssistantIntent } from './assistant-intent.ts'
import { asRecord, number, productErrorText, records, text } from './data.ts'
import type { ResearchResourceSnapshot, ResearchResourceStore } from './research-resource.ts'
import type { RequestData, ResearchSubject } from './research-types.ts'
import { useSecurityNames } from './security-names.ts'

const TECHNICAL_LOOKBACK = 120
const SECURITY_NEWS_LIMIT = 8
const DEFAULT_RETRY_DELAY_MS = 1500
const MIN_RETRY_DELAY_MS = 1000
const MAX_RETRY_DELAY_MS = 5000

export interface SecurityResearchContentProps {
  readonly subject: ResearchSubject
  readonly requestData: RequestData
  readonly resources: ResearchResourceStore
  readonly active: boolean
  readonly onAnalyze: (intent: AssistantIntent) => void
  readonly onOpenFullDetail: (code: string) => void
}

function technicalKey(code: string): string {
  return JSON.stringify({
    operation: 'market-watch.tech-signal', code, lookback: TECHNICAL_LOOKBACK,
  })
}

function securityNewsKey(code: string): string {
  return JSON.stringify({
    operation: 'market-watch.security-news', code, limit: SECURITY_NEWS_LIMIT,
  })
}

function useResourceSnapshot<T>(
  resources: ResearchResourceStore,
  key: string,
): ResearchResourceSnapshot<T> {
  const subscribe = useCallback(
    (listener: () => void) => resources.subscribe(key, listener),
    [key, resources],
  )
  const getSnapshot = useCallback(
    () => resources.getSnapshot<T>(key),
    [key, resources],
  )
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

function safeExternalUrl(value: unknown): string | undefined {
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

function statusOf(value: unknown): string {
  const record = asRecord(value)
  return typeof record.status === 'string'
    ? record.status
    : Object.keys(record).length === 0 ? '' : 'ready'
}

function factTime(value: unknown, fallback?: string): string {
  const candidate = asRecord(value).as_of
  return typeof candidate === 'string' && candidate.trim() !== ''
    ? candidate.trim()
    : fallback?.trim() ?? ''
}

function retryDelay(value: unknown): number {
  const suggested = number(asRecord(value).retry_after_ms) ?? DEFAULT_RETRY_DELAY_MS
  return Math.min(MAX_RETRY_DELAY_MS, Math.max(MIN_RETRY_DELAY_MS, suggested))
}

function ResourceAlert({
  title,
  message,
  retryLabel,
  onRetry,
  disabled = false,
  busy = false,
}: {
  readonly title: string
  readonly message: string
  readonly retryLabel: string
  readonly onRetry: () => void
  readonly disabled?: boolean
  readonly busy?: boolean
}) {
  return (
    <div className={css.researchContentAlert} role="alert">
      <div><strong>{title}</strong><p>{productErrorText(message)}</p></div>
      <button
        type="button"
        aria-busy={busy || undefined}
        disabled={disabled || busy}
        onClick={onRetry}
      >{retryLabel}</button>
    </div>
  )
}

function resourceIsBusy(resources: ResearchResourceStore, key: string): boolean {
  const phase = resources.getSnapshot(key).phase
  return phase === 'preparing' || phase === 'refreshing'
}

function NewsItems({ items }: { readonly items: readonly Record<string, unknown>[] }) {
  return (
    <div className={css.researchNewsList}>
      {items.map((item, index) => {
        const title = text(item.title, text(item.summary, '资讯'))
        const source = text(item.source, text(item.tag, '资讯源'))
        const timestamp = text(item.time, text(item.ts, ''))
        const url = safeExternalUrl(item.url)
        return (
          <article className={css.researchNewsItem} key={text(item.id, `${title}-${index}`)}>
            <div>
              {url === undefined
                ? <strong>{title}</strong>
                : (
                  <a href={url} target="_blank" rel="noopener noreferrer" aria-label={`${title}（打开原文）`}>
                    <strong>{title}</strong><span aria-hidden="true">↗</span>
                  </a>
                )}
              <small>{source}{url === undefined ? ' · 暂无原文链接' : ' · 原文'}</small>
            </div>
            {timestamp !== '' && <time>{timestamp}</time>}
          </article>
        )
      })}
    </div>
  )
}

function newsItems(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? records(value) : records(asRecord(value).items)
}

function signalText(value: unknown): string {
  if (typeof value === 'string') return value
  const record = asRecord(value)
  return text(record.message, text(record.label, text(record.signal, '技术信号')))
}

export function SecurityResearchContent({
  subject,
  requestData,
  resources,
  active,
  onAnalyze,
  onOpenFullDetail,
}: SecurityResearchContentProps) {
  const componentId = useId()
  const timerOwner = `security-research:${componentId}`
  const retainedTechnical = useRef(new Map<string, Record<string, unknown>>())
  const activeRef = useRef(active)
  const technicalKeyRef = useRef('')
  const lifecycleGenerationRef = useRef(0)
  const code = subject.code.trim()
  const currentTechnicalKey = technicalKey(code)
  const currentSecurityNewsKey = securityNewsKey(code)
  activeRef.current = active
  technicalKeyRef.current = currentTechnicalKey

  const names = useSecurityNames(
    requestData,
    active && (subject.name?.trim() ?? '') === '' ? [code] : [],
  )
  const displayName = subject.name?.trim() || names[code]?.trim() || code
  const technical = useResourceSnapshot<unknown>(resources, currentTechnicalKey)
  const securityNews = useResourceSnapshot<unknown>(resources, currentSecurityNewsKey)

  const loadTechnical = useCallback(
    () => requestData({
      operation: 'market-watch.tech-signal',
      input: { code, lookback: TECHNICAL_LOOKBACK },
    }),
    [code, requestData],
  )
  const loadSecurityNews = useCallback(
    () => requestData({
      operation: 'market-watch.security-news',
      input: { code, limit: SECURITY_NEWS_LIMIT },
    }),
    [code, requestData],
  )
  const readTechnical = useCallback((): void => {
    void resources.read(currentTechnicalKey, loadTechnical).catch(() => {})
  }, [currentTechnicalKey, loadTechnical, resources])
  const readSecurityNews = useCallback((): void => {
    void resources.read(currentSecurityNewsKey, loadSecurityNews).catch(() => {})
  }, [currentSecurityNewsKey, loadSecurityNews, resources])
  const activateTechnical = useCallback((): void => {
    const snapshot = resources.getSnapshot<unknown>(currentTechnicalKey)
    if (statusOf(snapshot.value) === 'ready') {
      void resources.revalidate(currentTechnicalKey, loadTechnical).catch(() => {})
      return
    }
    readTechnical()
  }, [currentTechnicalKey, loadTechnical, readTechnical, resources])
  const activateSecurityNews = useCallback((): void => {
    const snapshot = resources.getSnapshot<unknown>(currentSecurityNewsKey)
    const status = statusOf(snapshot.value)
    if (status === 'ready' || status === 'stale') {
      void resources.revalidate(currentSecurityNewsKey, loadSecurityNews).catch(() => {})
      return
    }
    readSecurityNews()
  }, [currentSecurityNewsKey, loadSecurityNews, readSecurityNews, resources])

  useEffect(() => {
    const generation = lifecycleGenerationRef.current + 1
    lifecycleGenerationRef.current = generation
    resources.clearTimers(timerOwner)
    if (active) {
      activateTechnical()
      activateSecurityNews()
    }
    return () => {
      if (lifecycleGenerationRef.current === generation) {
        lifecycleGenerationRef.current += 1
      }
      resources.clearTimers(timerOwner)
    }
  }, [active, activateSecurityNews, activateTechnical, resources, timerOwner])

  const technicalStatus = statusOf(technical.value)
  const preparingTransportFailed = technicalStatus === 'preparing'
    && technical.phase === 'stale'
    && technical.error !== ''
  useEffect(() => {
    resources.clearTimers(timerOwner)
    if (!active || technicalStatus !== 'preparing' || preparingTransportFailed) return
    const scheduledKey = currentTechnicalKey
    const scheduledGeneration = lifecycleGenerationRef.current
    resources.schedule(timerOwner, scheduledKey, retryDelay(technical.value), () => {
      if (!activeRef.current
        || technicalKeyRef.current !== scheduledKey
        || lifecycleGenerationRef.current !== scheduledGeneration) return
      resources.invalidate(scheduledKey)
      void resources.read(scheduledKey, loadTechnical).catch(() => {})
    })
    return () => { resources.clearTimers(timerOwner) }
  }, [
    active,
    currentTechnicalKey,
    loadTechnical,
    preparingTransportFailed,
    resources,
    technical.value,
    technicalStatus,
    timerOwner,
  ])

  const currentTechnical = asRecord(technical.value)
  if (technicalStatus === 'ready' || technicalStatus === 'stale') {
    retainedTechnical.current.set(currentTechnicalKey, currentTechnical)
  }
  const retained = retainedTechnical.current.get(currentTechnicalKey)
  const technicalUnavailable = technicalStatus === 'unavailable'
    || (technical.phase === 'unavailable' && technical.value === undefined)
    || preparingTransportFailed
  const technicalPreparing = !preparingTransportFailed && (technicalStatus === 'preparing'
    || ((technical.phase === 'idle' || technical.phase === 'preparing') && technical.value === undefined)
  )
  const technicalContent = (technicalUnavailable || technicalStatus === 'preparing') && retained !== undefined
    ? retained
    : technicalStatus === 'preparing' ? undefined : technical.value === undefined ? retained : currentTechnical
  const technicalIsStale = technicalContent !== undefined && (technical.phase === 'stale'
    || technicalStatus === 'stale'
    || currentTechnical.stale === true
    || technicalStatus === 'preparing'
    || (technicalUnavailable && retained !== undefined))
  const technicalAsOf = factTime(technicalContent, technical.asOf)
  const technicalError = technicalStatus === 'unavailable'
    ? text(currentTechnical.message, '当前数据源未能提供技术信号。')
    : technical.error

  const retryTechnical = (): void => {
    if (!activeRef.current || resourceIsBusy(resources, currentTechnicalKey)) return
    resources.clearTimers(timerOwner)
    resources.invalidate(currentTechnicalKey)
    readTechnical()
  }
  const retrySecurityNews = (): void => {
    if (!activeRef.current || resourceIsBusy(resources, currentSecurityNewsKey)) return
    resources.invalidate(currentSecurityNewsKey)
    readSecurityNews()
  }
  const quote = subject.quote
  const pctChange = number(quote?.pctChange)
  const securityNewsStatus = statusOf(securityNews.value)
  const securityItems = newsItems(securityNews.value)
  const securityIsStale = securityNews.phase === 'stale'
    || securityNewsStatus === 'stale'
    || asRecord(securityNews.value).stale === true
  const securityUnavailable = securityNewsStatus === 'unavailable'
    || (securityNews.phase === 'unavailable' && securityNews.value === undefined)
  const securityNewsError = securityNewsStatus === 'unavailable'
    ? text(asRecord(securityNews.value).message, '个股资讯源暂不可用。')
    : securityNews.error
  const securityNewsBusy = securityNews.phase === 'preparing' || securityNews.phase === 'refreshing'
  const technicalBusy = technical.phase === 'preparing' || technical.phase === 'refreshing'

  return (
    <div className={css.researchContent} data-active={active}>
      <header className={css.researchContentIdentity}>
        <div><h2>{displayName}</h2>{displayName !== code && <span>{code}</span>}</div>
        <div className={css.researchContentActions}>
          <button type="button" className={css.secondaryButton} disabled={!active} onClick={() => { onOpenFullDetail(code) }}>查看证券详情</button>
          <button
            type="button"
            className={css.primaryButton}
            disabled={!active}
            onClick={() => {
              onAnalyze(displayName === code
                ? { kind: 'stock', code }
                : { kind: 'stock', code, name: displayName })
            }}
          >带入智能分析</button>
        </div>
      </header>

      <section className={css.researchQuoteGrid} aria-label="行情摘要">
        <div><span>现价</span><strong>{number(quote?.price)?.toFixed(2) ?? '—'}</strong></div>
        <div><span>涨跌幅</span><strong>{pctChange === undefined ? '—' : `${pctChange >= 0 ? '+' : ''}${pctChange.toFixed(2)}%`}</strong></div>
        <div><span>量比</span><strong>{number(quote?.volumeRatio)?.toFixed(2) ?? '—'}</strong></div>
        <div><span>成交额</span><strong>{number(quote?.amountYi) === undefined ? '—' : `${number(quote?.amountYi)?.toFixed(2)} 亿`}</strong></div>
      </section>

      <section className={css.researchContentRegion} aria-label="技术信号" aria-busy={technicalPreparing || technical.phase === 'refreshing'}>
        <div className={css.researchContentHeading}>
          <h3>技术信号</h3>
          {technicalIsStale && <span>缓存 · {technicalAsOf || '原时间未知'}</span>}
          {!technicalIsStale && technical.phase === 'refreshing' && <span>更新中</span>}
        </div>
        {!active && technicalContent === undefined && <div className={css.researchContentPreparing}>研究已暂停</div>}
        {active && technicalPreparing && <div className={css.researchContentPreparing} role="status">技术信号准备中</div>}
        {technicalUnavailable && retained === undefined && (
          <ResourceAlert
            title="技术信号暂不可用"
            message={technicalError}
            retryLabel="重试技术信号"
            onRetry={retryTechnical}
            disabled={!active}
            busy={technicalBusy}
          />
        )}
        {technicalContent !== undefined && (
          <>
            <div className={css.researchTechnicalGrid}>
              <div><span>K 线样本</span><strong>{number(technicalContent.bars)?.toFixed(0) ?? '—'}</strong></div>
              <div><span>支撑位</span><strong>{number(asRecord(asRecord(technicalContent.indicators).support_resistance).support)?.toFixed(2) ?? '—'}</strong></div>
              <div><span>压力位</span><strong>{number(asRecord(asRecord(technicalContent.indicators).support_resistance).resistance)?.toFixed(2) ?? '—'}</strong></div>
              <div><span>MA20</span><strong>{number(asRecord(asRecord(technicalContent.indicators).ma).ma20)?.toFixed(2) ?? '—'}</strong></div>
              <div className={css.researchTechnicalTime}><span>数据时间</span><strong>{technicalAsOf || '—'}</strong></div>
            </div>
            <div className={css.researchSignalList}>
              {Array.isArray(technicalContent.signals) && technicalContent.signals.length > 0
                ? technicalContent.signals.map((signal, index) => <p key={`${signalText(signal)}-${index}`}>{signalText(signal)}</p>)
                : <p>当前没有明确的技术信号。</p>}
            </div>
          </>
        )}
      </section>

      <section className={css.researchContentRegion} aria-label="资讯">
        <div className={css.researchContentHeading}>
          <h3>个股相关资讯</h3>
          {securityIsStale && <span>缓存 · {factTime(securityNews.value, securityNews.asOf) || '原时间未知'}</span>}
        </div>
        {securityUnavailable && (
          <ResourceAlert
            title="个股资讯暂不可用"
            message={securityNewsError}
            retryLabel="重试个股资讯"
            onRetry={retrySecurityNews}
            disabled={!active}
            busy={securityNewsBusy}
          />
        )}
        {!securityUnavailable && securityNews.value === undefined && <div className={css.researchContentPreparing} role="status">正在加载个股相关资讯</div>}
        {securityItems.length > 0 && <NewsItems items={securityItems} />}
        {!securityUnavailable && securityNews.value !== undefined && securityItems.length === 0 && (
          <p className={css.researchContentEmpty}>暂无与该证券直接关联的资讯</p>
        )}
      </section>
    </div>
  )
}
