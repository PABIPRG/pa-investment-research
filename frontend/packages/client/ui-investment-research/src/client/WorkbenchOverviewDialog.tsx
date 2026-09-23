import { Button, Input, TextArea } from '@deepseek-ai/dsh-client-ui-primitives'
import { HoldingsActionDialog } from './HoldingsActionDialog.tsx'
import { ManualTradePanel } from './ManualTradePanel.tsx'
import { PortfolioPerformanceContent, PortfolioPerformanceNotes, signedPercent, tone } from './PortfolioPerformanceDialog.tsx'
import type { PortfolioPerformanceContentProps } from './PortfolioPerformanceDialog.tsx'
import type { TradeSelection } from './ManualTradePanel.tsx'
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { InvestmentDataRequest } from '@deepseek-ai/dsh-client-investment-research-runtime/client'
import { asRecord, compactMoney, money, number, productErrorText, records, text, unitCost } from './data.ts'
import { DetailDialog, riskSource, riskSuggestions } from './DetailDialogs.tsx'
import { holdingsWorkbookToDelimitedText, parseHoldingsImport } from './holdings-import.ts'
import { useRequestResource } from './InvestmentShell.tsx'
import { privateFunds, useFundsPrivacy } from './funds-privacy.tsx'
import { PositionRiskDialog, PositionRiskPlanCell, positionRiskPlanMap } from './PositionRiskControls.tsx'
import css from './InvestmentShell.module.css'

type RequestData = (request: InvestmentDataRequest) => Promise<unknown>

export type WorkbenchDetailKind =
  | 'holdings'
  | 'risk-profile'
  | 'risk-center'

export interface WorkbenchPositionDetail {
  readonly code: string
  readonly name: string
  readonly quantity: number | undefined
  readonly costPrice: number | undefined
  readonly currentPrice: number | undefined
}

export interface WorkbenchHoldingInput {
  readonly ticker: string
  readonly quantity: number
  readonly cost_price: number
}

export type WorkbenchHoldingSaveSource = 'manual' | 'bulk_import'

interface WorkbenchOverviewDialogProps {
  readonly performance?: PortfolioPerformanceContentProps
  readonly initialHoldingsFlow?: 'view' | 'sync'
  readonly kind: WorkbenchDetailKind
  readonly positions: readonly WorkbenchPositionDetail[]
  readonly risk: Record<string, unknown>
  readonly alerts: readonly Record<string, unknown>[]
  readonly riskAsOf: string | undefined
  readonly alertsAsOf: string | undefined
  readonly alertsDegraded: boolean | undefined
  readonly alertsDegradedReason: string | undefined
  readonly holdingsState: WorkbenchResourceStatus
  readonly riskState: WorkbenchResourceStatus
  readonly alertsState: WorkbenchResourceStatus
  readonly onOpenAlert: (item: Record<string, unknown>) => void
  readonly onSaveHoldings: (holdings: readonly WorkbenchHoldingInput[], source: WorkbenchHoldingSaveSource) => Promise<void>
  readonly onSyncHoldings: (token: string) => Promise<readonly WorkbenchHoldingInput[]>
  readonly requestData: RequestData
  readonly brokerSync?: boolean
  /** Retained for host compatibility; the single-action flow resolves its source automatically. */
  readonly holdingsProviders?: readonly string[]
  readonly onHoldingsChanged?: () => void
  readonly onClose: () => void
}

export interface WorkbenchResourceStatus {
  readonly loaded: boolean
  readonly busy: boolean
  readonly error: string
}

const DIALOG_COPY: Readonly<Record<WorkbenchDetailKind, { title: string; description: string }>> = Object.freeze({
  holdings: { title: '持仓明细', description: '先查看资产汇总与历史收益，再核对和管理持仓标的；金额不含现金。' },
  'risk-profile': { title: '风险画像详情', description: '基于当前持仓与组合风险预算返回的画像结果。' },
  'risk-center': { title: '组合风险中心', description: '集中查看风险预算、预算突破与全部预警。' },
})

function quantity(value: number | undefined): string {
  return value === undefined ? '—' : `${value.toLocaleString('zh-CN')} 股`
}

function amount(value: number | undefined): string {
  return value === undefined ? '—' : money(value)
}

function positionAmount(item: WorkbenchPositionDetail, price: number | undefined): number | undefined {
  return item.quantity === undefined || price === undefined ? undefined : item.quantity * price
}

function summedAmount(
  positions: readonly WorkbenchPositionDetail[],
  price: (item: WorkbenchPositionDetail) => number | undefined,
): number | undefined {
  if (positions.length === 0) return undefined
  let sum = 0
  for (const item of positions) {
    const value = positionAmount(item, price(item))
    if (value === undefined) return undefined
    sum += value
  }
  return sum
}

function PositionTable({
  positions, saving, pendingDelete, positionPlans, onEdit, onTrade, onEditRisk, onRequestDelete, onConfirmDelete, onCancelDelete,
  editDraft, onChangeDraft, onCancelEdit,
}: {
  positions: readonly WorkbenchPositionDetail[]
  saving?: boolean
  pendingDelete?: string
  onTrade?: (selection: TradeSelection) => void
  onEdit?: (item: WorkbenchPositionDetail) => void
  positionPlans?: Map<string, Record<string, unknown>>
  onEditRisk?: (item: WorkbenchPositionDetail) => void
  onRequestDelete?: (code: string) => void
  onConfirmDelete?: (code: string) => void
  onCancelDelete?: () => void
  editDraft?: HoldingEditorDraft | undefined
  onChangeDraft?: (draft: HoldingEditorDraft) => void
  onCancelEdit?: () => void
}) {
  const { hidden: fundsHidden } = useFundsPrivacy()
  if (positions.length === 0) {
    return <div className={css.workbenchOverviewEmpty}>尚未保存持仓，当前没有可展示的明细。</div>
  }
  return (
    <div className={css.workbenchOverviewTableWrap}>
      <table className={css.workbenchOverviewTable} data-kind="holdings">
        <thead>
          <tr>
            <th scope="col">标的</th>
            <th scope="col">持仓数量</th>
            <th scope="col">成本价</th>
            <th scope="col">成本金额</th>
            <th scope="col">现价 / 市值</th>
            <th scope="col">较成本</th>
            {onEditRisk !== undefined && <th scope="col" className={css.holdingRiskHeading}>止盈止损</th>}
            {onEdit !== undefined && <th scope="col">操作</th>}
          </tr>
        </thead>
        <tbody>
          {positions.map((item, index) => {
            const price = item.costPrice
            const priceReturn = price !== undefined && price > 0 && item.currentPrice !== undefined
              ? (item.currentPrice - price) / price : undefined
            const editing = editDraft?.originalCode === item.code
            const actionsDisabled = saving || editDraft !== undefined
            return (
              <tr key={`${item.code}-${index}`} data-editing={editing || undefined}>
                <th scope="row"><strong className={item.name === '名称加载中' ? css.securityNameLoading : undefined}>{item.name}</strong><small>{item.code}</small></th>
                <td><span className={css.workbenchMobileLabel}>持仓数量</span>{editing && editDraft
                  ? <Input className={css.holdingInlineInput ?? ''} aria-label="持仓数量" type="number" min="0" step="any" disabled={saving} value={editDraft.quantity} onChange={event => { onChangeDraft?.({ ...editDraft, quantity: event.target.value }) }} />
                  : privateFunds(quantity(item.quantity), fundsHidden)}</td>
                <td><span className={css.workbenchMobileLabel}>成本价</span>{editing && editDraft
                  ? <Input className={css.holdingInlineInput ?? ''} aria-label="成本价" type="number" min="0" step="any" disabled={saving} value={editDraft.costPrice} onChange={event => { onChangeDraft?.({ ...editDraft, costPrice: event.target.value }) }} />
                  : privateFunds(unitCost(item.costPrice), fundsHidden)}</td>
                <td><span className={css.workbenchMobileLabel}>成本金额</span>{privateFunds(amount(positionAmount(item, price)), fundsHidden)}</td>
                <td><span className={css.workbenchMobileLabel}>现价 / 市值</span><span>{amount(item.currentPrice)}<br />{privateFunds(amount(positionAmount(item, item.currentPrice)), fundsHidden)}</span></td>
                <td data-tone={tone(priceReturn)}><span className={css.workbenchMobileLabel}>较成本</span>{signedPercent(priceReturn)}</td>
                {onEditRisk !== undefined && (
                  <td>
                    <span className={css.workbenchMobileLabel}>止盈止损</span>
                    <PositionRiskPlanCell
                      plan={positionPlans?.get(item.code)}
                      disabled={actionsDisabled}
                      onEdit={() => { onEditRisk(item) }}
                    />
                  </td>
                )}
                {onEdit !== undefined && (
                  <td className={css.workbenchHoldingActions}>
                    <span className={css.workbenchMobileLabel}>操作</span>
                    {editing ? (
                      <div className={css.holdingRowActions}>
                        <Button className={css.holdingTextButton} variant="ghost" size="sm" type="submit" aria-label="保存持仓" disabled={saving}>{saving ? '保存中…' : '保存'}</Button>
                        <Button className={css.holdingTextButton} variant="ghost" size="sm" aria-label="取消编辑" disabled={saving} onClick={onCancelEdit}>取消</Button>
                      </div>
                    ) : pendingDelete === item.code ? (
                      <div className={css.workbenchDeleteConfirm}>
                        <span>确认删除该持仓？</span>
                        <button type="button" disabled={saving} aria-label={`确认删除 ${item.code}`} onClick={() => { onConfirmDelete?.(item.code) }}>确认删除</button>
                        <button type="button" disabled={saving} aria-label={`取消删除 ${item.code}`} onClick={onCancelDelete}>取消</button>
                      </div>
                    ) : (
                      <div className={css.holdingRowActions}>
                        {onTrade && <><Button className={css.holdingTextButton} variant="ghost" size="sm" disabled={actionsDisabled} onClick={() => { onTrade({ side: 'buy', ticker: item.code, name: item.name }) }}>买入</Button><Button className={css.holdingTextButton} variant="ghost" size="sm" disabled={actionsDisabled} onClick={() => { onTrade({ side: 'sell', ticker: item.code, name: item.name }) }}>卖出</Button><Button className={css.holdingTextButton} variant="ghost" size="sm" disabled={actionsDisabled} onClick={() => { onTrade({ side: 'history', ticker: item.code, name: item.name }) }}>历史</Button></>}
                        <Button className={css.holdingTextButton} variant="ghost" size="sm" disabled={actionsDisabled} data-holding-edit={item.code} aria-label={`编辑 ${item.name} ${item.code}`} onClick={() => { onEdit(item) }}>编辑</Button>
                        <Button className={`${css.holdingTextButton} ${css.holdingDangerButton}`} variant="ghost" size="sm" disabled={actionsDisabled} aria-label={`删除 ${item.name} ${item.code}`} onClick={() => { onRequestDelete?.(item.code) }}>删除</Button>
                      </div>
                    )}
                  </td>
                )}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

interface HoldingEditorDraft {
  readonly originalCode?: string
  readonly code: string
  readonly quantity: string
  readonly costPrice: string
}

const EMPTY_HOLDING_DRAFT: HoldingEditorDraft = Object.freeze({ code: '', quantity: '', costPrice: '' })

function holdingFromDraft(draft: HoldingEditorDraft): { holding?: WorkbenchHoldingInput; error: string } {
  const code = draft.code.trim()
  const quantityValue = Number(draft.quantity)
  const costValue = Number(draft.costPrice)
  if (!/^\d{6}$/.test(code)) return { error: '股票代码必须为六位数字。' }
  if (!Number.isFinite(quantityValue) || quantityValue <= 0) return { error: '数量必须大于 0。' }
  if (!Number.isFinite(costValue) || costValue <= 0) return { error: '成本价必须大于 0。' }
  return { holding: { ticker: code, quantity: quantityValue, cost_price: costValue }, error: '' }
}

function normalizedHoldings(positions: readonly WorkbenchPositionDetail[]): WorkbenchHoldingInput[] | undefined {
  const result: WorkbenchHoldingInput[] = []
  for (const item of positions) {
    if (!/^\d{6}$/.test(item.code) || item.quantity === undefined || item.quantity <= 0 || item.costPrice === undefined || item.costPrice <= 0) return undefined
    result.push({ ticker: item.code, quantity: item.quantity, cost_price: item.costPrice })
  }
  return result
}

function sameHoldings(left: readonly WorkbenchHoldingInput[], right: readonly WorkbenchHoldingInput[]): boolean {
  return left.length === right.length && left.every((item, index) => {
    const candidate = right[index]
    return candidate !== undefined
      && item.ticker === candidate.ticker
      && item.quantity === candidate.quantity
      && item.cost_price === candidate.cost_price
  })
}

function HoldingsBulkImport({
  currentCount, source, saving, error, onSourceChange, onError, onSave,
}: {
  currentCount: number
  source: string
  saving: boolean
  error: string
  onSourceChange: (source: string) => void
  onError: (message: string) => void
  onSave: (holdings: readonly WorkbenchHoldingInput[]) => Promise<void>
}) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const result = useMemo(() => parseHoldingsImport(source), [source])
  const canSave = result.items.length > 0 && result.errors.length === 0 && !saving

  const readFile = async (file: File): Promise<void> => {
    if (saving) return
    if (!/\.(csv|tsv|txt|xls|xlsx)$/i.test(file.name)) {
      onError('仅支持 CSV、TSV、TXT、XLS 或 XLSX 文件。')
      return
    }
    try {
      const content = /\.xlsx?$/i.test(file.name)
        ? holdingsWorkbookToDelimitedText(await file.arrayBuffer())
        : await file.text()
      onError('')
      onSourceChange(content)
    } catch {
      onError('文件读取失败，请确认文件未损坏，或直接粘贴表格内容。')
    }
  }

  return (
    <section className={css.workbenchImportPanel} role="tabpanel" aria-labelledby="holdings-batch-tab">
      <div className={css.workbenchImportGuide}>
        <strong>批量导入会整体替换当前持仓</strong>
        <span>支持 CSV、TSV、XLS、XLSX 和从 Excel / WPS 复制的表格，至少需要股票代码、数量、成本价三列。</span>
      </div>
      <div
        className={css.workbenchImportDropzone}
        data-dragging={dragging ? 'true' : 'false'}
        role="button"
        tabIndex={saving ? -1 : 0}
        aria-label="拖放持仓文件"
        aria-disabled={saving}
        onClick={() => { if (!saving) fileInputRef.current?.click() }}
        onKeyDown={(event) => {
          if (!saving && (event.key === 'Enter' || event.key === ' ')) {
            event.preventDefault()
            fileInputRef.current?.click()
          }
        }}
        onDragEnter={(event) => { event.preventDefault(); if (!saving) setDragging(true) }}
        onDragOver={(event) => { event.preventDefault() }}
        onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false) }}
        onDrop={(event) => {
          event.preventDefault(); setDragging(false)
          const file = event.dataTransfer.files[0]
          if (file !== undefined) void readFile(file)
        }}
      >
        <strong>拖放持仓文件到这里</strong>
        <span>或点击选择 CSV / TSV / TXT / XLS / XLSX 文件</span>
        <input
          ref={fileInputRef}
          type="file"
          aria-label="选择持仓文件"
          accept=".csv,.tsv,.txt,.xls,.xlsx,text/csv,text/tab-separated-values,text/plain,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          disabled={saving}
          onClick={(event) => { event.stopPropagation() }}
          onChange={(event) => {
            const file = event.currentTarget.files?.[0]
            if (file !== undefined) void readFile(file)
            event.currentTarget.value = ''
          }}
        />
      </div>
      <label className={css.workbenchImportField}>
        <span>或粘贴表格内容</span>
        <TextArea
          aria-label="持仓导入内容"
          value={source}
          disabled={saving}
          placeholder={'股票代码,数量,成本价\n600519,100,1500\n000858,200,135'}
          onChange={(event) => { onSourceChange(event.target.value) }}
        />
      </label>
      <div className={css.workbenchImportStats} aria-label="导入统计">
        <span>有效 {result.items.length} 条</span>
        <span data-error={result.errors.length > 0 ? 'true' : 'false'}>错误 {result.errors.length} 条</span>
      </div>
      {result.errors.length > 0 && (
        <div className={css.workbenchImportErrors} role="alert">
          <strong>请先修正以下问题</strong>
          {result.errors.slice(0, 8).map(message => <span key={message}>{message}</span>)}
          {result.errors.length > 8 && <span>另有 {result.errors.length - 8} 个问题未展示。</span>}
        </div>
      )}
      {error !== '' && <div className={css.workbenchImportErrors} role="alert"><strong>导入失败</strong><span>{error}</span></div>}
      {result.items.length > 0 && (
        <div className={css.workbenchImportPreview}>
          <div><strong>导入预览</strong><span>显示前 {Math.min(20, result.items.length)} 条</span></div>
          <div className={css.workbenchImportTableWrap}>
            <table>
              <thead><tr><th>股票代码</th><th>数量</th><th>成本价</th></tr></thead>
              <tbody>{result.items.slice(0, 20).map(item => (
                <tr key={item.ticker}><td>{item.ticker}</td><td>{item.quantity.toLocaleString('zh-CN')}</td><td>{money(item.cost_price)}</td></tr>
              ))}</tbody>
            </table>
          </div>
          {result.items.length > 20 && <p>另有 {result.items.length - 20} 条将在提交时一并导入。</p>}
        </div>
      )}
      <div className={css.workbenchImportCommit}>
        <div aria-label="替换范围"><span>当前 {currentCount} 条</span><b aria-hidden="true">→</b><strong>导入后 {result.items.length} 条</strong></div>
        <button type="button" className={css.primaryButton} disabled={!canSave} onClick={() => { void onSave(result.items) }}>
          {saving ? '正在批量保存…' : `确认替换 ${result.items.length} 条持仓`}
        </button>
      </div>
    </section>
  )
}

/**
 * Chooses a persisted holdings provider, reads real holdings from its broker
 * client, and replaces the saved portfolio with them after explicit confirmation.
 */
function HoldingsSyncPanel({ requestData, onSync, onNativeSync, onImport, onClose, onSavingChange }: {
  requestData: RequestData
  onSync: (token: string) => Promise<readonly WorkbenchHoldingInput[]>
  onNativeSync: (items: readonly WorkbenchHoldingInput[]) => void
  onImport: () => void
  onClose: () => void
  onSavingChange: (saving: boolean) => void
}) {
  const boundedRequest = useCallback((request: InvestmentDataRequest): Promise<unknown> => new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => { reject(new Error('检测暂未完成，请重新检测，或先手动录入持仓。')) }, 12_000)
    Promise.resolve().then(() => requestData(request)).then(resolve, reject).finally(() => { window.clearTimeout(timer) })
  }), [requestData])
  const source = useRequestResource(boundedRequest)
  const config = useRequestResource(boundedRequest)
  const [slow, setSlow] = useState(false)
  const [busy, setBusy] = useState(false)
  const [reading, setReading] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [error, setError] = useState('')
  const [blocking, setBlocking] = useState('')
  const [preview, setPreview] = useState<Record<string, unknown>>()
  const [saved, setSaved] = useState(false)
  const [authorization, setAuthorization] = useState<'once' | 'persistent'>('once')
  const [troubleshoot, setTroubleshoot] = useState(false)
  const recheckOnFocus = useRef(false)
  const alive = useRef(true)
  const native = (window as unknown as { __DSH_ELECTRON__?: {
    holdingsAction?: (input: { action: string; account_mode: string; authorization?: 'once' | 'persistent'; session_id?: string; time_overrides?: Record<string, string> }) => Promise<unknown>
  } }).__DSH_ELECTRON__?.holdingsAction
  const reload = useCallback((): void => {
    source.run({ operation: 'trading-core.holdings-source' })
    config.run({ operation: 'trading-core.holdings-user-config' })
  }, [source.run, config.run])
  useEffect(() => { reload() }, [reload])
  useEffect(() => {
    alive.current = true
    const focus = (): void => {
      if (!recheckOnFocus.current) return
      recheckOnFocus.current = false
      setBlocking(''); reload()
    }
    window.addEventListener('focus', focus)
    return () => { alive.current = false; window.removeEventListener('focus', focus) }
  }, [reload])
  const state = asRecord(source.state.value)
  const effective = asRecord(asRecord(config.state.value).effective)
  const provider = text(effective.HOLDINGS_PROVIDER, text(state.provider, 'manual'))
  const account = text(effective.HOLDINGS_ACCOUNT_MODE, text(state.account_mode, 'simulated')) === 'real' ? 'real' : 'simulated'
  const accountLabel = account === 'simulated' ? '模拟操盘' : '真实操盘'
  const path = `交易 → ${account === 'simulated' ? '模拟' : 'A股'} → 股票 → 持仓`
  const platform = text(state.platform, 'linux')
  const reason = blocking || text(state.blocking_reason, '')
  const loading = source.busy || config.busy
  useEffect(() => {
    if (native === undefined) return
    void native({ action: 'consent_status', account_mode: account }).then(value => {
      setAuthorization(asRecord(value).persistent_authorization === true ? 'persistent' : 'once')
    }).catch(() => {})
  }, [native, account])
  useEffect(() => {
    setSlow(false)
    if (!loading) return
    const timer = window.setTimeout(() => { setSlow(true) }, 3_000)
    return () => { window.clearTimeout(timer) }
  }, [loading])
  const navigation = reason === 'navigation_required'
  const permission = reason === 'automation_required' || (reason === 'accessibility_required' && state.accessibility !== 'granted')
  const ready = (state.available === true || navigation) && !permission
  const missing = reason === 'client_missing' || reason === 'client_location_required'
  // OCR 缺失不进 ready / missing / permission 三处判断：验证码不保证每次都弹，
  // 缺 OCR 的机器照样读得到不弹验证码的持仓，这里只提示风险，读取入口保持可用。
  const ocrMissing = text(state.captcha_ocr, '') === 'missing'
  const run = async (operation: () => Promise<void>): Promise<void> => {
    if (busy) return
    setBusy(true); setError(''); onSavingChange(true)
    try { await operation() } catch (failure) {
      if (alive.current) setError(productErrorText(failure))
    } finally {
      if (alive.current) setBusy(false)
      onSavingChange(false)
    }
  }
  const change = (entries: Record<string, string>): void => {
    void run(async () => {
      await requestData({ operation: 'trading-core.holdings-user-config-update', input: { entries } })
      setPreview(undefined); setSaved(false); setBlocking(''); reload()
    })
  }
  const acceptPreview = (value: unknown): void => {
    const result = asRecord(value)
    if (result.canceled === true) return
    if ((typeof result.preview_token === 'string' || typeof result.session_id === 'string') && records(result.items).length > 0) {
      setPreview(result); setBlocking(''); setSaved(false)
    } else {
      setBlocking(text(result.blocking_reason, 'read_failed'))
      setError(text(result.reason, '读取未完成，当前持仓保持不变。'))
    }
  }
  const read = (): void => {
    if (native !== undefined) nativeAction('read')
    else void run(async () => { acceptPreview(await requestData({ operation: 'trading-core.holdings-sync', input: { action: 'preview' } })) })
  }
  const nativeAction = (action: string): void => {
    if (native === undefined) return
    if (action === 'read') setReading(true)
    void run(async () => {
      if (action !== 'read') recheckOnFocus.current = true
      const value = await native({ action, account_mode: account, ...(action === 'read' ? { authorization } : {}),
        ...(action === 'commit' || action === 'discard' ? { session_id: text(preview?.session_id, '') } : {}) })
      if (action === 'read') acceptPreview(value)
      else if (action === 'revoke_consent') setAuthorization('once')
      else {
        const result = asRecord(value)
        if (result.blocking_reason) { setBlocking(text(result.blocking_reason, '')); setError(text(result.reason, '操作未完成。')) }
        reload()
      }
    }).finally(() => { if (alive.current && action === 'read') { setReading(false); setCancelling(false) } })
  }
  const cancelRead = (): void => {
    if (native === undefined || !reading || cancelling) return
    setCancelling(true)
    void native({ action: 'cancel_read', account_mode: account }).catch(failure => {
      if (alive.current) setError(productErrorText(failure))
    })
  }
  const download = (): void => {
    recheckOnFocus.current = true
    if (native !== undefined) nativeAction('download')
    else window.open(platform === 'darwin' ? 'https://download.10jqka.com.cn/free/mac/' : 'https://download.10jqka.com.cn/free/', '_blank', 'noopener,noreferrer')
  }
  const acquire = (): void => {
    if (native !== undefined) nativeAction('read')
    else read()
  }
  const confirm = (): void => {
    if (preview === undefined) return
    void run(async () => {
      if (native !== undefined) {
        const timeOverrides = Object.fromEntries(items.flatMap(item => item.time_source === 'user_modified'
          ? [[text(item.ticker, ''), text(item.position_time, '')]] : []))
        const result = asRecord(await native({ action: 'commit', account_mode: account, session_id: text(preview.session_id, ''), time_overrides: timeOverrides }))
        if (result.canceled === true) return
        if (result.blocking_reason) throw new Error(text(result.reason, '持仓未保存，请重新读取。'))
        const committed = records(result.items).flatMap(item => {
          const ticker = text(item.ticker, '')
          const quantity = number(item.quantity)
          const costPrice = number(item.cost_price)
          return ticker && quantity !== undefined && costPrice !== undefined ? [{ ticker, quantity, cost_price: costPrice }] : []
        })
        onNativeSync(committed)
      } else await onSync(text(preview.preview_token, ''))
      setSaved(true)
    })
  }
  const items = records(preview?.items)
  const updateFallbackTime = (ticker: string, value: string): void => {
    setPreview(current => current === undefined ? current : {
      ...current,
      changed: true,
      items: records(current.items).map(item => text(item.ticker, '') === ticker
        ? { ...item, position_time: value, time_source: 'user_modified', time_source_label: '用户修改' }
        : item),
    })
  }
  return <section className={css.workbenchSyncPanel} aria-label="从券商同步持仓">
    <div className={css.workbenchAccountMode}>
      <div className={css.workbenchSyncStepHeading}><strong>操盘账户</strong><span>选择模拟或实盘，设置会自动记住</span></div>
      <div className={css.workbenchAccountModeChoices} role="group" aria-label="操盘账户">
        {(['simulated', 'real'] as const).map(mode => <button key={mode} type="button" aria-pressed={account === mode} disabled={busy || loading} onClick={() => { change({ HOLDINGS_ACCOUNT_MODE: mode }) }}>{mode === 'simulated' ? '模拟操盘' : '真实操盘'}</button>)}
      </div>
    </div>
    <div className={css.workbenchSyncPreparation}>
      <div className={css.workbenchSyncStepHeading}><strong>获取持仓</strong><span>读取后先展示预览，确认后才会替换本地持仓</span></div>
      <p className={css.workbenchSyncPath}><span>读取位置</span><strong>{path}</strong></p>
      {!ready && !permission && <p className={css.workbenchSyncStateMessage} role="status">{loading ? (slow ? '检测耗时较长，最多等待 12 秒。你也可以先手动录入。' : '正在检查读取条件…') : text(state.reason, '当前暂时无法读取持仓。')}</p>}
      {native !== undefined && platform === 'darwin' && <div className={css.syncAuthorization} role="radiogroup" aria-label="主动读取授权">
        <strong>主动读取授权</strong>
        <label><input type="radio" name="holdings-authorization" checked={authorization === 'once'} disabled={busy} onChange={() => {
          setAuthorization('once')
          if (authorization === 'persistent') nativeAction('revoke_consent')
        }} />每次询问</label>
        <label><input type="radio" name="holdings-authorization" checked={authorization === 'persistent'} disabled={busy} onChange={() => { setAuthorization('persistent') }} />长期允许主动读取</label>
        <span>{authorization === 'persistent' ? '仍须手动点击读取，不再重复询问；不会定时或后台读取。' : '每次需要切换到同花顺前都会询问。'}</span>
      </div>}
      {permission && <div className={css.syncPermissionGuide}>
        <strong>{reason === 'automation_required' ? '补充自动化授权' : '允许读取同花顺持仓'}</strong>
        <span>{reason === 'automation_required' ? '本次读取还需要系统自动化授权，请按下面的步骤开启。' : '读取同花顺窗口中的持仓表格需要辅助功能权限；不读取交易密码、不提交买卖委托。'}</span>
        <ol>
          <li>{native ? '点击下方按钮打开系统设置' : '打开系统设置 → 隐私与安全性'} → {reason === 'automation_required' ? '自动化' : '辅助功能'}</li>
          <li>{reason === 'automation_required' ? '找到实际读取进程，允许其控制 System Events。' : '找到投研智能体，开启权限开关。'}</li>
          <li>{native ? '返回本应用，将自动检查一次权限。' : '返回浏览器，点击“重新检查”；Web 无法自动控制系统设置或恢复焦点。'}</li>
        </ol>
        <div className={css.syncActions}>
        {native && <button type="button" className={css.primaryButton} disabled={busy} onClick={() => { nativeAction(reason === 'automation_required' ? 'automation' : 'accessibility') }}>打开{reason === 'automation_required' ? '自动化' : '辅助功能'}设置</button>}
        <button type="button" className={css.secondaryButton} onClick={() => { setBlocking(''); reload() }} disabled={busy || loading}>重新检查</button>
        </div>
        <button type="button" className={css.syncHelpButton} aria-expanded={troubleshoot} onClick={() => { setTroubleshoot(value => !value) }}>没有看到本应用？</button>
        {troubleshoot && <p>实际权限属于读取进程。辅助功能列表中可点击“+”添加投研智能体；源码运行时请检查 Python 或启动终端。更换运行环境后可能需要重新授权。</p>}
      </div>}
      {reason === 'client_not_running' && native === undefined && <p className={css.syncHint}>请手动打开同花顺并登录，进入 {path}，然后返回浏览器重新检测。</p>}
      {!ready && !permission && <div className={css.syncPreparationActions}>
        {missing && <>
          <button type="button" className={css.primaryButton} disabled={busy} onClick={download}>前往官网下载 {platform === 'darwin' ? 'Mac' : 'Windows'} 版</button>
          <button type="button" className={css.secondaryButton} disabled={busy || loading} onClick={reload}>已安装，重新检测</button>
          {native !== undefined && platform === 'win32' && <button type="button" className={css.secondaryButton} disabled={busy} onClick={() => { nativeAction('select_client') }}>选择客户端位置</button>}
        </>}
        {reason === 'client_not_running' && native !== undefined && <button type="button" className={css.primaryButton} disabled={busy} onClick={() => { nativeAction('launch') }}>打开同花顺</button>}
        {!missing && <button type="button" className={css.secondaryButton} disabled={busy || loading} onClick={() => { setBlocking(''); reload() }}>重新检测</button>}
        <button type="button" className={css.secondaryButton} disabled={busy} onClick={onImport}>{missing ? '暂不安装，改用手动录入' : '改用手动录入 / 批量导入'}</button>
      </div>}
      {native === undefined && ready && <p className={css.syncHint}>Web 版不会自动切换窗口，请先在同花顺进入上述位置。</p>}
      {native !== undefined && platform === 'darwin' && ready && preview === undefined && <div className={css.syncReadinessNotice} role="note">
        <strong>请先打开同花顺左侧「交易」页</strong>
        <span>再进入 {account === 'simulated' ? '模拟' : 'A股'} → 股票 → 持仓，并保持窗口可见；页面未就绪时，应用会在确认后尝试切换。</span>
      </div>}
      {native !== undefined && platform !== 'darwin' && ready && preview === undefined && <p className={css.syncHint}>请先在券商客户端打开上述页面并保持窗口可见；页面未就绪时，应用会在确认后尝试切换。</p>}
      {native !== undefined && platform !== 'darwin' && ready && preview === undefined && ocrMissing && <div className={css.syncReadinessNotice} role="note">
        <strong>本机未找到 OCR，验证码可能需要手工输入</strong>
        <span>{text(state.captcha_ocr_hint, '读取时若券商弹出风控验证码，将无法自动识别，需要手工输入。')}</span>
      </div>}
      {preview === undefined && ready && <div className={css.syncPrimaryAction}><button type="button" className={css.primaryButton} disabled={busy || loading || provider === 'manual'} onClick={acquire}>{reading ? (cancelling ? '正在取消读取…' : '正在读取持仓…') : '我已打开，开始读取'}</button></div>}
      {reading && native !== undefined && <button type="button" className={css.secondaryButton} disabled={cancelling} onClick={cancelRead}>{cancelling ? '正在取消…' : '取消读取'}</button>}
      {preview !== undefined && <div className={css.workbenchImportPreview}>
        <div className={css.workbenchImportPreviewHeader}>
          <div><strong>{saved ? '已同步持仓' : '持仓预览 · 尚未保存'}</strong><span>{text(preview.account_label, accountLabel)} · 当前 {String(preview.previous_count)} 条 → {items.length} 条</span></div>
          <p>来源：{text(preview.label, '同花顺')} · 读取时间：{text(preview.read_at, '—')} · 预览有效期 5 分钟</p>
        </div>
        {text(asRecord(preview.details).status, '') === 'unavailable' && <div className={css.workbenchImportGuide} role="status">
          <strong>持仓已读取，成交明细未完成</strong>
          <span>{text(asRecord(preview.details).reason, '成交明细读取失败。')} 当前使用读取时间兜底，可逐只修改后再确认。</span>
        </div>}
        {text(asRecord(preview.details).status, '') === 'empty' && <div className={css.workbenchImportGuide} role="status">
          <strong>当前查询范围没有成交明细</strong>
          <span>{text(asRecord(preview.details).reason, '历史成交表没有返回记录。')} 当前使用读取时间兜底，可逐只修改后再确认。</span>
        </div>}
        {text(asRecord(preview.details).status, '') === 'available' && asRecord(preview.details).scope === 'current_query' && <div className={css.workbenchImportGuide} role="status">
          <strong>已读取当前查询范围的成交明细</strong>
          <span>成交时间来自同花顺当前历史成交查询结果；尚未证明该范围覆盖当前持仓的全部形成过程。</span>
        </div>}
        <div className={css.workbenchImportTableWrap}><table><thead><tr><th>股票代码</th><th>数量（股）</th><th>成本价（元）</th><th>时间来源</th></tr></thead><tbody>{items.map((item, index) => {
          const ticker = text(item.ticker, '')
          const trades = records(item.trades)
          const sourceLabel = text(item.time_source_label, '读取时间兜底')
          return <Fragment key={`${ticker}-${index}`}>
            <tr><td>{ticker || '—'}</td><td>{number(item.quantity)?.toLocaleString('zh-CN') ?? '—'}</td><td>{number(item.cost_price)?.toLocaleString('zh-CN') ?? '—'}</td><td>{sourceLabel}</td></tr>
            <tr className={css.holdingTradeDetail}><td colSpan={4}><details><summary>{trades.length > 0 ? `查看 ${trades.length} 笔成交明细` : '未取得成交明细'}</summary>
              {trades.length > 0
                ? <table aria-label={`${ticker} 成交明细`}><thead><tr><th>券商成交时间</th><th>方向</th><th>数量</th><th>成交价</th></tr></thead><tbody>{trades.map((trade, tradeIndex) => <tr key={`${text(trade.executed_at, '')}-${tradeIndex}`}><td>{text(trade.executed_at, '—')}</td><td>{trade.side === 'buy' ? '买入' : trade.side === 'sell' ? '卖出' : '未知'}</td><td>{number(trade.quantity)?.toLocaleString('zh-CN') ?? '—'}</td><td>{number(trade.price)?.toLocaleString('zh-CN') ?? '—'}</td></tr>)}</tbody></table>
                : <label className={css.holdingFallbackTime}><span>{sourceLabel}</span><input aria-label={`${ticker} 持仓归因时间`} type="datetime-local" value={text(item.position_time, '').slice(0, 16)} onChange={event => { updateFallbackTime(ticker, event.target.value) }} /></label>}
            </details></td></tr>
          </Fragment>
        })}</tbody></table></div>
        {saved
          ? <div className={css.workbenchImportPreviewFooter}><div><strong>同步完成</strong><p role="status">持仓已保存，组合风险已请求刷新；本次变更保留在持仓快照记录中。</p></div><div className={css.syncActions}><button type="button" className={css.primaryButton} onClick={onClose}>完成</button></div></div>
          : preview.changed === false
            ? <div className={css.workbenchImportPreviewFooter}><div><strong>持仓无变化</strong><p role="status">不会创建重复快照或变更记录。</p></div><div className={css.syncActions}><button type="button" className={css.primaryButton} onClick={() => { if (native !== undefined) nativeAction('discard'); onClose() }}>完成</button></div></div>
            : <div className={css.workbenchImportPreviewFooter}><div><strong>确认替换本地持仓</strong><p>确认后整体替换本地持仓并重新计算组合风险；空结果不会清空持仓。</p></div><div className={css.syncActions}><button type="button" className={css.primaryButton} disabled={busy} onClick={confirm}>确认替换 {items.length} 条持仓</button><button type="button" className={css.secondaryButton} disabled={busy} onClick={() => { if (native !== undefined) nativeAction('discard'); setPreview(undefined); setError('') }}>取消预览</button></div></div>}
      </div>}
    </div>
    {(error || source.state.error || config.state.error) && <div className={css.workbenchImportErrors} role="alert"><strong>当前操作未完成</strong><span>{error || source.state.error || config.state.error}</span><span>本地持仓保持不变；可重新读取或改用手动录入。</span></div>}
  </section>
}

function HoldingsEditor({
  positions, requestData, brokerSync, positionPlans, onEditRisk, initialFlow,
  onSaveHoldings, onSyncHoldings, onSavingChange, onHoldingsChanged, performance,
}: {
  performance?: PortfolioPerformanceContentProps | undefined
  onHoldingsChanged?: () => void
  initialFlow: 'view' | 'sync'
  positions: readonly WorkbenchPositionDetail[]
  requestData: RequestData
  brokerSync: boolean
  positionPlans: Map<string, Record<string, unknown>>
  onEditRisk: (item?: WorkbenchPositionDetail) => void
  onSaveHoldings: (holdings: readonly WorkbenchHoldingInput[], source: WorkbenchHoldingSaveSource) => Promise<void>
  onSyncHoldings: (token: string) => Promise<readonly WorkbenchHoldingInput[]>
  onSavingChange: (saving: boolean) => void
}) {
  const [tradeSelection, setTradeSelection] = useState<TradeSelection>()
  const [flow, setFlow] = useState<'view' | 'import' | 'sync'>('view')
  useEffect(() => { if (brokerSync && initialFlow === 'sync') setFlow('sync') }, [brokerSync, initialFlow])
  const brokerSource = useRequestResource(requestData)
  useEffect(() => {
    if (brokerSync && flow === 'view') brokerSource.run({ operation: 'trading-core.holdings-source' })
  }, [brokerSource.run, brokerSync, flow])
  const [importMode, setImportMode] = useState<'single' | 'batch'>('single')
  const [editDraft, setEditDraft] = useState<HoldingEditorDraft>()
  const editFormRef = useRef<HTMLFormElement>(null)
  const previousEditCode = useRef<string>()
  const editCode = editDraft?.originalCode
  useEffect(() => {
    if (editCode) editFormRef.current?.querySelector<HTMLInputElement>('input[aria-label="持仓数量"]')?.focus()
    else if (previousEditCode.current) editFormRef.current?.querySelector<HTMLButtonElement>(`button[data-holding-edit="${previousEditCode.current}"]`)?.focus()
    previousEditCode.current = editCode
  }, [editCode])
  const [singleDraft, setSingleDraft] = useState<HoldingEditorDraft>(EMPTY_HOLDING_DRAFT)
  const [pendingDelete, setPendingDelete] = useState('')
  const [saving, setSaving] = useState(false)
  const [viewError, setViewError] = useState('')
  const [singleError, setSingleError] = useState('')
  const [importError, setImportError] = useState('')
  const [importSource, setImportSource] = useState('')
  const [notice, setNotice] = useState('')
  const [savedSnapshot, setSavedSnapshot] = useState<readonly WorkbenchHoldingInput[]>()
  const brokerSourceValue = asRecord(brokerSource.state.value)
  const brokerBlockReason = text(brokerSourceValue.blocking_reason, '')
  const syncUnavailable = brokerSource.state.loaded
    && brokerSourceValue.available !== true
    && (brokerBlockReason === 'dependency_missing' || brokerBlockReason === 'unsupported_platform')
  const syncUnavailableMessage = syncUnavailable
    ? `券商同步暂不可用：${text(brokerSourceValue.reason, '当前环境不支持自动读取券商持仓。')} 请改用“导入持仓”。`
    : ''

  const effectivePositions = useMemo<readonly WorkbenchPositionDetail[]>(() => {
    if (savedSnapshot === undefined) return positions
    return savedSnapshot.map(item => {
      const previous = positions.find(position => position.code === item.ticker)
      return {
        code: item.ticker,
        name: previous?.name || '名称加载中',
        quantity: item.quantity,
        costPrice: item.cost_price,
        currentPrice: previous?.currentPrice,
      }
    })
  }, [positions, savedSnapshot])

  useEffect(() => {
    if (savedSnapshot === undefined) return
    const refreshed = normalizedHoldings(positions)
    if (refreshed !== undefined && sameHoldings(refreshed, savedSnapshot)) setSavedSnapshot(undefined)
  }, [positions, savedSnapshot])

  const beginTrade = (selection: TradeSelection): void => { setTradeSelection(selection); setEditDraft(undefined); setPendingDelete(''); setViewError(''); setNotice('') }
  const beginImport = (): void => {
    setPendingDelete(''); setViewError(''); setNotice(''); setImportMode('single'); setFlow('import')
  }
  const beginSync = (): void => {
    setPendingDelete(''); setViewError(''); setNotice(''); setFlow('sync')
  }
  const returnToView = (): void => { setFlow('view') }
  const applySyncedHoldings = async (token: string): Promise<readonly WorkbenchHoldingInput[]> => {
    const items = await onSyncHoldings(token)
    setSavedSnapshot(items)
    setNotice(`已同步 ${items.length} 条持仓，工作台数据正在刷新。`)
    return items
  }
  const beginEdit = (item: WorkbenchPositionDetail): void => {
    setPendingDelete(''); setViewError(''); setNotice('')
    setEditDraft({
      originalCode: item.code,
      code: item.code,
      quantity: item.quantity === undefined ? '' : String(item.quantity),
      costPrice: item.costPrice === undefined ? '' : String(item.costPrice),
    })
  }
  const saveEditDraft = async (): Promise<void> => {
    if (editDraft === undefined || editDraft.originalCode === undefined || saving) return
    const validation = holdingFromDraft(editDraft)
    if (validation.holding === undefined) { setViewError(validation.error); return }
    const holding = validation.holding
    if (effectivePositions.some(item => item.code === holding.ticker && item.code !== editDraft.originalCode)) { setViewError('持仓代码不能重复。'); return }
    const current = normalizedHoldings(effectivePositions)
    if (current === undefined) { setViewError('当前持仓存在缺失或非法字段，请刷新后重试。'); return }
    const next = current.map(item => item.ticker === editDraft.originalCode ? holding : item)
    setSaving(true); onSavingChange(true); setViewError(''); setNotice('')
    try {
      await onSaveHoldings(next, 'manual')
      setSavedSnapshot(next)
      setEditDraft(undefined)
      setNotice('持仓已保存，工作台数据正在刷新。')
    } catch (reason) {
      setViewError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setSaving(false); onSavingChange(false)
    }
  }
  const saveSingleDraft = async (): Promise<void> => {
    if (saving) return
    const validation = holdingFromDraft(singleDraft)
    if (validation.holding === undefined) { setSingleError(validation.error); return }
    const holding = validation.holding
    if (effectivePositions.some(item => item.code === holding.ticker)) { setSingleError('持仓代码不能重复。'); return }
    const current = normalizedHoldings(effectivePositions)
    if (current === undefined) { setSingleError('当前持仓存在缺失或非法字段，请刷新后重试。'); return }
    setSaving(true); onSavingChange(true); setSingleError(''); setNotice('')
    try {
      const next = [...current, holding]
      await onSaveHoldings(next, 'manual')
      setSavedSnapshot(next)
      setSingleDraft(EMPTY_HOLDING_DRAFT)
      returnToView()
      setNotice('持仓已保存，工作台数据正在刷新。')
    } catch (reason) {
      setSingleError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setSaving(false); onSavingChange(false)
    }
  }
  const confirmDelete = async (code: string): Promise<void> => {
    if (saving) return
    const current = normalizedHoldings(effectivePositions)
    if (current === undefined) { setViewError('当前持仓存在缺失或非法字段，请刷新后重试。'); return }
    setSaving(true); onSavingChange(true); setViewError(''); setNotice('')
    try {
      const next = current.filter(item => item.ticker !== code)
      await onSaveHoldings(next, 'manual')
      setSavedSnapshot(next)
      setPendingDelete('')
      setEditDraft(currentDraft => currentDraft?.originalCode === code ? undefined : currentDraft)
      setNotice('持仓已删除，工作台数据正在刷新。')
    } catch (reason) {
      setViewError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setSaving(false); onSavingChange(false)
    }
  }
  const saveImport = async (holdings: readonly WorkbenchHoldingInput[]): Promise<void> => {
    if (saving || holdings.length === 0) return
    setSaving(true); onSavingChange(true); setImportError(''); setNotice('')
    try {
      await onSaveHoldings(holdings, 'bulk_import')
      setSavedSnapshot(holdings)
      setImportSource('')
      returnToView()
      setNotice(`已批量导入 ${holdings.length} 条持仓，工作台数据正在刷新。`)
    } catch (reason) {
      setImportError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setSaving(false); onSavingChange(false)
    }
  }

  return (
    <>
      {notice !== '' && <div className={css.workbenchHoldingNotice} role="status">{notice}</div>}
      <HoldingsSummary positions={effectivePositions} />
      {performance !== undefined && <PortfolioPerformanceContent {...performance} />}
        <section className={css.holdingsPositionSection} aria-label="已保存持仓">
          <div className={css.workbenchHoldingToolbar}>
            <div><strong>持仓标的</strong><span>{effectivePositions.length} 项</span></div>
            <div className={css.workbenchHoldingToolbarActions}>
              <Button className={css.holdingButton} variant="outline" disabled={saving || editDraft !== undefined || pendingDelete !== ''} onClick={() => { beginTrade({ side: 'buy', ticker: '' }) }}>记录买入</Button>
              <Button className={css.holdingButton} variant="outline" disabled={saving || editDraft !== undefined || pendingDelete !== ''} onClick={() => { beginTrade({ side: 'history', ticker: '' }) }}>全部成交记录</Button>
              {brokerSync && (
                <span
                  className={css.workbenchSyncEntry}
                  data-sync-unavailable={syncUnavailable || undefined}
                  {...(syncUnavailable ? { tabIndex: 0, 'aria-label': syncUnavailableMessage } : {})}
                >
                  <Button
                    className={css.holdingButton} variant="outline"
                    disabled={saving || editDraft !== undefined || pendingDelete !== '' || syncUnavailable}
                    onClick={beginSync}
                  >从券商同步持仓</Button>
                  {syncUnavailable && <span className={css.workbenchSyncTooltip} role="tooltip">{syncUnavailableMessage}</span>}
                </span>
              )}
              <Button
                className={css.holdingButton} variant="outline"
                disabled={saving || editDraft !== undefined || pendingDelete !== ''}
                onClick={() => { onEditRisk() }}
              >全局止盈止损</Button>
              <Button className={`${css.holdingButton} ${css.holdingPrimary}`} variant="primary" disabled={saving || editDraft !== undefined || pendingDelete !== ''} onClick={beginImport}>导入持仓</Button>
            </div>
          </div>
          {viewError !== '' && <div className={css.inlineError} role="alert">{viewError}</div>}
          <form ref={editFormRef} aria-label="持仓行内编辑" onSubmit={event => { event.preventDefault(); void saveEditDraft() }}>
          <PositionTable
            positions={effectivePositions}
            positionPlans={positionPlans}
            onEditRisk={onEditRisk}
            saving={saving}
            pendingDelete={pendingDelete}
            editDraft={editDraft}
            onChangeDraft={draft => { setEditDraft(draft); setViewError('') }}
            onCancelEdit={() => { setEditDraft(undefined); setViewError('') }}
            onEdit={beginEdit}
            onTrade={beginTrade}
            onRequestDelete={(code) => { setEditDraft(undefined); setViewError(''); setNotice(''); setPendingDelete(code) }}
            onConfirmDelete={(code) => { void confirmDelete(code) }}
            onCancelDelete={() => { setPendingDelete('') }}
          />
          </form>
        </section>
      {performance !== undefined && <PortfolioPerformanceNotes {...performance} />}
      {flow !== 'view' && (
        <HoldingsActionDialog
          title={flow === 'sync' ? '同步同花顺持仓' : '导入持仓'}
          description={flow === 'sync' ? '选择账户并获取持仓；核对预览后确认导入。' : '选择单条录入或批量导入，核对后保存研究持仓。'}
          wide onClose={returnToView} busy={saving}
        >
        {flow === 'sync' ? <HoldingsSyncPanel
          requestData={requestData}
          onSync={applySyncedHoldings}
          onNativeSync={(items) => {
            setSavedSnapshot(items)
            setNotice(`已同步 ${items.length} 条持仓，工作台数据正在刷新。`)
          }}
          onImport={beginImport}
          onClose={returnToView}
          onSavingChange={(value) => { setSaving(value); onSavingChange(value) }}
        /> : <section aria-label="导入持仓">
          <div className={css.workbenchHoldingModeTabs} role="tablist" aria-label="持仓导入方式">
            <button id="holdings-single-tab" type="button" role="tab" aria-selected={importMode === 'single'} disabled={saving} onClick={() => { setImportMode('single') }}>单条录入</button>
            <button id="holdings-batch-tab" type="button" role="tab" aria-selected={importMode === 'batch'} disabled={saving} onClick={() => { setImportMode('batch') }}>批量导入</button>
          </div>
          {importMode === 'single' ? (
            <section className={css.workbenchSingleImport} role="tabpanel" aria-labelledby="holdings-single-tab">
              <div className={css.workbenchImportGuide}>
                <strong>单条录入会追加一条新持仓</strong>
                <span>适合临时补录一个标的；已存在的股票代码不会重复添加。</span>
              </div>
              {singleError !== '' && <div className={css.inlineError} role="alert">{singleError}</div>}
              <form className={css.workbenchHoldingForm} aria-label="单条持仓录入表单" onSubmit={(event) => { event.preventDefault(); void saveSingleDraft() }}>
                <label><span>股票代码</span><input className={css.fieldInput} type="text" inputMode="numeric" maxLength={6} disabled={saving} value={singleDraft.code} onChange={(event) => { setSingleDraft({ ...singleDraft, code: event.target.value }); setSingleError('') }} /></label>
                <label><span>持仓数量</span><input className={css.fieldInput} type="number" min="0" step="any" disabled={saving} value={singleDraft.quantity} onChange={(event) => { setSingleDraft({ ...singleDraft, quantity: event.target.value }); setSingleError('') }} /></label>
                <label><span>成本价</span><input className={css.fieldInput} type="number" min="0" step="any" disabled={saving} value={singleDraft.costPrice} onChange={(event) => { setSingleDraft({ ...singleDraft, costPrice: event.target.value }); setSingleError('') }} /></label>
                <div>
                  <button type="button" className={css.secondaryButton} disabled={saving} onClick={() => { setSingleDraft(EMPTY_HOLDING_DRAFT); setSingleError('') }}>清空</button>
                  <button type="submit" className={css.primaryButton} disabled={saving}>{saving ? '正在保存…' : '保存单条持仓'}</button>
                </div>
              </form>
            </section>
          ) : (
            <HoldingsBulkImport
              currentCount={effectivePositions.length}
              source={importSource}
              saving={saving}
              error={importError}
              onSourceChange={(value) => { setImportSource(value); setImportError(''); setNotice('') }}
              onError={setImportError}
              onSave={saveImport}
            />
          )}
        </section>}
        </HoldingsActionDialog>
      )}
      {tradeSelection && <ManualTradePanel selection={tradeSelection} requestData={requestData}
        onRecordBuy={() => { setTradeSelection({ ...tradeSelection, side: 'buy' }) }}
        onClose={() => { setTradeSelection(undefined) }}
        onBusy={(value) => { setSaving(value); onSavingChange(value) }}
        onSaved={(items, message) => { setSavedSnapshot(items); setTradeSelection(undefined); setNotice(message || '成交已保存，研究持仓已更新。'); onHoldingsChanged?.() }} />}
    </>
  )
}

function HoldingsSummary({ positions }: { positions: readonly WorkbenchPositionDetail[] }) {
  const { hidden: fundsHidden } = useFundsPrivacy()
  const total = summedAmount(positions, item => item.costPrice)
  const current = summedAmount(positions, item => item.currentPrice)
  const profit = total === undefined || current === undefined ? undefined : current - total
  const profitRatio = profit !== undefined && total !== undefined && total > 0 ? profit / total : undefined
  return (
    <>
      <dl className={css.workbenchOverviewMetricGrid} aria-label="当前持仓汇总">
        <div><dt>持仓标的</dt><dd>{positions.length} 项</dd></div>
        <div><dt>成本金额合计</dt><dd>{privateFunds(total === undefined ? '—' : compactMoney(total), fundsHidden)}</dd></div>
        <div><dt>当前持仓市值</dt><dd>{privateFunds(current === undefined ? '—' : compactMoney(current), fundsHidden)}</dd></div>
        <div><dt>当前持仓盈亏</dt><dd data-tone={tone(profit)}><span>{privateFunds(profit === undefined ? '—' : `${profit > 0 ? '+' : profit < 0 ? '-' : ''}${compactMoney(Math.abs(profit))}`, fundsHidden)}</span><small className={css.holdingsProfitRatio} aria-label="当前持仓成本收益率">{signedPercent(profitRatio)}</small></dd></div>
      </dl>
      {positions.some(item => item.quantity === undefined || item.costPrice === undefined) && (
        <p className={css.workbenchOverviewFootnote}>部分持仓缺少数量或成本价，因此合计显示为“—”；缺失值不按零计算。</p>
      )}
    </>
  )
}

function severityLabel(value: unknown): string {
  const severity = text(value, '未分级')
  return severity === '' ? '未分级' : `${severity}风险`
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.flatMap(item => typeof item === 'string' && item.trim() !== '' ? [item.trim()] : [])
    : []
}

function resourceMessage(state: WorkbenchResourceStatus, title: string): JSX.Element {
  if (state.error !== '') {
    return <div className={css.workbenchOverviewUnavailable} role="alert"><strong>{title}暂不可用</strong><p>{state.error}</p></div>
  }
  return <div className={css.workbenchOverviewEmpty} role="status">{state.busy ? `正在加载${title}…` : `${title}尚未加载。`}</div>
}

function retainedResourceWarning(state: WorkbenchResourceStatus, title: string): JSX.Element | undefined {
  return state.loaded && state.error !== ''
    ? <div className={css.dashboardDegraded} role="status">{title}更新失败，当前展示最近一次成功数据：{state.error}</div>
    : undefined
}

function riskMetric(value: unknown, indicator: string): string {
  const parsed = number(value)
  if (parsed === undefined) return '—'
  if (indicator === 'single_stock_weight' || indicator === 'portfolio_vol') return `${(parsed * 100).toFixed(1)}%`
  return parsed.toFixed(3)
}

function RiskBreaches({ breaches }: { breaches: readonly Record<string, unknown>[] }) {
  if (breaches.length === 0) return <div className={css.workbenchOverviewGood}>当前没有返回预算突破。</div>
  return <ul className={css.workbenchRiskList}>{breaches.map((item, index) => {
    const indicator = text(item.indicator, '')
    return (
      <li key={`${indicator || 'risk'}-${index}`}>
        <span data-severity={text(item.severity, '')}>{severityLabel(item.severity)}</span>
        <div>
          <strong>{text(item.label, indicator || '风险指标')}</strong>
          <p>{text(item.detail, '该指标已触发组合预算检查。')}</p>
          <div className={css.workbenchRiskFacts}>
            <span>当前值 {riskMetric(item.value, indicator)}</span>
            <span>预算上限 {riskMetric(item.limit, indicator)}</span>
            {number(item.excess) !== undefined && <span>预算倍数 {(number(item.excess) ?? 0).toFixed(2)}×</span>}
          </div>
        </div>
      </li>
    )
  })}</ul>
}

function RiskBudgetMetrics({ risk }: { risk: Record<string, unknown> }) {
  const budget = asRecord(risk.risk_budget)
  const percentage = (value: unknown): string => {
    const parsed = number(value)
    return parsed === undefined ? '—' : `${(parsed * 100).toFixed(1)}%`
  }
  return (
    <dl className={css.workbenchOverviewMetricGrid} aria-label="完整风险预算">
      <div><dt>单股预算上限</dt><dd>{percentage(budget.single_stock_weight_max)}</dd></div>
      <div><dt>HHI 预算上限</dt><dd>{number(budget.hhi_max)?.toFixed(3) ?? '—'}</dd></div>
      <div><dt>组合波动预算上限</dt><dd>{percentage(budget.portfolio_vol_max)}</dd></div>
      <div><dt>Beta 预算上限</dt><dd>{number(budget.beta_max)?.toFixed(2) ?? '—'}</dd></div>
    </dl>
  )
}

function RiskProfileDetail({ risk, riskAsOf }: { risk: Record<string, unknown>; riskAsOf: string | undefined }) {
  const summary = asRecord(risk.summary)
  const breaches = records(risk.breaches)
  const equalWeight = number(summary.equal_weight)
  return (
    <>
      <dl className={css.workbenchOverviewMetricGrid}>
        <div><dt>风险画像</dt><dd>{text(risk.profile_label, '待完善')}</dd></div>
        <div><dt>持仓标的</dt><dd>{number(summary.n_positions)?.toFixed(0) ?? '—'} 项</dd></div>
        <div><dt>单股等权占比</dt><dd>{equalWeight === undefined ? '—' : `${(equalWeight * 100).toFixed(1)}%`}</dd></div>
        <div><dt>集中度 HHI</dt><dd>{number(summary.hhi)?.toFixed(3) ?? '—'}</dd></div>
      </dl>
      <section className={css.workbenchOverviewSection}>
        <div className={css.workbenchOverviewSectionHead}><h3>风险预算</h3><span>{text(risk.profile_label, '待完善')}</span></div>
        <RiskBudgetMetrics risk={risk} />
      </section>
      <section className={css.workbenchOverviewSection}>
        <div className={css.workbenchOverviewSectionHead}>
          <h3>预算检查</h3><span>{breaches.length} 项突破</span>
        </div>
        <RiskBreaches breaches={breaches} />
      </section>
      <p className={css.workbenchOverviewFootnote}>风险数据时间：{riskAsOf || '时间未知'}。画像用于投研复核，不构成交易指令。</p>
    </>
  )
}

function RiskCenterDetail({
  risk, alerts, riskAsOf, alertsAsOf, alertsDegraded, alertsDegradedReason, riskState, alertsState, onOpenAlert,
}: Omit<WorkbenchOverviewDialogProps, 'kind' | 'positions' | 'onClose' | 'onSaveHoldings' | 'onSyncHoldings' | 'requestData' | 'brokerSync' | 'holdingsProviders'>) {
  const summary = asRecord(risk.summary)
  const breaches = records(risk.breaches)
  const equalWeight = number(summary.equal_weight)
  const suggestions = [...new Set(alerts.flatMap(riskSuggestions))]
  return (
    <>
      {alertsDegraded === true && (
        <div className={css.dashboardDegraded} role="status">
          {alertsDegradedReason || '部分关联数据暂未更新；当前仍展示已成功返回的组合或画像事实。'}
        </div>
      )}
      {riskState.loaded ? <>
        {retainedResourceWarning(riskState, '组合风险')}
        <section className={css.workbenchOverviewSection}>
          <div className={css.workbenchOverviewSectionHead}><h3>风险预算</h3><span>{text(risk.profile_label, '待完善')}</span></div>
          <RiskBudgetMetrics risk={risk} />
          <dl className={css.workbenchOverviewMetricGrid}>
            <div><dt>持仓标的</dt><dd>{number(summary.n_positions)?.toFixed(0) ?? '—'} 项</dd></div>
            <div><dt>单股等权占比</dt><dd>{equalWeight === undefined ? '—' : `${(equalWeight * 100).toFixed(1)}%`}</dd></div>
            <div><dt>集中度 HHI</dt><dd>{number(summary.hhi)?.toFixed(3) ?? '—'}</dd></div>
          </dl>
        </section>
        <section className={css.workbenchOverviewSection}>
          <div className={css.workbenchOverviewSectionHead}><h3>预算突破</h3><span>{breaches.length} 项</span></div>
          <RiskBreaches breaches={breaches} />
        </section>
      </> : <section className={css.workbenchOverviewSection}>{resourceMessage(riskState, '组合风险')}</section>}
      <section className={css.workbenchOverviewSection}>
        <div className={css.workbenchOverviewSectionHead}><h3>全部预警</h3><span>{alertsState.loaded ? `${alerts.length} 条` : '—'}</span></div>
        {!alertsState.loaded
          ? resourceMessage(alertsState, '风险预警')
          : alerts.length === 0
          ? <div className={css.workbenchOverviewGood}>当前没有风险预警。</div>
          : <ul className={css.workbenchRiskList}>{alerts.map((item, index) => (
            <li key={text(item.id, `${text(item.title, 'alert')}-${index}`)}>
              <span data-severity={text(item.severity, '')}>{severityLabel(item.severity)}</span>
              <div>
                <strong>{text(item.title, '风险提醒')}</strong>
                <p>{text(item.detail, '后端未返回进一步说明。')}</p>
                <div className={css.workbenchRiskFacts}>
                  <span>{riskSource(text(item.source, '')).label}</span>
                  {strings(item.codes).map(code => <span key={code}>{code}</span>)}
                  {text(item.strategy_id, '') !== '' && <span>策略 {text(item.strategy_id)}</span>}
                </div>
                <small>{text(item.ts, '时间未知')}</small>
              </div>
              <button type="button" className={css.workbenchRiskDetailButton} aria-haspopup="dialog" onClick={() => { onOpenAlert(item) }}>查看详情</button>
            </li>
          ))}</ul>}
      </section>
      {alertsState.loaded && retainedResourceWarning(alertsState, '风险预警')}
      <section className={css.workbenchOverviewSection}>
        <div className={css.workbenchOverviewSectionHead}><h3>研究建议</h3><span>仅供复核</span></div>
        <ul className={css.detailList}>
          {(suggestions.length > 0
            ? suggestions
            : [alertsState.loaded ? '当前没有需要优先处理的预警，继续关注持仓、行情与风险预算变化。' : '待风险预警数据恢复后，再核对关联标的、策略与风险预算。'])
            .map(suggestion => <li key={suggestion}>{suggestion}</li>)}
        </ul>
      </section>
      <p className={css.workbenchOverviewFootnote}>风险预算更新于 {riskAsOf || '时间未知'}；预警更新于 {alertsAsOf || '时间未知'}。</p>
    </>
  )
}

export function WorkbenchOverviewDialog({
  kind, positions, risk, alerts, riskAsOf, alertsAsOf, alertsDegraded, alertsDegradedReason,
  holdingsState, riskState, alertsState, onOpenAlert, onSaveHoldings, onSyncHoldings, requestData,
  brokerSync = true, initialHoldingsFlow = 'view', onClose, onHoldingsChanged,
  performance,
}: WorkbenchOverviewDialogProps) {
  const copy = DIALOG_COPY[kind]
  const [holdingSaving, setHoldingSaving] = useState(false)
  const [positionRiskEditor, setPositionRiskEditor] = useState<WorkbenchPositionDetail | null>()
  const positionRisk = useRequestResource(requestData)
  useEffect(() => {
    if (kind === 'holdings') positionRisk.run({ operation: 'trading-core.position-risk' })
  }, [kind, positionRisk.run])
  const positionPlans = positionRiskPlanMap(positionRisk.state.value)
  const close = (): void => { if (!holdingSaving) onClose() }
  let dialogContent: ReactNode
  if (kind === 'holdings') {
    if (!holdingsState.loaded) {
      dialogContent = resourceMessage(holdingsState, '持仓详情')
    } else {
      dialogContent = <>
        {retainedResourceWarning(holdingsState, '持仓')}
        {initialHoldingsFlow === 'sync' && !brokerSync && <p role="status">当前环境不支持券商同步。请在支持的桌面环境同步，或使用下方“导入持仓”。</p>}
        <HoldingsEditor
          performance={performance}
          initialFlow={initialHoldingsFlow}
          positions={positions}
          requestData={requestData}
          brokerSync={brokerSync}
          positionPlans={positionPlans}
          onEditRisk={(item) => { setPositionRiskEditor(item ?? null) }}
          onSaveHoldings={onSaveHoldings}
          onSyncHoldings={onSyncHoldings}
          onHoldingsChanged={() => { onHoldingsChanged?.(); positionRisk.run({ operation: 'trading-core.position-risk' }) }}
          onSavingChange={setHoldingSaving}
        />
      </>
    }
  } else if (kind === 'risk-profile') {
    dialogContent = riskState.loaded
      ? <>{retainedResourceWarning(riskState, '组合风险')}<RiskProfileDetail risk={risk} riskAsOf={riskAsOf} /></>
      : resourceMessage(riskState, '风险画像')
  } else {
    dialogContent = <RiskCenterDetail
      risk={risk}
      alerts={alerts}
      riskAsOf={riskAsOf}
      alertsAsOf={alertsAsOf}
      alertsDegraded={alertsDegraded}
      alertsDegradedReason={alertsDegradedReason}
      holdingsState={holdingsState}
      riskState={riskState}
      alertsState={alertsState}
      onOpenAlert={onOpenAlert}
    />
  }
  return (
    <>
      <DetailDialog
        title={copy.title}
        description={copy.description}
        eyebrow="投研概览"
        wide
        onClose={close}
        closeDisabled={holdingSaving}
        actions={<Button variant="primary" className={`${css.holdingButton} ${css.holdingCloseButton}`} disabled={holdingSaving} onClick={close}>关闭</Button>}
      >
        {dialogContent}
      </DetailDialog>
      {positionRiskEditor !== undefined && (
        <PositionRiskDialog
          requestData={requestData}
          ticker={positionRiskEditor?.code}
          name={positionRiskEditor?.name}
          onClose={() => { setPositionRiskEditor(undefined) }}
          onChanged={() => { positionRisk.run({ operation: 'trading-core.position-risk' }) }}
        />
      )}
    </>
  )
}
