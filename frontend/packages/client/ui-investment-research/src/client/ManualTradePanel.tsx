import { useEffect, useRef, useState } from 'react'
import { Button, Input, IconListPenOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InvestmentDataRequest } from '@deepseek-ai/dsh-client-investment-research-runtime/client'
import { asRecord, money, number, productErrorText, records, text } from './data.ts'
import { privateFunds, useFundsPrivacy } from './funds-privacy.tsx'
import type { WorkbenchHoldingInput } from './WorkbenchOverviewDialog.tsx'
import css from './InvestmentShell.module.css'
import layout from './ManualTradePanel.module.css'
import { SecuritySearchField } from './SecuritySearchField.tsx'
import { HoldingsActionDialog } from './HoldingsActionDialog.tsx'

type RequestData = (request: InvestmentDataRequest) => Promise<unknown>
export interface TradeSelection { side: 'buy' | 'sell' | 'history'; ticker: string; name?: string }

export function ManualTradePanel({ selection, requestData, onClose, onSaved, onBusy, onRecordBuy }: {
  selection: TradeSelection
  requestData: RequestData
  onClose: () => void
  onSaved: (holdings: readonly WorkbenchHoldingInput[], warning?: string) => void
  onBusy: (busy: boolean) => void
  onRecordBuy?: () => void
}) {
  const { hidden } = useFundsPrivacy()
  const [ticker, setTicker] = useState(selection.ticker)
  const [searchOpen, setSearchOpen] = useState(false)
  const [quantity, setQuantity] = useState('')
  const [price, setPrice] = useState('')
  const [fees, setFees] = useState('0')
  const [time, setTime] = useState(() => {
    const now = new Date()
    return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 19)
  })
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const requestId = useRef(crypto.randomUUID())
  const [error, setError] = useState('')
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
  const submit = async (commit: boolean): Promise<void> => {
    if (busyRef.current || selection.side === 'history') return
    if (!/^\d{6}$/.test(ticker) || !Number.isFinite(+quantity) || +quantity <= 0 || !Number.isFinite(+price) || +price <= 0 || !Number.isFinite(+fees) || fees.trim() === '' || +fees < 0 || !Number.isFinite(new Date(time).getTime())) {
      setError(ticker === '' ? '请先搜索并选择证券。' : '请输入有效成交时间、正数数量和价格，以及不小于零的费用。'); return
    }
    busyRef.current = true; setBusy(true); onBusy(true); setError('')
    try {
      const result = asRecord(await requestData({ operation: 'trading-core.holdings-trade', input: {
        action: commit ? 'commit' : 'preview', request_id: requestId.current, ticker, side: selection.side,
        quantity: +quantity, price: +price, fees: +fees, traded_at: new Date(time).toISOString(),
        ...(commit ? { version: text(preview?.version) } : {}),
      } }))
      if (result.saved === true) {
        const holdings = records(result.holdings).map(item => ({ ticker: text(item.ticker), quantity: number(item.quantity)!, cost_price: number(item.cost_price)! }))
        onSaved(holdings, text(result.warning, '') || undefined)
      } else setPreview(result)
    } catch (reason) { setError(productErrorText(reason)); if (commit) setPreview(undefined) }
    finally { busyRef.current = false; setBusy(false); onBusy(false) }
  }
  const entry = asRecord(preview?.entry)
  const visible = entries.filter(item => !selection.ticker || item.ticker === selection.ticker)
  const title = selection.side === 'history' ? '成交记录' : `记录${label}`
  const description = selection.side === 'history' ? '查看手工录入与券商同步的成交，清仓后记录仍会保留。' : `录入已成交的${label}信息，确认后更新研究持仓。`
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
          <div className={layout.historyWrap}><table className={layout.historyTable}><thead><tr><th scope="col">成交时间</th><th scope="col">标的</th><th scope="col">方向</th><th scope="col">数量（股）</th><th scope="col">价格（元）</th><th scope="col">费用（元）</th><th scope="col">来源</th></tr></thead><tbody>{visible.map((item, index) => <tr key={text(item.request_id, String(index))}>
            <td>{text(item.traded_at).replace('T', ' ')}</td><td>{text(item.ticker)}</td><td><span className={layout.direction}>{item.side === 'buy' ? '买入' : item.side === 'sell' ? '卖出' : '待识别'}</span></td><td>{privateFunds(number(item.quantity) === undefined ? '—' : number(item.quantity)!.toLocaleString('zh-CN'), hidden)}</td><td>{privateFunds(number(item.price) === undefined ? '—' : money(number(item.price)!), hidden)}</td><td>{privateFunds(number(item.fees) === undefined ? '未提供' : money(number(item.fees)!), hidden)}</td><td>{item.source === 'manual' ? '手工录入' : '券商同步'}</td>
          </tr>)}</tbody></table></div></>}
      <p className={layout.footnote}>手工成交计入研究持仓；券商同步记录仅展示，不重复计入。</p>
    </> : <>
      <form className={layout.form} onSubmit={event => { event.preventDefault(); void submit(false) }}>
        <div className={layout.fields}>
          <div className={layout.security}>{selection.ticker
            ? <label><span>成交证券</span><Input className={layout.fieldControl ?? ''} value={`${selection.name ? `${selection.name} ` : ''}${selection.ticker}`} disabled /></label>
            : <SecuritySearchField requestData={requestData} disabled={busy} open={searchOpen} onOpenChange={setSearchOpen} onSelect={security => { setTicker(security?.code ?? ''); invalidate() }} />}</div>
          <label className={layout.time}><span>成交时间</span><Input className={layout.fieldControl ?? ''} type="datetime-local" step="1" value={time} disabled={busy} onChange={event => { setTime(event.target.value); invalidate() }} /></label>
          <label><span>成交数量（股）</span><Input className={layout.fieldControl ?? ''} type="number" min="0" step="any" value={quantity} placeholder="输入成交股数" disabled={busy} onChange={event => { setQuantity(event.target.value); invalidate() }} /></label>
          <label><span>成交价格（元）</span><Input className={layout.fieldControl ?? ''} type="number" min="0" step="any" value={price} placeholder="输入每股价格" disabled={busy} onChange={event => { setPrice(event.target.value); invalidate() }} /></label>
          <label><span>费用（元）</span><Input className={layout.fieldControl ?? ''} type="number" min="0" step="any" value={fees} disabled={busy} onChange={event => { setFees(event.target.value); invalidate() }} /></label>
        </div>
        <div className={layout.formActions}><p>仅记录已发生的成交，不向券商下单。</p><Button className={`${css.holdingButton} ${preview ? '' : css.holdingPrimary}`} type="submit" variant={preview ? 'outline' : 'primary'} disabled={busy}>{busy ? '正在处理…' : '预览持仓变化'}</Button></div>
      </form>
      {preview && <section role="status" className={layout.preview} aria-label="持仓变化预览">
        <h4>确认{label}后的持仓</h4>
        <dl><div><dt>持仓数量</dt><dd>{privateFunds(`${entry.before_quantity} → ${entry.after_quantity} 股`, hidden)}</dd></div><div><dt>剩余单位成本</dt><dd>{privateFunds(entry.after_cost_price === null ? '已清仓' : money(number(entry.after_cost_price)!), hidden)}</dd></div></dl>
        <div className={layout.formActions}><p>{selection.side === 'buy' ? '买入费用已计入加权平均成本。' : '剩余单位成本不变，费用保存在本笔记录中。'}</p><Button className={`${css.holdingButton} ${css.holdingPrimary}`} variant="primary" disabled={busy} onClick={() => { void submit(true) }}>确认保存成交</Button></div>
      </section>}
    </>}
    </section>
  </HoldingsActionDialog>
}
