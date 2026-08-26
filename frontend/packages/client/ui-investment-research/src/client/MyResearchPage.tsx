import { useCallback, useEffect, useMemo, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { InvestmentDataRequest } from '@deepseek-ai/dsh-client-investment-research-runtime/client'
import type { InvestmentAssistantActionInput } from './assistant-context.ts'
import { asRecord, money, number, records, text } from './data.ts'
import css from './MyResearchPage.module.css'

type RequestData = (request: InvestmentDataRequest) => Promise<unknown>

function DialogPortal({ children }: { readonly children: ReactNode }) {
  return typeof document === 'undefined' ? children : createPortal(children, document.body)
}

interface MyResearchPageProps {
  readonly requestData: RequestData
  readonly onAskAssistant: (input: InvestmentAssistantActionInput) => void
}

interface ResourceState {
  readonly value: unknown
  readonly loading: boolean
  readonly loaded: boolean
  readonly error: string
}

interface Resource extends ResourceState {
  readonly refresh: () => void
}

interface HoldingDraft {
  readonly ticker: string
  readonly quantity: string
  readonly costPrice: string
}

interface WatchItem {
  readonly code: string
  readonly name: string
}

interface TaskState {
  readonly running: boolean
  readonly result?: unknown
  readonly error: string
}

type KycDialogMode = 'questionnaire' | 'adjust'

const HOLDINGS = { operation: 'trading-core.holdings' } as const
const WATCHLIST = { operation: 'market-watch.watchlist' } as const
const KYC_PROFILE = { operation: 'trading-core.kyc-profile' } as const
const RISK_PROFILE = { operation: 'trading-core.risk-profile' } as const
const PERSONALIZED_PROFILE = { operation: 'trading-core.personalized-profile' } as const
const PORTFOLIO_RISK = { operation: 'trading-core.risk-portfolio' } as const

function errorText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

function useResource(requestData: RequestData, request: InvestmentDataRequest): Resource {
  const [nonce, setNonce] = useState(0)
  const [state, setState] = useState<ResourceState>({
    value: undefined,
    loading: true,
    loaded: false,
    error: '',
  })

  useEffect(() => {
    let current = true
    setState(previous => ({ ...previous, loading: true, error: '' }))
    void requestData(request).then((value) => {
      if (current) setState({ value, loading: false, loaded: true, error: '' })
    }, (reason: unknown) => {
      if (current) setState(previous => ({ ...previous, loading: false, error: errorText(reason) }))
    })
    return () => { current = false }
  }, [nonce, request, requestData])

  const refresh = useCallback(() => { setNonce(value => value + 1) }, [])
  return { ...state, refresh }
}

function resourceItems(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return records(value)
  return records(asRecord(value).items)
}

function watchItems(value: unknown): WatchItem[] {
  const source = asRecord(value)
  const raw = Array.isArray(source.items)
    ? source.items
    : Array.isArray(source.tickers)
      ? source.tickers
      : Array.isArray(value) ? value : []
  return raw.flatMap((item): WatchItem[] => {
    if (typeof item === 'string') return item === '' ? [] : [{ code: item, name: '' }]
    const record = asRecord(item)
    const code = text(record.code, text(record.ticker, ''))
    return code === '' ? [] : [{ code, name: text(record.name, '') }]
  })
}

function formatRatio(value: unknown): string {
  const resolved = number(value)
  if (resolved === undefined) return '—'
  const ratio = Math.abs(resolved) <= 1 ? resolved * 100 : resolved
  return `${ratio.toFixed(1)}%`
}

function profileLabel(value: unknown): string {
  const resolved = text(value, '')
  if (resolved === 'conservative') return '保守型'
  if (resolved === 'balanced') return '稳健型'
  if (resolved === 'aggressive') return '进取型'
  return resolved === '' ? '待完善' : resolved
}

function kycStatusLabel(value: unknown): string {
  const resolved = text(value, '')
  if (resolved === 'completed') return '已完成'
  if (resolved === 'adjusted') return '已微调'
  if (resolved === 'in_progress') return '填写中'
  if (resolved === 'not_started') return '待开始'
  return resolved === '' ? '待完成' : resolved
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item !== '')
    : []
}

function taskId(value: unknown): string {
  return text(asRecord(value).task_id, '')
}

function isTaskPending(reason: unknown): boolean {
  return errorText(reason).includes('HTTP 409')
}

function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => { globalThis.setTimeout(resolve, milliseconds) })
}

function Panel({ title, subtitle, status, children }: {
  readonly title: string
  readonly subtitle: string
  readonly status?: ReactNode
  readonly children: ReactNode
}) {
  return (
    <section className={css.panel}>
      <header className={css.panelHeader}>
        <div><h2>{title}</h2><p>{subtitle}</p></div>
        {status}
      </header>
      <div className={css.panelBody}>{children}</div>
    </section>
  )
}

function RegionState({ resource, empty, children }: {
  readonly resource: Resource
  readonly empty: boolean
  readonly children: ReactNode
}) {
  if (!resource.loaded && resource.loading) {
    return <div className={css.skeleton} aria-label="正在加载"><i /><i /><i /></div>
  }
  if (!resource.loaded && resource.error !== '') {
    return (
      <div className={css.errorState} role="alert">
        <strong>暂时无法加载</strong>
        <p>{resource.error}</p>
        <button type="button" onClick={resource.refresh}>重试</button>
      </div>
    )
  }
  if (resource.loaded && empty) return <div className={css.emptyState}>{children}</div>
  return <>{children}</>
}

function ResourceStatus({ resource, settled }: { readonly resource: Resource; readonly settled: string }) {
  if (resource.loading && resource.loaded) return <span className={css.status}>更新中</span>
  if (resource.error !== '' && resource.loaded) {
    return <button type="button" className={css.statusError} onClick={resource.refresh}>更新失败，重试</button>
  }
  return <span className={css.status}>{settled}</span>
}

function HoldingEditor({ initialItems, requestData, onCancel, onSaved }: {
  readonly initialItems: readonly Record<string, unknown>[]
  readonly requestData: RequestData
  readonly onCancel: () => void
  readonly onSaved: (count: number) => void
}) {
  const [drafts, setDrafts] = useState<HoldingDraft[]>(() => initialItems.map(item => ({
    ticker: text(item.ticker, text(item.code, '')),
    quantity: String(number(item.quantity) ?? ''),
    costPrice: String(number(item.cost_price) ?? ''),
  })))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const validationError = useMemo(() => {
    const present = drafts.filter(item => item.ticker !== '' || item.quantity !== '' || item.costPrice !== '')
    if (present.some(item => !/^\d{6}$/.test(item.ticker))) return '股票代码需为 6 位数字。'
    if (new Set(present.map(item => item.ticker)).size !== present.length) return '同一股票只能保留一条持仓。'
    if (present.some(item => Number(item.quantity) <= 0 || !Number.isFinite(Number(item.quantity)))) return '持仓数量需大于 0。'
    if (present.some(item => Number(item.costPrice) < 0 || !Number.isFinite(Number(item.costPrice)))) return '持仓成本不能小于 0。'
    return ''
  }, [drafts])

  const update = (index: number, patch: Partial<HoldingDraft>): void => {
    setDrafts(items => items.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item))
  }

  const save = (): void => {
    if (validationError !== '') return
    const holdings = drafts
      .filter(item => item.ticker !== '' || item.quantity !== '' || item.costPrice !== '')
      .map(item => ({
        ticker: item.ticker,
        quantity: Number(item.quantity),
        cost_price: Number(item.costPrice),
      }))
    setSaving(true)
    setError('')
    void requestData({ operation: 'trading-core.holdings-save', input: { holdings } }).then(() => {
      onSaved(holdings.length)
    }, (reason: unknown) => {
      setError(errorText(reason))
      setSaving(false)
    })
  }

  return (
    <DialogPortal>
      <div className={css.dialogBackdrop} role="presentation" onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel()
      }}>
        <section className={css.dialog} role="dialog" aria-modal="true" aria-labelledby="holding-editor-title">
          <header><div><h2 id="holding-editor-title">编辑持仓</h2><p>保存后会同步刷新持仓和组合风险。</p></div><button type="button" aria-label="关闭编辑持仓" onClick={onCancel}>×</button></header>
          <div className={css.dialogTableWrap}>
            <table>
              <thead><tr><th>股票代码</th><th>数量</th><th>持仓成本</th><th><span className={css.visuallyHidden}>操作</span></th></tr></thead>
              <tbody>
                {drafts.map((item, index) => (
                  <tr key={index}>
                    <td><input aria-label={`第 ${index + 1} 行股票代码`} inputMode="numeric" maxLength={6} value={item.ticker} onChange={(event) => { update(index, { ticker: event.target.value.trim() }) }} /></td>
                    <td><input aria-label={`第 ${index + 1} 行持仓数量`} inputMode="decimal" value={item.quantity} onChange={(event) => { update(index, { quantity: event.target.value }) }} /></td>
                    <td><input aria-label={`第 ${index + 1} 行持仓成本`} inputMode="decimal" value={item.costPrice} onChange={(event) => { update(index, { costPrice: event.target.value }) }} /></td>
                    <td><button type="button" className={css.removeRow} aria-label={`删除第 ${index + 1} 行`} onClick={() => { setDrafts(items => items.filter((_, itemIndex) => itemIndex !== index)) }}>删除</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button type="button" className={css.addRow} onClick={() => { setDrafts(items => [...items, { ticker: '', quantity: '', costPrice: '' }]) }}>＋ 添加一行</button>
          {(validationError !== '' || error !== '') && <div className={css.dialogError} role="alert">{error === '' ? validationError : `保存失败：${error}`}</div>}
          <footer>
            <button type="button" className={css.secondaryButton} disabled={saving} onClick={onCancel}>取消</button>
            <button type="button" className={css.primaryButton} disabled={saving || validationError !== ''} onClick={save}>{saving ? '保存中…' : '保存持仓'}</button>
          </footer>
        </section>
      </div>
    </DialogPortal>
  )
}

function KycQuestionnaire({ profile, requestData, onCancel, onSaved }: {
  readonly profile: Record<string, unknown>
  readonly requestData: RequestData
  readonly onCancel: () => void
  readonly onSaved: (message: string) => void
}) {
  const tiers = asRecord(profile.tiers)
  const questionBank = asRecord(profile.question_bank)
  const [tier, setTier] = useState<'quick' | 'full'>('quick')
  const [answers, setAnswers] = useState<Record<string, Record<string, unknown>>>(() => {
    return Object.fromEntries(records(profile.answers).flatMap((answer) => {
      const qid = text(answer.qid, '')
      return qid === '' ? [] : [[qid, answer]]
    }))
  })
  const [naturalText, setNaturalText] = useState('')
  const [busy, setBusy] = useState<'parse' | 'submit' | ''>('')
  const [error, setError] = useState('')
  const qids = strings(tiers[tier])
  const complete = qids.length > 0 && qids.every(qid => answers[qid] !== undefined)

  const parseAnswer = (): void => {
    if (naturalText.trim() === '') return
    setBusy('parse')
    setError('')
    void requestData({ operation: 'trading-core.kyc-parse', input: { text: naturalText.trim() } }).then((value) => {
      const parsed = records(asRecord(value).answers)
      setAnswers(current => ({
        ...current,
        ...Object.fromEntries(parsed.flatMap((answer) => {
          const qid = text(answer.qid, '')
          return qid === '' ? [] : [[qid, answer]]
        })),
      }))
    }, (reason: unknown) => {
      setError(`识别失败：${errorText(reason)}`)
    }).finally(() => { setBusy('') })
  }

  const submit = (): void => {
    if (!complete) return
    setBusy('submit')
    setError('')
    void requestData({
      operation: 'trading-core.kyc-questionnaire',
      input: {
        answers: qids.map(qid => ({
          qid,
          label: text(answers[qid]?.label, ''),
          score: number(answers[qid]?.score) ?? 0,
        })),
        tier,
        method: 'questionnaire',
      },
    }).then((value) => {
      const result = asRecord(value)
      onSaved(`风险测评已完成，当前画像更新为${profileLabel(result.profile ?? result.label)}。`)
    }, (reason: unknown) => {
      setError(`提交失败：${errorText(reason)}`)
      setBusy('')
    })
  }

  return (
    <DialogPortal>
      <div className={css.dialogBackdrop} role="presentation" onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel()
      }}>
        <section className={`${css.dialog} ${css.kycDialog}`} role="dialog" aria-modal="true" aria-labelledby="kyc-questionnaire-title">
          <header><div><h2 id="kyc-questionnaire-title">风险测评</h2><p>答案会通过 KYC 接口推断并直接更新生效画像。</p></div><button type="button" aria-label="关闭风险测评" onClick={onCancel}>×</button></header>
          <div className={css.tierTabs} role="tablist" aria-label="测评题量">
            <button type="button" role="tab" aria-selected={tier === 'quick'} onClick={() => { setTier('quick') }}>快速测评 · {strings(tiers.quick).length} 题</button>
            <button type="button" role="tab" aria-selected={tier === 'full'} onClick={() => { setTier('full') }}>完整测评 · {strings(tiers.full).length} 题</button>
          </div>
          <div className={css.naturalAnswer}>
            <label htmlFor="kyc-natural-answer">也可以先用一段话描述你的投资情况</label>
            <textarea id="kyc-natural-answer" rows={3} value={naturalText} placeholder="例如：计划持有 1—3 年，可以承受约 10% 的回撤，目标是长期稳健增值。" onChange={(event) => { setNaturalText(event.target.value) }} />
            <button type="button" className={css.secondaryButton} disabled={busy !== '' || naturalText.trim() === ''} onClick={parseAnswer}>{busy === 'parse' ? '识别中…' : '识别并填写'}</button>
          </div>
          <div className={css.questionList}>
            {qids.map((qid, index) => {
              const question = asRecord(questionBank[qid])
              const options = records(question.options)
              return (
                <fieldset key={qid}>
                  <legend><span>{index + 1}</span>{text(question.title, qid)}</legend>
                  <div>{options.map((option) => {
                    const label = text(option.label, '')
                    const checked = text(answers[qid]?.label, '') === label
                    return <label key={`${qid}-${label}`}><input type="radio" name={qid} checked={checked} onChange={() => { setAnswers(current => ({ ...current, [qid]: { qid, label, score: number(option.score) ?? 0 } })) }} /><span>{label}</span></label>
                  })}</div>
                </fieldset>
              )
            })}
          </div>
          {error !== '' && <div className={css.dialogError} role="alert">{error}</div>}
          <footer><span>{complete ? '已完成全部题目' : `还需完成 ${qids.filter(qid => answers[qid] === undefined).length} 题`}</span><div><button type="button" className={css.secondaryButton} disabled={busy !== ''} onClick={onCancel}>取消</button><button type="button" className={css.primaryButton} disabled={busy !== '' || !complete} onClick={submit}>{busy === 'submit' ? '提交中…' : '提交并应用画像'}</button></div></footer>
        </section>
      </div>
    </DialogPortal>
  )
}

function KycAdjustment({ profile, requestData, onCancel, onSaved }: {
  readonly profile: Record<string, unknown>
  readonly requestData: RequestData
  readonly onCancel: () => void
  readonly onSaved: (message: string) => void
}) {
  const manual = asRecord(profile.manual_adjust)
  const effective = text(profile.effective_profile, 'balanced')
  const [tolerance, setTolerance] = useState(number(manual.risk_tolerance) ?? (effective === 'conservative' ? 0 : effective === 'aggressive' ? 1 : 0.5))
  const [horizon, setHorizon] = useState(number(manual.horizon_years) ?? 3)
  const [note, setNote] = useState(text(manual.note, ''))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = (): void => {
    setBusy(true)
    setError('')
    void requestData({
      operation: 'trading-core.kyc-adjust',
      input: { risk_tolerance: tolerance, horizon_years: horizon, ...(note.trim() === '' ? {} : { note: note.trim() }) },
    }).then((value) => {
      const result = asRecord(value)
      onSaved(`画像复核已应用，当前画像为${profileLabel(result.profile ?? result.label)}。`)
    }, (reason: unknown) => {
      setError(`应用失败：${errorText(reason)}`)
      setBusy(false)
    })
  }

  return (
    <DialogPortal>
      <div className={css.dialogBackdrop} role="presentation" onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel()
      }}>
        <section className={`${css.dialog} ${css.adjustDialog}`} role="dialog" aria-modal="true" aria-labelledby="kyc-adjust-title">
          <header><div><h2 id="kyc-adjust-title">复核风险画像</h2><p>在问卷推断之上微调，期限约束与风险护栏由后端统一校准。</p></div><button type="button" aria-label="关闭画像复核" onClick={onCancel}>×</button></header>
          <label className={css.rangeField}><span><strong>风险承受度</strong><b>{tolerance < 0.34 ? '偏保守' : tolerance > 0.66 ? '偏进取' : '稳健'}</b></span><input aria-label="风险承受度" type="range" min="0" max="1" step="0.05" value={tolerance} onChange={(event) => { setTolerance(Number(event.target.value)) }} /><small><span>降低波动</span><span>承受更高波动</span></small></label>
          <label className={css.rangeField}><span><strong>计划投资期限</strong><b>{horizon} 年</b></span><input aria-label="计划投资期限" type="range" min="1" max="10" step="1" value={horizon} onChange={(event) => { setHorizon(Number(event.target.value)) }} /><small><span>1 年</span><span>10 年</span></small></label>
          <label className={css.noteField}>调整说明（选填）<textarea rows={3} value={note} placeholder="例如：家庭现金流更稳定，可以承受更多波动。" onChange={(event) => { setNote(event.target.value) }} /></label>
          {error !== '' && <div className={css.dialogError} role="alert">{error}</div>}
          <footer><button type="button" className={css.secondaryButton} disabled={busy} onClick={onCancel}>取消</button><button type="button" className={css.primaryButton} disabled={busy} onClick={submit}>{busy ? '应用中…' : '确认并应用'}</button></footer>
        </section>
      </div>
    </DialogPortal>
  )
}

/** Portfolio, watchlist, and profile workbench with independent live-data regions. */
export function MyResearchPage({ requestData, onAskAssistant }: MyResearchPageProps) {
  const holdings = useResource(requestData, HOLDINGS)
  const watchlist = useResource(requestData, WATCHLIST)
  const kyc = useResource(requestData, KYC_PROFILE)
  const riskProfile = useResource(requestData, RISK_PROFILE)
  const personalized = useResource(requestData, PERSONALIZED_PROFILE)
  const portfolioRisk = useResource(requestData, PORTFOLIO_RISK)
  const [editingHoldings, setEditingHoldings] = useState(false)
  const [addingWatch, setAddingWatch] = useState(false)
  const [watchCode, setWatchCode] = useState('')
  const [watchName, setWatchName] = useState('')
  const [watchBusy, setWatchBusy] = useState('')
  const [watchError, setWatchError] = useState('')
  const [notice, setNotice] = useState('')
  const [kycDialog, setKycDialog] = useState<KycDialogMode | null>(null)
  const [holdingAnalysis, setHoldingAnalysis] = useState<TaskState>({ running: false, error: '' })

  const holdingItems = resourceItems(holdings.value)
  const watchlistItems = watchItems(watchlist.value)
  const risk = asRecord(portfolioRisk.value)
  const riskSummary = asRecord(risk.summary)
  const riskPositions = resourceItems(risk.positions)
  const kycRecord = asRecord(kyc.value)
  const riskProfileRecord = asRecord(riskProfile.value)
  const personalizedRecord = asRecord(personalized.value)
  const behavior = asRecord(personalizedRecord.behavior)
  const breaches = records(risk.breaches)
  const positionByTicker = new Map(riskPositions.map(item => [text(item.ticker, text(item.code, '')), item]))
  const singleWeightBreach = breaches.find(item => text(item.indicator, '') === 'single_stock_weight')
  const effectiveProfile = profileLabel(
    kycRecord.effective_profile ?? riskProfileRecord.risk_profile ?? riskProfileRecord.label,
  )
  const inferredProfile = profileLabel(kycRecord.inferred_profile)
  const concentration = risk.concentration_hhi ?? riskSummary.hhi
  const effectiveProfileDetail = asRecord(
    asRecord(kycRecord.profiles_detail)[text(kycRecord.effective_profile, '')],
  )
  const budget = asRecord(effectiveProfileDetail.risk_budget)
  const behaviorIndustries = records(behavior.interest_industries)
  const behaviorTickers = records(behavior.focus_tickers)
  const behaviorStrategies = records(behavior.strategy_affinity)
  const directionSkew = asRecord(behavior.direction_skew)
  const directionPreference = (number(directionSkew['利好']) ?? 0) === (number(directionSkew['利空']) ?? 0)
    ? ''
    : (number(directionSkew['利好']) ?? 0) > (number(directionSkew['利空']) ?? 0) ? '利好' : '利空'
  const allResources = [holdings, watchlist, kyc, riskProfile, personalized, portfolioRisk]
  const refreshing = allResources.some(resource => resource.loading)
  const analysisRecord = asRecord(holdingAnalysis.result)
  const analysisSignal = asRecord(analysisRecord.signal)
  const analysisSuggestions = strings(analysisSignal.rebalance_suggestions)
  const assistantSnapshot = useMemo(() => ({
    holdings: holdingItems,
    watchlist: watchlistItems,
    kyc: kycRecord,
    effectiveRiskProfile: riskProfileRecord,
    personalizedProfile: personalizedRecord,
    portfolioRisk: risk,
    ...(holdingAnalysis.result === undefined ? {} : { latestHoldingAnalysis: holdingAnalysis.result }),
  }), [holdingAnalysis.result, holdings.value, kyc.value, personalized.value, portfolioRisk.value, riskProfile.value, watchlist.value])

  const runHoldingAnalysis = (): void => {
    if (holdingAnalysis.running || holdingItems.length === 0) return
    setHoldingAnalysis({ running: true, error: '' })
    setNotice('')
    void (async () => {
      const started = await requestData({
        operation: 'trading-core.holdings-analyze',
        input: { holdings: holdingItems.map(item => ({
          ticker: text(item.ticker, text(item.code, '')),
          quantity: number(item.quantity) ?? 0,
          cost_price: number(item.cost_price) ?? 0,
        })), mode: 'quick', use_saved: true },
      })
      const id = taskId(started)
      if (id === '') throw new Error('后端未返回任务编号')
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
          const result = await requestData({ operation: 'trading-core.task-result', input: { task_id: id } })
          setHoldingAnalysis({ running: false, result, error: '' })
          setNotice('组合风险分析已完成，结果已在当前页面更新。')
          portfolioRisk.refresh()
          return
        } catch (reason) {
          if (!isTaskPending(reason)) throw reason
          await pause(1_200)
        }
      }
      throw new Error('分析仍在运行，请稍后重试')
    })().catch((reason: unknown) => {
      setHoldingAnalysis({ running: false, error: errorText(reason) })
    })
  }

  const finishKyc = (message: string): void => {
    setKycDialog(null)
    setNotice(message)
    kyc.refresh()
    riskProfile.refresh()
    personalized.refresh()
    portfolioRisk.refresh()
  }

  const refreshAll = (): void => {
    setNotice('')
    holdings.refresh()
    watchlist.refresh()
    kyc.refresh()
    riskProfile.refresh()
    personalized.refresh()
    portfolioRisk.refresh()
  }

  const addWatchItem = (event: FormEvent): void => {
    event.preventDefault()
    if (!/^\d{6}$/.test(watchCode)) {
      setWatchError('请输入 6 位股票代码。')
      return
    }
    setWatchBusy(watchCode)
    setWatchError('')
    void requestData({
      operation: 'market-watch.watch-add',
      input: { code: watchCode, ...(watchName.trim() === '' ? {} : { name: watchName.trim() }) },
    }).then(() => {
      setAddingWatch(false)
      setWatchCode('')
      setWatchName('')
      setNotice(`已将 ${watchCode} 加入自选。`)
      watchlist.refresh()
    }, (reason: unknown) => {
      setWatchError(`添加失败：${errorText(reason)}`)
    }).finally(() => { setWatchBusy('') })
  }

  const removeWatchItem = (code: string): void => {
    setWatchBusy(code)
    setWatchError('')
    void requestData({ operation: 'market-watch.watch-remove', input: { code } }).then(() => {
      setNotice(`已将 ${code} 移出自选。`)
      watchlist.refresh()
    }, (reason: unknown) => {
      setWatchError(`移除失败：${errorText(reason)}`)
    }).finally(() => { setWatchBusy('') })
  }

  return (
    <div className={css.page}>
      <div className={css.pageHeader}>
        <div><h1>我的投研</h1><p>管理持仓与自选，校准风险画像，并持续检查组合风险。</p></div>
        <div className={css.pageActions}>
          <button type="button" className={css.secondaryButton} disabled={refreshing} onClick={refreshAll}>{refreshing ? '刷新中…' : '刷新'}</button>
          <button type="button" className={css.secondaryButton} onClick={() => { setEditingHoldings(true) }}>编辑持仓</button>
          <button type="button" className={css.primaryButton} disabled={holdingAnalysis.running || holdingItems.length === 0} onClick={runHoldingAnalysis}>{holdingAnalysis.running ? '分析中…' : '分析组合风险'}</button>
        </div>
      </div>

      {notice !== '' && <div className={css.notice} role="status">{notice}</div>}
      {holdingAnalysis.error !== '' && <div className={css.inlineError} role="alert">组合分析失败：{holdingAnalysis.error}</div>}

      {holdingAnalysis.result !== undefined && (
        <section className={css.analysisResult} aria-label="最新组合风险分析">
          <header><div><span>最新组合风险分析</span><strong>{text(analysisSignal.risk_level, number(analysisSignal.weighted_risk_score) === undefined ? '已完成' : `风险分 ${number(analysisSignal.weighted_risk_score)?.toFixed(2)}`)}</strong></div><small>来自持仓分析接口 · 快速模式</small></header>
          <div>
            <dl><div><dt>组合市值</dt><dd>{money(analysisSignal.total_market_value)}</dd></div><div><dt>浮动盈亏</dt><dd>{money(analysisSignal.floating_pnl)}</dd></div><div><dt>年化波动率</dt><dd>{formatRatio(analysisSignal.portfolio_annualized_vol)}</dd></div><div><dt>集中度 HHI</dt><dd>{number(analysisSignal.concentration_hhi)?.toFixed(3) ?? '—'}</dd></div></dl>
            {analysisSuggestions.length > 0 && <ul>{analysisSuggestions.slice(0, 4).map(item => <li key={item}>{item}</li>)}</ul>}
          </div>
        </section>
      )}

      <div className={css.summaryGrid}>
        <div><span>持仓数量</span><strong>{holdings.loaded ? holdingItems.length : '—'}</strong><small>{holdings.error === '' ? '当前已保存' : '数据待恢复'}</small></div>
        <div><span>自选数量</span><strong>{watchlist.loaded ? watchlistItems.length : '—'}</strong><small>持续跟踪标的</small></div>
        <div><span>组合集中度</span><strong>{portfolioRisk.loaded ? number(concentration)?.toFixed(3) ?? '—' : '—'}</strong><small>{breaches.length > 0 ? `${breaches.length} 项预算突破` : '未发现预算突破'}</small></div>
        <div><span>当前风险画像</span><strong>{kyc.loaded || riskProfile.loaded ? effectiveProfile : '—'}</strong><small>{inferredProfile === '待完善' ? '等待风险测评' : `问卷推断：${inferredProfile}`}</small></div>
      </div>

      <div className={css.mainGrid}>
        <div className={css.stack}>
          <Panel
            title="持仓明细"
            subtitle="结合组合风险展示权重与预算状态"
            status={<ResourceStatus resource={holdings} settled={`${holdingItems.length} 项`} />}
          >
            {holdings.loaded && holdings.error !== '' && <button type="button" className={css.inlineRetry} onClick={holdings.refresh}>持仓更新失败，点击重试</button>}
            <RegionState resource={holdings} empty={holdingItems.length === 0}>
              {holdingItems.length === 0 ? (
                <div><strong>还没有持仓</strong><p>添加真实持仓后，可查看集中度与风险预算。</p><button type="button" className={css.secondaryButton} onClick={() => { setEditingHoldings(true) }}>添加持仓</button></div>
              ) : (
                <div className={css.tableWrap}>
                  <table>
                    <thead><tr><th>代码 / 名称</th><th>数量</th><th>成本</th><th>权重</th><th>风险</th><th>
                      <span className={css.visuallyHidden}>操作</span></th>
                    </tr></thead>
                    <tbody>
                      {holdingItems.map((item, index) => {
                        const ticker = text(item.ticker, text(item.code, ''))
                        const riskPosition = positionByTicker.get(ticker) ?? {}
                        const rowRisk = text(
                          riskPosition.risk,
                          text(riskPosition.severity, portfolioRisk.loaded ? text(singleWeightBreach?.severity, '正常') : '—'),
                        )
                        const rowWeight = riskPosition.weight ?? riskSummary.equal_weight
                        return (
                          <tr key={`${ticker}-${index}`}>
                            <td><strong>{text(item.name, '—')}</strong><small>{ticker}</small></td>
                            <td>{number(item.quantity)?.toLocaleString('zh-CN') ?? '—'}</td>
                            <td>{money(item.cost_price)}</td>
                            <td>{formatRatio(rowWeight)}</td>
                            <td><span className={css.riskTag} data-risk={rowRisk}>{rowRisk}</span></td>
                            <td><button type="button" className={css.textButton} onClick={() => {
                              onAskAssistant({
                                intent: 'portfolio.holding-research',
                                module: 'portfolio',
                                question: `分析持仓标的 ${ticker}，结合风险画像说明投资逻辑、仓位风险和后续关注点。`,
                                data: { ...assistantSnapshot, selectedHolding: item, selectedHoldingRisk: riskPosition },
                              })
                            }}>问投研助理</button></td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </RegionState>
          </Panel>

          <Panel
            title="自选列表"
            subtitle="管理需要持续跟踪的研究标的"
            status={<ResourceStatus resource={watchlist} settled={`${watchlistItems.length} 项`} />}
          >
            {watchlist.loaded && watchlist.error !== '' && <button type="button" className={css.inlineRetry} onClick={watchlist.refresh}>自选更新失败，点击重试</button>}
            {watchError !== '' && <div className={css.inlineError} role="alert">{watchError}</div>}
            <RegionState resource={watchlist} empty={watchlistItems.length === 0}>
              {watchlistItems.length === 0 ? (
                <div><strong>还没有自选标的</strong><p>添加股票代码后，可在盯盘与个性化研究中持续跟踪。</p></div>
              ) : (
                <div className={css.watchList}>
                  {watchlistItems.map(item => (
                    <article key={item.code}>
                      <div><strong>{item.name === '' ? item.code : item.name}</strong>{item.name !== '' && <small>{item.code}</small>}</div>
                      <div>
                        <button type="button" className={css.textButton} onClick={() => {
                          onAskAssistant({
                            intent: 'portfolio.watchlist-research',
                            module: 'portfolio',
                            question: `研究自选标的 ${item.name} ${item.code}，给出核心逻辑、主要风险与跟踪清单。`,
                            data: { ...assistantSnapshot, selectedWatchItem: item },
                          })
                        }}>研究</button>
                        <button type="button" className={css.removeButton} disabled={watchBusy !== ''} onClick={() => { removeWatchItem(item.code) }}>{watchBusy === item.code ? '移除中…' : '移除'}</button>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </RegionState>
            {addingWatch ? (
              <form className={css.watchForm} onSubmit={addWatchItem}>
                <label>股票代码<input aria-label="自选股票代码" inputMode="numeric" maxLength={6} value={watchCode} onChange={(event) => { setWatchCode(event.target.value.trim()) }} /></label>
                <label>名称（选填）<input aria-label="自选股票名称" value={watchName} onChange={(event) => { setWatchName(event.target.value) }} /></label>
                <div><button type="button" className={css.secondaryButton} onClick={() => { setAddingWatch(false); setWatchError('') }}>取消</button><button type="submit" className={css.primaryButton} disabled={watchBusy !== ''}>添加自选</button></div>
              </form>
            ) : <button type="button" className={css.addWatchButton} onClick={() => { setAddingWatch(true); setWatchError('') }}>＋ 添加自选</button>}
          </Panel>
        </div>

        <div className={css.stack}>
          <Panel
            title="KYC 风险画像"
            subtitle="分别查看问卷推断与当前生效画像"
            status={<ResourceStatus resource={kyc} settled={kycStatusLabel(kycRecord.status)} />}
          >
            {kyc.loaded && kyc.error !== '' && <button type="button" className={css.inlineRetry} onClick={kyc.refresh}>画像更新失败，点击重试</button>}
            <RegionState resource={riskProfile} empty={false}>
              <div className={css.profileHero}>
                <div><span>当前生效画像</span><strong>{effectiveProfile}</strong></div>
                <ResourceStatus resource={riskProfile} settled="全局生效" />
              </div>
            </RegionState>
            <RegionState resource={kyc} empty={false}>
              <dl className={css.detailList}>
                <div><dt>问卷推断</dt><dd>{inferredProfile}</dd></div>
                <div><dt>问卷状态</dt><dd>{kycStatusLabel(kycRecord.status)}</dd></div>
                <div><dt>单股预算上限</dt><dd>{formatRatio(budget.single_stock_weight_max)}</dd></div>
              </dl>
            </RegionState>
            <div className={css.cardActions}>
              <button type="button" className={css.secondaryButton} disabled={!kyc.loaded || Object.keys(asRecord(kycRecord.question_bank)).length === 0} onClick={() => { setKycDialog('questionnaire') }}>重做风险测评</button>
              <button type="button" className={css.primaryButton} disabled={!['completed', 'adjusted'].includes(text(kycRecord.status, ''))} onClick={() => { setKycDialog('adjust') }}>复核画像</button>
            </div>
          </Panel>

          <Panel
            title="行为增强画像"
            subtitle="根据近期研究行为调整内容排序"
            status={<ResourceStatus resource={personalized} settled="已更新" />}
          >
            {personalized.loaded && personalized.error !== '' && <button type="button" className={css.inlineRetry} onClick={personalized.refresh}>画像更新失败，点击重试</button>}
            <RegionState resource={personalized} empty={Object.keys(personalizedRecord).length === 0}>
              {Object.keys(personalizedRecord).length === 0 ? (
                <div><strong>行为画像正在形成</strong><p>随着阅读、反馈和研究行为增加，这里会显示稳定的偏好。</p></div>
              ) : (
                <>
                  <div className={css.aggression}>
                    <div><span>有效激进度</span><strong>{number(personalizedRecord.effective_aggression)?.toFixed(2) ?? '—'}</strong></div>
                    <progress
                      className={css.meter}
                      aria-label="有效激进度"
                      max={100}
                      value={Math.min(100, Math.max(0, (number(personalizedRecord.effective_aggression) ?? 0) * 100))}
                    />
                  </div>
                  <div className={css.tagList}>
                    {behaviorIndustries.map(item => <span key={`industry-${text(item.industry)}`}>关注：{text(item.industry)}</span>)}
                    {behaviorTickers.map(item => <span key={`ticker-${text(item.ticker)}`}>常看：{text(item.ticker)}</span>)}
                    {directionPreference !== '' && <span>方向偏好：{directionPreference}</span>}
                    {behaviorStrategies.map(item => (
                      <span key={`strategy-${text(item.strategy_id)}`}>策略亲和：{text(item.name, text(item.kind))}</span>
                    ))}
                    {strings(personalizedRecord.notes).slice(0, 1).map(item => <span key={item}>{item}</span>)}
                  </div>
                  <button type="button" className={css.assistantButton} onClick={() => {
                    onAskAssistant({
                      intent: 'portfolio.behavior-profile-interpretation',
                      module: 'portfolio',
                      question: '解释行为增强画像，并说明它如何影响事件、策略和风险内容的排序。',
                      data: assistantSnapshot,
                    })
                  }}>让投研助理解读画像</button>
                </>
              )}
            </RegionState>
          </Panel>

          <Panel
            title="组合风险"
            subtitle="检查集中度、影子回撤与预算突破"
            status={<ResourceStatus resource={portfolioRisk} settled={`${breaches.length} 项突破`} />}
          >
            {portfolioRisk.loaded && portfolioRisk.error !== '' && <button type="button" className={css.inlineRetry} onClick={portfolioRisk.refresh}>组合风险更新失败，点击重试</button>}
            <RegionState resource={portfolioRisk} empty={false}>
              <dl className={css.detailList}>
                <div><dt>集中度 HHI</dt><dd>{number(concentration)?.toFixed(3) ?? '—'}</dd></div>
                <div><dt>影子最大回撤</dt><dd>{formatRatio(riskSummary.shadow_max_drawdown ?? risk.shadow_drawdown)}</dd></div>
                <div><dt>影子波动率</dt><dd>{formatRatio(riskSummary.shadow_annualized_vol ?? risk.shadow_volatility)}</dd></div>
              </dl>
              {breaches.length === 0 ? <div className={css.goodState}>当前没有检测到风险预算突破</div> : (
                <div className={css.breachList}>
                  {breaches.slice(0, 6).map((item, index) => (
                    <article key={text(item.id, text(item.indicator, String(index)))}>
                      <span data-severity={text(item.severity, '中')}>{text(item.severity, '中')}</span>
                      <div><strong>{text(item.label, text(item.title, '风险预算突破'))}</strong><p>{text(item.detail, text(item.reason, '请复核当前仓位。'))}</p></div>
                    </article>
                  ))}
                </div>
              )}
            </RegionState>
          </Panel>
        </div>
      </div>

      {editingHoldings && <HoldingEditor
        initialItems={holdingItems}
        requestData={requestData}
        onCancel={() => { setEditingHoldings(false) }}
        onSaved={(count) => {
          setEditingHoldings(false)
          setNotice(`已保存 ${count} 条持仓，组合风险正在刷新。`)
          holdings.refresh()
          portfolioRisk.refresh()
        }}
      />}
      {kycDialog === 'questionnaire' && <KycQuestionnaire profile={kycRecord} requestData={requestData} onCancel={() => { setKycDialog(null) }} onSaved={finishKyc} />}
      {kycDialog === 'adjust' && <KycAdjustment profile={kycRecord} requestData={requestData} onCancel={() => { setKycDialog(null) }} onSaved={finishKyc} />}
    </div>
  )
}
