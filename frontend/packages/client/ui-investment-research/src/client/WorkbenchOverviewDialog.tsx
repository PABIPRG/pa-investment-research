import { useEffect, useMemo, useRef, useState } from 'react'
import { asRecord, compactMoney, money, number, records, text } from './data.ts'
import { DetailDialog, riskSource, riskSuggestions } from './DetailDialogs.tsx'
import { parseHoldingsImport } from './holdings-import.ts'
import css from './InvestmentShell.module.css'

export type WorkbenchDetailKind =
  | 'holdings'
  | 'cost'
  | 'market-value'
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
  readonly quotesState: WorkbenchResourceStatus
  readonly riskState: WorkbenchResourceStatus
  readonly alertsState: WorkbenchResourceStatus
  readonly onSaveHoldings: (holdings: readonly WorkbenchHoldingInput[]) => Promise<void>
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
  'market-value': { title: '总资产现价明细', description: '按持仓数量 × 最新返回价格汇总，不含现金。' },
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
  kind: 'holdings' | 'cost' | 'market-value'
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
            {kind !== 'market-value' && <th scope="col">成本价</th>}
            {kind === 'market-value' && <th scope="col">最新价</th>}
            {kind !== 'holdings' && <th scope="col">{kind === 'cost' ? '成本金额' : '当前市值'}</th>}
            {kind === 'holdings' && onEdit !== undefined && <th scope="col">操作</th>}
          </tr>
        </thead>
        <tbody>
          {positions.map((item, index) => {
            const price = kind === 'cost' ? item.costPrice : item.currentPrice
            return (
              <tr key={`${item.code}-${index}`}>
                <th scope="row"><strong>{item.name}</strong><small>{item.code}</small></th>
                <td><span className={css.workbenchMobileLabel}>持仓数量</span>{quantity(item.quantity)}</td>
                <td><span className={css.workbenchMobileLabel}>{kind === 'market-value' ? '最新价' : '成本价'}</span>{amount(kind === 'market-value' ? item.currentPrice : item.costPrice)}</td>
                {kind !== 'holdings' && <td><span className={css.workbenchMobileLabel}>{kind === 'cost' ? '成本金额' : '当前市值'}</span>{amount(positionAmount(item, price))}</td>}
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

function HoldingsEditor({
  positions, onSaveHoldings, onSavingChange,
}: {
  positions: readonly WorkbenchPositionDetail[]
  onSaveHoldings: (holdings: readonly WorkbenchHoldingInput[]) => Promise<void>
  onSavingChange: (saving: boolean) => void
}) {
  const [flow, setFlow] = useState<'view' | 'import'>('view')
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
  const focusRequestRef = useRef<'view' | 'import'>()

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
    if (flow === 'import') singleTabRef.current?.focus(); else importButtonRef.current?.focus()
    focusRequestRef.current = undefined
  }, [flow, saving])

  const beginImport = (): void => {
    focusRequestRef.current = 'import'
    setPendingDelete(''); setViewError(''); setNotice(''); setImportMode('single'); setFlow('import')
  }
  const returnToView = (): void => { focusRequestRef.current = 'view'; setFlow('view') }
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
      await onSaveHoldings(next)
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
      await onSaveHoldings(next)
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
      await onSaveHoldings(next)
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
      await onSaveHoldings(holdings)
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
            <button ref={importButtonRef} type="button" className={css.primaryButton} disabled={saving || editDraft !== undefined || pendingDelete !== ''} onClick={beginImport}>导入持仓</button>
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

function PositionDetail({
  kind, positions,
}: {
  kind: 'holdings' | 'cost' | 'market-value'
  positions: readonly WorkbenchPositionDetail[]
}) {
  const total = kind === 'holdings'
    ? undefined
    : summedAmount(positions, item => kind === 'cost' ? item.costPrice : item.currentPrice)
  return (
    <>
      <dl className={css.workbenchOverviewMetricGrid}>
        <div><dt>持仓标的</dt><dd>{positions.length} 项</dd></div>
        {kind === 'cost' && <div><dt>成本金额合计</dt><dd>{total === undefined ? '—' : compactMoney(total)}</dd></div>}
        {kind === 'market-value' && <div><dt>当前市值合计</dt><dd>{total === undefined ? '—' : compactMoney(total)}</dd></div>}
      </dl>
      <PositionTable positions={positions} kind={kind} />
      {kind === 'market-value' && positions.some(item => item.currentPrice === undefined) && (
        <p className={css.workbenchOverviewFootnote}>部分标的缺少最新价，因此合计显示为“—”；这不代表资产为零。</p>
      )}
      {kind === 'cost' && positions.some(item => item.quantity === undefined || item.costPrice === undefined) && (
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
  risk, alerts, riskAsOf, alertsAsOf, alertsDegraded, alertsDegradedReason, riskState, alertsState,
}: Omit<WorkbenchOverviewDialogProps, 'kind' | 'positions' | 'onClose' | 'onSaveHoldings'>) {
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
  holdingsState, quotesState, riskState, alertsState, onSaveHoldings, onClose,
}: WorkbenchOverviewDialogProps) {
  const copy = DIALOG_COPY[kind]
  const [holdingSaving, setHoldingSaving] = useState(false)
  const close = (): void => { if (!holdingSaving) onClose() }
  return (
    <DetailDialog
      title={copy.title}
      description={copy.description}
      eyebrow="投研概览"
      wide
      onClose={close}
      closeDisabled={holdingSaving}
      actions={<button type="button" className={css.secondaryButton} disabled={holdingSaving} onClick={close}>关闭</button>}
    >
      {kind === 'holdings' || kind === 'cost' || kind === 'market-value'
        ? holdingsState.loaded
          ? kind === 'market-value' && positions.length > 0 && !quotesState.loaded
            ? resourceMessage(quotesState, '实时行情')
            : <>
                {retainedResourceWarning(holdingsState, '持仓')}
                {kind === 'market-value' && retainedResourceWarning(quotesState, '实时行情')}
                {kind === 'holdings'
                  ? <HoldingsEditor positions={positions} onSaveHoldings={onSaveHoldings} onSavingChange={setHoldingSaving} />
                  : <PositionDetail kind={kind} positions={positions} />}
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
              quotesState={quotesState}
              riskState={riskState}
              alertsState={alertsState}
            />}
    </DetailDialog>
  )
}
