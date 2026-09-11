import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { InvestmentDataRequest } from '@deepseek-ai/dsh-client-investment-research-runtime/client'
import { asRecord, compactMoney, money, number, productErrorText, records, text } from './data.ts'
import { DetailDialog, riskSource, riskSuggestions } from './DetailDialogs.tsx'
import { parseHoldingsImport } from './holdings-import.ts'
import { useRequestResource } from './InvestmentShell.tsx'
import css from './InvestmentShell.module.css'

type RequestData = (request: InvestmentDataRequest) => Promise<unknown>

interface HoldingsProviderOption {
  readonly value: string
  readonly label: string
}

const HOLDINGS_PROVIDER_OPTIONS: readonly HoldingsProviderOption[] = [
  { value: 'manual', label: '手动输入' },
  { value: 'easytrader', label: '同花顺（Windows）' },
  { value: 'mac_ths', label: '同花顺（macOS）' },
  { value: 'qmt', label: 'QMT 迅投' },
]

function holdingsProviderOptions(current: string, allowed: readonly string[]): readonly HoldingsProviderOption[] {
  const options = HOLDINGS_PROVIDER_OPTIONS.filter(option => option.value === current || allowed.includes(option.value))
  return HOLDINGS_PROVIDER_OPTIONS.some(option => option.value === current)
    ? options
    : [{ value: current, label: '未知数据源' }, ...options]
}

export type WorkbenchDetailKind =
  | 'holdings'
  | 'cost'
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
  readonly holdingsProviders?: readonly string[]
  readonly onClose: () => void
}

export interface WorkbenchResourceStatus {
  readonly loaded: boolean
  readonly busy: boolean
  readonly error: string
}

const DIALOG_COPY: Readonly<Record<WorkbenchDetailKind, { title: string; description: string }>> = Object.freeze({
  holdings: { title: '持仓明细', description: '在当前工作台查看并维护研究持仓，保存后联动刷新风险与行情。' },
  cost: { title: '持仓成本明细', description: '按持仓数量 × 成本价汇总，不代表当前市场价值。' },
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
  positions, kind, saving, pendingDelete, onEdit, onRequestDelete, onConfirmDelete, onCancelDelete,
}: {
  positions: readonly WorkbenchPositionDetail[]
  kind: 'holdings' | 'cost'
  saving?: boolean
  pendingDelete?: string
  onEdit?: (item: WorkbenchPositionDetail) => void
  onRequestDelete?: (code: string) => void
  onConfirmDelete?: (code: string) => void
  onCancelDelete?: () => void
}) {
  if (positions.length === 0) {
    return <div className={css.workbenchOverviewEmpty}>尚未保存持仓，当前没有可展示的明细。</div>
  }
  return (
    <div className={css.workbenchOverviewTableWrap}>
      <table className={css.workbenchOverviewTable}>
        <thead>
          <tr>
            <th scope="col">标的</th>
            <th scope="col">持仓数量</th>
            <th scope="col">成本价</th>
            {kind === 'cost' && <th scope="col">成本金额</th>}
            {kind === 'holdings' && onEdit !== undefined && <th scope="col">操作</th>}
          </tr>
        </thead>
        <tbody>
          {positions.map((item, index) => {
            const price = item.costPrice
            return (
              <tr key={`${item.code}-${index}`}>
                <th scope="row"><strong>{item.name}</strong><small>{item.code}</small></th>
                <td><span className={css.workbenchMobileLabel}>持仓数量</span>{quantity(item.quantity)}</td>
                <td><span className={css.workbenchMobileLabel}>成本价</span>{amount(item.costPrice)}</td>
                {kind === 'cost' && <td><span className={css.workbenchMobileLabel}>成本金额</span>{amount(positionAmount(item, price))}</td>}
                {kind === 'holdings' && onEdit !== undefined && (
                  <td className={css.workbenchHoldingActions}>
                    <span className={css.workbenchMobileLabel}>操作</span>
                    {pendingDelete === item.code ? (
                      <div className={css.workbenchDeleteConfirm}>
                        <span>确认删除该持仓？</span>
                        <button type="button" disabled={saving} aria-label={`确认删除 ${item.code}`} onClick={() => { onConfirmDelete?.(item.code) }}>确认删除</button>
                        <button type="button" disabled={saving} aria-label={`取消删除 ${item.code}`} onClick={onCancelDelete}>取消</button>
                      </div>
                    ) : (
                      <div>
                        <button type="button" disabled={saving} aria-label={`编辑 ${item.name} ${item.code}`} onClick={() => { onEdit(item) }}>编辑</button>
                        <button type="button" disabled={saving} aria-label={`删除 ${item.name} ${item.code}`} onClick={() => { onRequestDelete?.(item.code) }}>删除</button>
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
    if (!/\.(csv|tsv|txt)$/i.test(file.name)) {
      onError('仅支持 CSV、TSV 或 TXT 文件。')
      return
    }
    try {
      const content = await file.text()
      onSourceChange(content)
    } catch {
      onError('文件读取失败，请重试或直接粘贴表格内容。')
    }
  }

  return (
    <section className={css.workbenchImportPanel} role="tabpanel" aria-labelledby="holdings-batch-tab">
      <div className={css.workbenchImportGuide}>
        <strong>批量导入会整体替换当前持仓</strong>
        <span>支持 CSV、TSV 和从 Excel / WPS 复制的表格，至少需要股票代码、数量、成本价三列。</span>
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
        <span>或点击选择 CSV / TSV / TXT 文件</span>
        <input
          ref={fileInputRef}
          type="file"
          aria-label="选择持仓文件"
          accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain"
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
        <textarea
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
function HoldingsSyncPanel({ requestData, holdingsProviders, onSync, onBack, onSavingChange }: {
  requestData: RequestData
  holdingsProviders: readonly string[]
  onSync: (token: string) => Promise<readonly WorkbenchHoldingInput[]>
  onBack: () => void
  onSavingChange: (saving: boolean) => void
}) {
  const boundedRequest = useCallback((request: InvestmentDataRequest): Promise<unknown> => new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => { reject(new Error('检测暂未完成，请重新检测，或先手动录入持仓。')) }, 12_000)
    Promise.resolve().then(() => requestData(request)).then(resolve, reject).finally(() => { window.clearTimeout(timer) })
  }), [requestData])
  const source = useRequestResource(boundedRequest)
  const config = useRequestResource(boundedRequest)
  const [slow, setSlow] = useState(false)
  const backButtonRef = useRef<HTMLButtonElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [blocking, setBlocking] = useState('')
  const [preview, setPreview] = useState<Record<string, unknown>>()
  const [saved, setSaved] = useState(false)
  const [troubleshoot, setTroubleshoot] = useState(false)
  const recheckOnFocus = useRef(false)
  const alive = useRef(true)
  const native = (window as unknown as { __DSH_ELECTRON__?: {
    holdingsAction?: (input: { action: string; account_mode: string }) => Promise<unknown>
  } }).__DSH_ELECTRON__?.holdingsAction
  const reload = useCallback((): void => {
    source.run({ operation: 'trading-core.holdings-source' })
    config.run({ operation: 'trading-core.holdings-user-config' })
  }, [source.run, config.run])
  useEffect(() => { reload(); backButtonRef.current?.focus() }, [reload])
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
    setSlow(false)
    if (!loading) return
    const timer = window.setTimeout(() => { setSlow(true) }, 3_000)
    return () => { window.clearTimeout(timer) }
  }, [loading])
  const permission = reason === 'accessibility_required' || reason === 'automation_required'
  const missing = reason === 'client_missing' || reason === 'client_location_required'
  const navigation = reason === 'navigation_required'
  const options = holdingsProviderOptions(provider, holdingsProviders)
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
    if (typeof result.preview_token === 'string' && records(result.items).length > 0) {
      setPreview(result); setBlocking(''); setSaved(false)
    } else {
      setBlocking(text(result.blocking_reason, 'read_failed'))
      setError(text(result.reason, '读取未完成，当前持仓保持不变。'))
    }
  }
  const read = (): void => { void run(async () => { acceptPreview(await requestData({ operation: 'trading-core.holdings-sync', input: { action: 'preview' } })) }) }
  const nativeAction = (action: string): void => {
    if (native === undefined) return
    void run(async () => {
      if (action !== 'read') recheckOnFocus.current = true
      const value = await native({ action, account_mode: account })
      if (action === 'read') acceptPreview(value)
      else {
        const result = asRecord(value)
        if (result.blocking_reason) { setBlocking(text(result.blocking_reason, '')); setError(text(result.reason, '操作未完成。')) }
        reload()
      }
    })
  }
  const download = (): void => {
    recheckOnFocus.current = true
    if (native !== undefined) nativeAction('download')
    else window.open(platform === 'darwin' ? 'https://download.10jqka.com.cn/free/mac/' : 'https://download.10jqka.com.cn/free/', '_blank', 'noopener,noreferrer')
  }
  const confirm = (): void => {
    if (preview === undefined) return
    void run(async () => {
      await onSync(text(preview.preview_token, ''))
      setSaved(true)
    })
  }
  const items = records(preview?.items)
  return <section className={css.workbenchSyncPanel} aria-label="从券商同步持仓">
    <div className={css.workbenchImportHeader}>
      <div><span>账户选择 → 客户端准备 → 预览确认</span></div>
      <button ref={backButtonRef} type="button" className={css.secondaryButton} disabled={busy} onClick={onBack}>返回持仓明细</button>
    </div>
    <div className={css.workbenchAccountMode}>
      <div><strong>1 · 操盘账户</strong><span>选择要同步的账户，设置会自动记住</span></div>
      <div className={css.workbenchAccountModeChoices} role="group" aria-label="操盘账户">
        {(['simulated', 'real'] as const).map(mode => <button key={mode} type="button" aria-pressed={account === mode} disabled={busy || loading} onClick={() => { change({ HOLDINGS_ACCOUNT_MODE: mode }) }}>{mode === 'simulated' ? '模拟操盘' : '真实操盘'}</button>)}
      </div>
    </div>
    <div className={css.workbenchSyncPreparation}>
      <strong>2 · 同花顺准备状态</strong>
      <label className={css.sourceSelect}><span>持仓数据源</span><select aria-label="持仓数据源" value={provider} disabled={busy || loading} onChange={event => { change({ HOLDINGS_PROVIDER: event.target.value }) }}>
        {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select></label>
      <p role="status">{loading ? (slow ? '检测耗时较长，最多等待 12 秒。你也可以先手动录入。' : '正在检测客户端与权限，请稍候…') : state.available === true ? '已具备读取条件；读取时仍需确认账户与登录状态。' : text(state.reason, '请选择数据源并检查客户端。')}</p>
      <div className={css.syncStatusList} aria-label="检测结果">
        <span>客户端 <strong>{state.installation === 'installed' ? '已安装' : state.installation === 'missing' ? '未安装' : '待确认'}</strong></span>
        <span>运行状态 <strong>{state.process === 'running' ? '运行中' : state.process === 'not_running' ? '未启动' : '待确认'}</strong></span>
        <span>读取权限 <strong>{state.accessibility === 'granted' ? '已授权' : permission ? '待授权' : '待确认'}</strong></span>
      </div>
      {missing && <>
        <button type="button" className={css.primaryButton} disabled={busy} onClick={download}>前往官网下载 {platform === 'darwin' ? 'Mac' : 'Windows'} 版</button>
        <button type="button" className={css.secondaryButton} disabled={busy || loading} onClick={reload}>已安装，重新检测</button>
        {native !== undefined && platform === 'win32' && <button type="button" className={css.secondaryButton} disabled={busy} onClick={() => { nativeAction('select_client') }}>选择客户端位置</button>}
      </>}
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
      {reason === 'client_not_running' && (native
        ? <button type="button" className={css.primaryButton} disabled={busy} onClick={() => { nativeAction('launch') }}>打开同花顺</button>
        : <p>请手动打开同花顺并登录，进入 {path}，然后返回浏览器重新检测。</p>)}
      {!permission && !missing && <button type="button" className={css.secondaryButton} disabled={busy || loading} onClick={() => { setBlocking(''); reload() }}>重新检测</button>}
      <button type="button" className={css.secondaryButton} disabled={busy} onClick={onBack}>{missing ? '暂不安装，改用手动录入' : '改用手动录入 / 批量导入'}</button>
    </div>
    <div className={css.workbenchSyncPreparation}>
      <strong>3 · 读取、预览与确认</strong>
      <p>{path}</p>
      {state.available !== true && !navigation && <p className={css.syncHint}>完成上方准备后即可读取；确认预览前不会修改本地持仓。</p>}
      {native === undefined && <p>Web 版请在同花顺手动进入上述路径，完成后返回读取。浏览器不会自动切换同花顺或保证恢复焦点。</p>}
      {navigation && native !== undefined && <div className={css.workbenchImportGuide}><strong>后台读取未完成</strong><span>继续时会先弹窗说明访问路径、窗口切换和返回行为，取得本次同意后再操作。</span><button type="button" className={css.primaryButton} disabled={busy} onClick={() => { nativeAction('read') }}>查看本次切换说明</button></div>}
      {preview === undefined && !(navigation && native) && <button type="button" className={css.primaryButton} disabled={busy || loading || provider === 'manual' || (state.available !== true && !navigation)} onClick={read}>{busy ? '正在读取持仓…' : native ? '读取持仓预览' : '我已打开持仓页，开始读取'}</button>}
      {preview !== undefined && <div className={css.workbenchImportPreview}>
        <div><strong>{saved ? '已同步持仓' : '持仓预览 · 尚未保存'}</strong><span>{text(preview.account_label, accountLabel)} · 当前 {String(preview.previous_count)} 条 → {items.length} 条</span></div>
        <p>来源：{text(preview.label, '同花顺')} · 读取时间：{text(preview.read_at, '—')} · 预览有效期 5 分钟</p>
        <div className={css.workbenchImportTableWrap}><table><thead><tr><th>股票代码</th><th>数量（股）</th><th>成本价（元）</th></tr></thead><tbody>{items.map((item, index) => <tr key={`${text(item.ticker, '')}-${index}`}><td>{text(item.ticker, '—')}</td><td>{number(item.quantity)?.toLocaleString('zh-CN') ?? '—'}</td><td>{number(item.cost_price)?.toLocaleString('zh-CN') ?? '—'}</td></tr>)}</tbody></table></div>
        {saved ? <><strong>本次同步记录</strong><p role="status">持仓已保存，组合风险已请求刷新；本次变更保留在持仓快照记录中。</p><button type="button" className={css.primaryButton} onClick={onBack}>完成</button></> : <><p>确认后整体替换本地持仓并重新计算组合风险；空结果不会清空持仓。</p><button type="button" className={css.primaryButton} disabled={busy} onClick={confirm}>确认替换 {items.length} 条持仓</button><button type="button" className={css.secondaryButton} disabled={busy} onClick={() => { setPreview(undefined); setError('') }}>取消预览</button></>}
      </div>}
    </div>
    {(error || source.state.error || config.state.error) && <div className={css.workbenchImportErrors} role="alert"><strong>当前操作未完成</strong><span>{error || source.state.error || config.state.error}</span><span>本地持仓保持不变；可重新读取或改用手动录入。</span></div>}
  </section>
}

function HoldingsEditor({
  positions, requestData, brokerSync, holdingsProviders, onSaveHoldings, onSyncHoldings, onSavingChange, onFlowChange,
}: {
  positions: readonly WorkbenchPositionDetail[]
  requestData: RequestData
  brokerSync: boolean
  holdingsProviders: readonly string[]
  onSaveHoldings: (holdings: readonly WorkbenchHoldingInput[], source: WorkbenchHoldingSaveSource) => Promise<void>
  onSyncHoldings: (token: string) => Promise<readonly WorkbenchHoldingInput[]>
  onSavingChange: (saving: boolean) => void
  onFlowChange: (flow: 'view' | 'import' | 'sync') => void
}) {
  const [flow, setFlow] = useState<'view' | 'import' | 'sync'>('view')
  useEffect(() => { onFlowChange(flow) }, [flow, onFlowChange])
  const [importMode, setImportMode] = useState<'single' | 'batch'>('single')
  const [editDraft, setEditDraft] = useState<HoldingEditorDraft>()
  const [singleDraft, setSingleDraft] = useState<HoldingEditorDraft>(EMPTY_HOLDING_DRAFT)
  const [pendingDelete, setPendingDelete] = useState('')
  const [saving, setSaving] = useState(false)
  const [viewError, setViewError] = useState('')
  const [singleError, setSingleError] = useState('')
  const [importError, setImportError] = useState('')
  const [importSource, setImportSource] = useState('')
  const [notice, setNotice] = useState('')
  const [savedSnapshot, setSavedSnapshot] = useState<readonly WorkbenchHoldingInput[]>()
  const importButtonRef = useRef<HTMLButtonElement>(null)
  const singleTabRef = useRef<HTMLButtonElement>(null)
  const focusRequestRef = useRef<'view' | 'import' | 'sync'>()

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

  useEffect(() => {
    if (saving || focusRequestRef.current !== flow) return
    // sync 面板在自己的挂载副作用里接管焦点（父级工具栏按钮此时已卸载）
    if (flow === 'import') singleTabRef.current?.focus()
    else if (flow !== 'sync') importButtonRef.current?.focus()
    focusRequestRef.current = undefined
  }, [flow, saving])

  const beginImport = (): void => {
    focusRequestRef.current = 'import'
    setPendingDelete(''); setViewError(''); setNotice(''); setImportMode('single'); setFlow('import')
  }
  const beginSync = (): void => {
    focusRequestRef.current = 'sync'
    setPendingDelete(''); setViewError(''); setNotice(''); setFlow('sync')
  }
  const returnToView = (): void => { focusRequestRef.current = 'view'; setFlow('view') }
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
      focusRequestRef.current = 'view'
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
      focusRequestRef.current = 'view'
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
      {flow === 'view' ? (
        <section aria-label="已保存持仓">
          <div className={css.workbenchHoldingToolbar}>
            <div><strong>持仓标的</strong><span>{effectivePositions.length} 项</span></div>
            <div className={css.workbenchHoldingToolbarActions}>
              {brokerSync && <button type="button" className={css.secondaryButton} disabled={saving || editDraft !== undefined || pendingDelete !== ''} onClick={beginSync}>从券商同步持仓</button>}
              <button ref={importButtonRef} type="button" className={css.primaryButton} disabled={saving || editDraft !== undefined || pendingDelete !== ''} onClick={beginImport}>导入持仓</button>
            </div>
          </div>
          {viewError !== '' && <div className={css.inlineError} role="alert">{viewError}</div>}
          {editDraft !== undefined && (
            <form className={css.workbenchHoldingForm} aria-label="持仓编辑表单" onSubmit={(event) => { event.preventDefault(); void saveEditDraft() }}>
              <label><span>股票代码</span><input className={css.fieldInput} type="text" inputMode="numeric" maxLength={6} disabled={saving} value={editDraft.code} onChange={(event) => { setEditDraft({ ...editDraft, code: event.target.value }); setViewError('') }} /></label>
              <label><span>持仓数量</span><input className={css.fieldInput} type="number" min="0" step="any" disabled={saving} value={editDraft.quantity} onChange={(event) => { setEditDraft({ ...editDraft, quantity: event.target.value }); setViewError('') }} /></label>
              <label><span>成本价</span><input className={css.fieldInput} type="number" min="0" step="any" disabled={saving} value={editDraft.costPrice} onChange={(event) => { setEditDraft({ ...editDraft, costPrice: event.target.value }); setViewError('') }} /></label>
              <div>
                <button type="button" className={css.secondaryButton} disabled={saving} onClick={() => { setEditDraft(undefined); setViewError('') }}>取消编辑</button>
                <button type="submit" className={css.primaryButton} disabled={saving}>{saving ? '正在保存…' : '保存持仓'}</button>
              </div>
            </form>
          )}
          <PositionTable
            positions={effectivePositions}
            kind="holdings"
            saving={saving}
            pendingDelete={pendingDelete}
            onEdit={beginEdit}
            onRequestDelete={(code) => { setEditDraft(undefined); setViewError(''); setNotice(''); setPendingDelete(code) }}
            onConfirmDelete={(code) => { void confirmDelete(code) }}
            onCancelDelete={() => { setPendingDelete('') }}
          />
        </section>
      ) : flow === 'sync' ? (
        <HoldingsSyncPanel
          requestData={requestData}
          holdingsProviders={holdingsProviders}
          onSync={applySyncedHoldings}
          onBack={returnToView}
          onSavingChange={(value) => { setSaving(value); onSavingChange(value) }}
        />
      ) : (
        <section aria-label="导入持仓">
          <div className={css.workbenchImportHeader}>
            <div><strong>导入持仓</strong><span>选择适合本次录入数量的方式</span></div>
            <button type="button" className={css.secondaryButton} disabled={saving} onClick={returnToView}>返回持仓明细</button>
          </div>
          <div className={css.workbenchHoldingModeTabs} role="tablist" aria-label="持仓导入方式">
            <button ref={singleTabRef} id="holdings-single-tab" type="button" role="tab" aria-selected={importMode === 'single'} disabled={saving} onClick={() => { setImportMode('single') }}>单条录入</button>
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
        </section>
      )}
    </>
  )
}

function CostDetail({ positions }: { positions: readonly WorkbenchPositionDetail[] }) {
  const total = summedAmount(positions, item => item.costPrice)
  return (
    <>
      <dl className={css.workbenchOverviewMetricGrid}>
        <div><dt>持仓标的</dt><dd>{positions.length} 项</dd></div>
        <div><dt>成本金额合计</dt><dd>{total === undefined ? '—' : compactMoney(total)}</dd></div>
      </dl>
      <PositionTable positions={positions} kind="cost" />
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
  brokerSync = true, holdingsProviders = ['manual', 'easytrader', 'mac_ths', 'qmt'], onClose,
}: WorkbenchOverviewDialogProps) {
  const copy = DIALOG_COPY[kind]
  const [holdingSaving, setHoldingSaving] = useState(false)
  const [holdingFlow, setHoldingFlow] = useState<'view' | 'import' | 'sync'>('view')
  const syncing = kind === 'holdings' && holdingFlow === 'sync'
  const close = (): void => { if (!holdingSaving) onClose() }
  return (
    <DetailDialog
      title={syncing ? '同步同花顺持仓' : copy.title}
      description={syncing ? '选择账户，完成准备后读取预览；确认后才会替换本地持仓。' : copy.description}
      {...(syncing ? {} : { eyebrow: '投研概览' })}
      wide
      onClose={close}
      closeDisabled={holdingSaving}
      actions={<button type="button" className={css.secondaryButton} disabled={holdingSaving} onClick={close}>关闭</button>}
    >
      {kind === 'holdings' || kind === 'cost'
        ? holdingsState.loaded
          ? <>
              {retainedResourceWarning(holdingsState, '持仓')}
              {kind === 'holdings'
                ? <HoldingsEditor
                    positions={positions}
                    requestData={requestData}
                    brokerSync={brokerSync}
                    holdingsProviders={holdingsProviders}
                    onSaveHoldings={onSaveHoldings}
                    onSyncHoldings={onSyncHoldings}
                    onSavingChange={setHoldingSaving}
                    onFlowChange={setHoldingFlow}
                  />
                : <CostDetail positions={positions} />}
            </>
          : resourceMessage(holdingsState, '持仓详情')
        : kind === 'risk-profile'
          ? riskState.loaded
            ? <>{retainedResourceWarning(riskState, '组合风险')}<RiskProfileDetail risk={risk} riskAsOf={riskAsOf} /></>
            : resourceMessage(riskState, '风险画像')
          : <RiskCenterDetail
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
            />}
    </DetailDialog>
  )
}
