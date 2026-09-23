import { useEffect, useId, useRef, useState } from 'react'
import { Button, DatePicker, Input, IconListPenOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InvestmentDataRequest } from '@deepseek-ai/dsh-client-investment-research-runtime/client'
import { asRecord, money, number, productErrorText, records, text, unitCost } from './data.ts'
import { privateFunds, useFundsPrivacy } from './funds-privacy.tsx'
import type { WorkbenchHoldingInput } from './WorkbenchOverviewDialog.tsx'
import css from './InvestmentShell.module.css'
import layout from './ManualTradePanel.module.css'
import { SecuritySearchField } from './SecuritySearchField.tsx'
import { HoldingsActionDialog } from './HoldingsActionDialog.tsx'

type RequestData = (request: InvestmentDataRequest) => Promise<unknown>
export interface TradeSelection { side: 'buy' | 'sell' | 'history'; ticker: string; name?: string }
type TradeField = 'security' | 'time' | 'quantity' | 'price' | 'fees' | 'impact'
type FieldErrors = Partial<Record<TradeField, string>>

function displayLocalTime(value: Date): string {
  const part = (number: number): string => String(number).padStart(2, '0')
  return `${value.getFullYear()}/${part(value.getMonth() + 1)}/${part(value.getDate())} ${part(value.getHours())}:${part(value.getMinutes())}:${part(value.getSeconds())}`
}

function parseLocalTime(value: string): Date | undefined {
  const match = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim())
  if (!match) return undefined
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match
  const [year, month, day, hour, minute, second] = [yearText, monthText, dayText, hourText, minuteText, secondText ?? '0'].map(Number)
  const date = new Date(year!, month! - 1, day!, hour!, minute!, second!)
  if (date.getFullYear() !== year || date.getMonth() + 1 !== month || date.getDate() !== day
    || date.getHours() !== hour || date.getMinutes() !== minute || date.getSeconds() !== second) return undefined
  return date
}

function displayHistoryTime(value: string): string {
  if (/(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    const date = new Date(value)
    if (Number.isFinite(date.getTime())) return displayLocalTime(date)
  }
  const local = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value)
  return local ? `${local[1]}/${local[2]}/${local[3]} ${local[4]}:${local[5]}:${local[6] ?? '00'}` : value || '—'
}

export function ManualTradePanel({ selection, requestData, onClose, onSaved, onBusy, onRecordBuy }: {
  selection: TradeSelection
  requestData: RequestData
  onClose: () => void
  onSaved: (holdings: readonly WorkbenchHoldingInput[], message?: string) => void
  onBusy: (busy: boolean) => void
  onRecordBuy?: () => void
}) {
  const { hidden } = useFundsPrivacy()
  const [ticker, setTicker] = useState(selection.ticker)
  const [searchOpen, setSearchOpen] = useState(false)
  const [quantity, setQuantity] = useState('')
  const [price, setPrice] = useState('')
  const [fees, setFees] = useState('0')
  const [time, setTime] = useState(() => displayLocalTime(new Date()))
  const [affectsHoldings, setAffectsHoldings] = useState<boolean | null>(null)
  const impactName = useId()
  const timeInputId = useId()
  const quantityInputId = useId()
  const priceInputId = useId()
  const feesInputId = useId()
  const validationId = useId()
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const requestId = useRef(crypto.randomUUID())
  const [error, setError] = useState('')
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})
  const [preview, setPreview] = useState<Record<string, unknown>>()
  const [entries, setEntries] = useState<Record<string, unknown>[]>([])
  const [loaded, setLoaded] = useState(false)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    if (selection.side !== 'history') return
    let active = true
    setLoaded(false); setError('')
    void requestData({ operation: 'trading-core.holdings-trades' }).then(value => {
      if (active) { setEntries(records(asRecord(value).entries)); setLoaded(true) }
    }, reason => { if (active) { setError(productErrorText(reason)); setLoaded(true) } })
    return () => { active = false }
  }, [selection.side, requestData, retry])
  const label = selection.side === 'sell' ? '卖出' : '买入'
  const invalidate = (): void => { setPreview(undefined); setError(''); requestId.current = crypto.randomUUID() }
  const clearFieldError = (field: TradeField): void => { setFieldErrors(current => {
    if (!current[field]) return current
    const next = { ...current }
    delete next[field]
    return next
  }) }
  const submit = async (commit: boolean): Promise<void> => {
    if (busyRef.current || selection.side === 'history') return
    const tradedAt = parseLocalTime(time)
    const nextErrors: FieldErrors = {}
    if (!/^\d{6}$/.test(ticker)) nextErrors.security = '请搜索并选择证券。'
    if (!tradedAt) nextErrors.time = '成交时间无效，请重新输入或使用日历选择日期。'
    if (!Number.isFinite(+quantity) || +quantity <= 0) nextErrors.quantity = '请输入大于 0 的成交数量。'
    if (!Number.isFinite(+price) || +price <= 0) nextErrors.price = '请输入大于 0 的成交价格。'
    if (!Number.isFinite(+fees) || fees.trim() === '' || +fees < 0) nextErrors.fees = '费用不能小于 0。'
    if (affectsHoldings === null) nextErrors.impact = '请选择这笔成交是否已计入当前持仓。'
    setFieldErrors(nextErrors)
    if (Object.keys(nextErrors).length > 0 || !tradedAt) { setError(''); return }
    const normalizedTime = displayLocalTime(tradedAt)
    if (normalizedTime !== time) setTime(normalizedTime)
    busyRef.current = true; setBusy(true); onBusy(true); setError('')
    try {
      const result = asRecord(await requestData({ operation: 'trading-core.holdings-trade', input: {
        action: commit ? 'commit' : 'preview', request_id: requestId.current, ticker, side: selection.side,
        quantity: +quantity, price: +price, fees: +fees, traded_at: tradedAt.toISOString(), affects_holdings: affectsHoldings,
        ...(commit ? { version: text(preview?.version) } : {}),
      } }))
      if (result.saved === true) {
        const holdings = records(result.holdings).map(item => ({ ticker: text(item.ticker), quantity: number(item.quantity)!, cost_price: number(item.cost_price)! }))
        onSaved(holdings, text(result.warning, '') || (affectsHoldings ? undefined : '成交记录已保存，当前持仓未改变。'))
      } else setPreview(result)
    } catch (reason) { setError(productErrorText(reason)); if (commit) setPreview(undefined) }
    finally { busyRef.current = false; setBusy(false); onBusy(false) }
  }
  const entry = asRecord(preview?.entry)
  const pickerTime = parseLocalTime(time) ?? new Date()
  const pickerDate = `${pickerTime.getFullYear()}-${String(pickerTime.getMonth() + 1).padStart(2, '0')}-${String(pickerTime.getDate()).padStart(2, '0')}`
  const visible = entries.filter(item => !selection.ticker || item.ticker === selection.ticker)
  const title = selection.side === 'history' ? '成交记录' : `记录${label}`
  const description = selection.side === 'history' ? '查看手工录入与券商同步的成交，清仓后记录仍会保留。' : `录入已成交的${label}信息，并确认是否要调整当前持仓。`
  return <HoldingsActionDialog title={title} description={description} ticker={selection.ticker} onClose={onClose} busy={busy} wide={selection.side === 'history'}
    onEscapeKeyDown={event => { if (searchOpen) { event.preventDefault(); setSearchOpen(false) } }}>
    <section className={layout.panel} aria-label={title}>
    {error && <p role="alert" className={css.inlineError}>{error}</p>}
    {selection.side === 'history' ? <>
      {!loaded ? <div className={layout.empty} role="status"><span className={layout.emptyIcon}><IconListPenOutline16 size={24} /></span><strong>正在加载成交记录…</strong></div>
        : error ? <div className={layout.empty}><strong>成交记录暂未加载</strong><p>已有持仓不受影响，请稍后重试。</p><Button className={css.holdingButton} variant="outline" onClick={() => { setRetry(retry + 1) }}>重新加载</Button></div>
        : visible.length === 0 ? <div className={layout.empty}>
          <span className={layout.emptyIcon}><IconListPenOutline16 size={24} /></span>
          <strong>还没有成交记录</strong>
          <p>录入一笔已发生的买入或卖出，便可在这里查看。<br />直接编辑或导入持仓不会生成成交记录。</p>
          {onRecordBuy && <Button className={`${css.holdingButton} ${css.holdingPrimary}`} variant="primary" onClick={onRecordBuy}>记录一笔买入</Button>}
        </div>
        : <><div className={layout.historyCaption}><strong>{selection.ticker ? '该标的成交' : '全部成交'}</strong><span>共 {visible.length} 笔</span></div>
          <div className={layout.historyWrap}><table className={layout.historyTable}><thead><tr><th scope="col">成交时间</th><th scope="col">标的</th><th scope="col">方向</th><th scope="col">数量（股）</th><th scope="col">价格（元）</th><th scope="col">费用（元）</th><th scope="col">来源</th><th scope="col">当前持仓</th></tr></thead><tbody>{visible.map((item, index) => <tr key={text(item.request_id, String(index))}>
            <td>{displayHistoryTime(text(item.traded_at))}</td><td>{text(item.ticker)}</td><td><span className={layout.direction}>{item.side === 'buy' ? '买入' : item.side === 'sell' ? '卖出' : '待识别'}</span></td><td>{privateFunds(number(item.quantity) === undefined ? '—' : number(item.quantity)!.toLocaleString('zh-CN'), hidden)}</td><td>{privateFunds(number(item.price) === undefined ? '—' : money(number(item.price)!), hidden)}</td><td>{privateFunds(number(item.fees) === undefined ? '未提供' : money(number(item.fees)!), hidden)}</td><td>{item.source === 'manual' ? '手工录入' : '券商同步'}</td><td>{item.source === 'manual' ? item.affects_holdings === false ? '仅补记录' : '已更新' : '随券商同步'}</td>
          </tr>)}</tbody></table></div></>}
      <p className={layout.footnote}>手工成交是否调整当前持仓，以录入时的选择为准；券商同步记录仅展示。</p>
    </> : <>
      <form className={layout.form} noValidate onSubmit={event => { event.preventDefault(); void submit(false) }}>
        <div className={layout.fields}>
          <div className={layout.security}>{selection.ticker
            ? <label><span>成交证券</span><Input className={layout.fieldControl ?? ''} value={`${selection.name ? `${selection.name} ` : ''}${selection.ticker}`} disabled /></label>
            : <SecuritySearchField requestData={requestData} disabled={busy} open={searchOpen} onOpenChange={setSearchOpen} validationError={fieldErrors.security} onSelect={security => { setTicker(security?.code ?? ''); clearFieldError('security'); invalidate() }} />}</div>
          <div className={layout.time}>
            <label htmlFor={timeInputId}>成交时间</label>
            <div className={layout.timeControls}>
              <Input id={timeInputId} className={layout.fieldControl ?? ''} type="text" autoComplete="off" spellCheck={false} maxLength={19} placeholder="YYYY/MM/DD HH:mm:ss" value={time} disabled={busy}
                aria-invalid={Boolean(fieldErrors.time)} aria-describedby={fieldErrors.time ? `${validationId}-time` : undefined}
                onChange={event => { setTime(event.target.value); clearFieldError('time'); invalidate() }}
                onBlur={() => { const parsed = parseLocalTime(time); if (parsed) { setTime(displayLocalTime(parsed)); clearFieldError('time') } }} />
              <DatePicker value={pickerDate} label="选日期" iconOnly disabled={busy} onChange={date => {
                const selectedTime = displayLocalTime(parseLocalTime(time) ?? new Date()).slice(11)
                setTime(`${date.replaceAll('-', '/')} ${selectedTime}`); clearFieldError('time'); invalidate()
              }} />
            </div>
            {fieldErrors.time && <small id={`${validationId}-time`} role="alert" className={layout.fieldError}>{fieldErrors.time}</small>}
          </div>
          <div className={layout.numericField}>
            <label htmlFor={quantityInputId}>成交数量（股）</label>
            <Input id={quantityInputId} className={layout.fieldControl ?? ''} type="number" min="0" step="any" value={quantity} placeholder="输入成交股数" disabled={busy}
              aria-invalid={Boolean(fieldErrors.quantity)} aria-describedby={fieldErrors.quantity ? `${validationId}-quantity` : undefined}
              onChange={event => { setQuantity(event.target.value); clearFieldError('quantity'); invalidate() }} />
            {fieldErrors.quantity && <small id={`${validationId}-quantity`} role="alert" className={layout.fieldError}>{fieldErrors.quantity}</small>}
          </div>
          <div className={layout.numericField}>
            <label htmlFor={priceInputId}>成交价格（元）</label>
            <Input id={priceInputId} className={layout.fieldControl ?? ''} type="number" min="0" step="any" value={price} placeholder="输入每股价格" disabled={busy}
              aria-invalid={Boolean(fieldErrors.price)} aria-describedby={fieldErrors.price ? `${validationId}-price` : undefined}
              onChange={event => { setPrice(event.target.value); clearFieldError('price'); invalidate() }} />
            {fieldErrors.price && <small id={`${validationId}-price`} role="alert" className={layout.fieldError}>{fieldErrors.price}</small>}
          </div>
          <div className={layout.numericField}>
            <label htmlFor={feesInputId}>费用（元）</label>
            <Input id={feesInputId} className={layout.fieldControl ?? ''} type="number" min="0" step="any" value={fees} disabled={busy}
              aria-invalid={Boolean(fieldErrors.fees)} aria-describedby={fieldErrors.fees ? `${validationId}-fees` : undefined}
              onChange={event => { setFees(event.target.value); clearFieldError('fees'); invalidate() }} />
            {fieldErrors.fees && <small id={`${validationId}-fees`} role="alert" className={layout.fieldError}>{fieldErrors.fees}</small>}
          </div>
          <fieldset className={layout.impact} disabled={busy} aria-invalid={Boolean(fieldErrors.impact)} aria-describedby={fieldErrors.impact ? `${validationId}-impact` : undefined}>
            <legend>这笔成交是否已计入当前持仓？</legend>
            <div className={layout.impactOptions}>
              <label><input type="radio" name={impactName} checked={affectsHoldings === false} onChange={() => { setAffectsHoldings(false); clearFieldError('impact'); invalidate() }} /><span><strong>已计入，只补成交记录</strong><small>当前数量、成本和历史快照不变</small></span></label>
              <label><input type="radio" name={impactName} checked={affectsHoldings === true} onChange={() => { setAffectsHoldings(true); clearFieldError('impact'); invalidate() }} /><span><strong>未计入，更新当前持仓</strong><small>按当前数量和成本计算本次变化</small></span></label>
            </div>
            {fieldErrors.impact && <small id={`${validationId}-impact`} role="alert" className={layout.fieldError}>{fieldErrors.impact}</small>}
          </fieldset>
        </div>
        <div className={layout.formActions}><p>仅记录已发生的成交，不向券商下单。</p><Button className={`${css.holdingButton} ${preview ? '' : css.holdingPrimary}`} type="submit" variant={preview ? 'outline' : 'primary'} disabled={busy}>{busy ? '正在处理…' : '预览记录结果'}</Button></div>
      </form>
      {preview && <section role="status" className={layout.preview} aria-label="成交记录预览">
        <h4>{affectsHoldings ? `确认${label}后的当前持仓` : '仅补录成交记录'}</h4>
        {affectsHoldings && preview.backdated === true && <p className={layout.impactWarning}>成交时间早于最近一次持仓更新。系统会调整当前持仓，不会倒推重算已有历史快照；请确认这笔成交尚未计入当前持仓。</p>}
        {!affectsHoldings && <p className={layout.impactNote}>只保存这笔成交记录，当前持仓和已有历史快照保持不变。</p>}
        <dl><div><dt>当前持仓数量</dt><dd>{affectsHoldings ? `${entry.before_quantity} → ${entry.after_quantity} 股` : `${entry.after_quantity} 股（不变）`}</dd></div><div><dt>当前单位成本</dt><dd>{entry.after_cost_price === null ? '无持仓' : unitCost(entry.after_cost_price)}</dd></div></dl>
        <div className={layout.formActions}><p>{!affectsHoldings ? '这笔成交不会再次计入持仓。' : selection.side === 'buy' ? '买入费用计入当前加权平均成本。' : '剩余单位成本不变，费用保存在本笔记录中。'}</p><Button className={`${css.holdingButton} ${css.holdingPrimary}`} variant="primary" disabled={busy} onClick={() => { void submit(true) }}>确认保存成交</Button></div>
      </section>}
    </>}
    </section>
  </HoldingsActionDialog>
}
