import { Select } from '@deepseek-ai/dsh-client-ui-primitives'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button, IconQuestionOutline14, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InvestmentDataRequest, InvestmentJsonValue } from '@deepseek-ai/dsh-client-investment-research-runtime/client'
import { asRecord, money, number, productErrorText, records, text } from './data.ts'
import { DetailDialog } from './DetailDialogs.tsx'
import css from './InvestmentShell.module.css'

type RequestData = (request: InvestmentDataRequest) => Promise<unknown>
type TargetKind = 'take_profit' | 'stop_loss'
type TargetMode = 'percent' | 'price'

interface TargetDraft {
  readonly enabled: boolean
  readonly mode: TargetMode
  readonly value: string
}

interface PositionRiskDialogProps {
  readonly requestData: RequestData
  readonly ticker?: string | undefined
  readonly name?: string | undefined
  readonly onClose: () => void
  readonly onChanged: () => void
}

const EMPTY_TARGET: TargetDraft = Object.freeze({ enabled: true, mode: 'percent', value: '' })
const PROFILE_LABELS: Readonly<Record<string, string>> = { conservative: '保守型', balanced: '稳健型', aggressive: '进取型' }

function CalculationHelp({ kind }: { readonly kind: TargetKind }) {
  const label = kind === 'take_profit' ? '止盈线' : '止损线'
  const example = kind === 'take_profit' ? '止盈幅度 20%，目标价为 120 元' : '止损幅度 10%，目标价为 90 元'
  const explanation = `以确认时的持仓成本价计算。例如成本价 100 元，${example}。确认后目标价固定，成本变化不会自动重算；达到目标只提醒，不会自动交易。`
  return <Tooltip label={explanation} side="bottom" maxWidth={300}>
    <span className={css.positionRiskHelp}><Button size="sm" variant="ghost" icon={<IconQuestionOutline14 />}
      aria-label={`了解${label}计算方式`} aria-description={explanation}
      onClick={(event) => { event.currentTarget.focus() }} /></span>
  </Tooltip>
}

function targetDraft(targetValue: unknown, fallbackPercent: number | undefined): TargetDraft {
  const target = asRecord(targetValue)
  const mode = text(target.mode, 'percent') === 'price' ? 'price' : 'percent'
  const raw = number(target.value)
  const value = raw === undefined
    ? fallbackPercent === undefined ? '' : String(fallbackPercent * 100)
    : String(mode === 'percent' ? raw * 100 : raw)
  return { enabled: target.enabled !== false, mode, value }
}

function targetPayload(target: TargetDraft): Record<string, InvestmentJsonValue> {
  const raw = Number(target.value)
  return {
    enabled: target.enabled,
    mode: target.mode,
    value: target.enabled ? (target.mode === 'percent' ? raw / 100 : raw) : null,
  }
}

function validTarget(target: TargetDraft, kind: TargetKind): boolean {
  if (!target.enabled) return true
  const value = Number(target.value)
  return Number.isFinite(value) && value > 0 && !(kind === 'stop_loss' && target.mode === 'percent' && value >= 100)
}

function TargetEditor({ kind, value, global, disabled, onChange }: {
  readonly kind: TargetKind
  readonly value: TargetDraft
  readonly global: boolean
  readonly disabled: boolean
  readonly onChange: (value: TargetDraft) => void
}) {
  const label = kind === 'take_profit' ? '止盈线' : '止损线'
  return (
    <fieldset className={css.positionRiskTarget} disabled={disabled}>
      <legend>{label}</legend>
      <label className={css.positionRiskToggle}>
        <input type="checkbox" checked={value.enabled} onChange={(event) => { onChange({ ...value, enabled: event.target.checked }) }} />
        <span>启用{label}</span>
      </label>
      <div className={css.positionRiskTargetFields}>
        {global ? <div className={css.positionRiskFixedMode}>
          <div><span>计算方式</span><CalculationHelp kind={kind} /></div>
          <strong>相对成本涨跌幅</strong>
        </div> : <label>
          <span>计算方式</span>
          <Select aria-label="计算方式" value={value.mode} disabled={disabled || !value.enabled}
            onValueChange={mode => { onChange({ ...value, mode: mode as TargetMode }) }}
            options={[{ value: 'percent', label: '相对成本涨跌幅' }, { value: 'price', label: '固定价格' }]} />
        </label>}
        <label>
          <span>{value.mode === 'percent' ? '幅度（%）' : '目标价（元）'}</span>
          <input
            type="number"
            min="0"
            step="0.01"
            value={value.value}
            disabled={disabled || !value.enabled}
            onChange={(event) => { onChange({ ...value, value: event.target.value }) }}
          />
        </label>
      </div>
    </fieldset>
  )
}

/** 持仓表中的解析后计划摘要；只展示有效快照，不在前端复制配置解析逻辑。 */
export function PositionRiskPlanCell({ plan, onEdit, disabled }: {
  readonly plan: Record<string, unknown> | undefined
  readonly disabled?: boolean
  readonly onEdit: () => void
}) {
  if (plan === undefined) {
    return (
      <div className={css.positionRiskCell} data-status="loading">
        <div className={css.positionRiskState}><strong>读取中…</strong></div>
        <Button variant="ghost" size="sm" className={`${css.holdingTextButton} ${css.positionRiskAdjust}`} disabled={disabled} onClick={onEdit}>设置</Button>
      </div>
    )
  }
  const targets = asRecord(plan.targets)
  const takeProfit = asRecord(targets.take_profit)
  const stopLoss = asRecord(targets.stop_loss)
  const status = text(plan.status, 'unconfigured')
  const source = text(plan.source, 'global') === 'override' ? '单独设置' : '继承全局'
  const statusLabel: Readonly<Record<string, string>> = {
    unconfigured: '尚未设置', disabled: '不监控', scheduled: '待生效', active: '监控中',
    triggered: '已触发', expired: '已到期', sync_error: '同步待重试', unconfirmed: '待确认',
  }
  const explanation = `${status === 'unconfigured' ? '请先确认全局配置，或点击设置单独配置该持仓。' : source}${plan.basis_changed === true ? ' · 成本已变化，请复核目标价。' : ''}`
  return (
    <div className={css.positionRiskCell} data-status={status}>
      <div className={css.positionRiskState}>
        <strong>{statusLabel[status] ?? status}</strong>
        <Tooltip label={explanation} side="top" maxWidth={260}>
          <span className={css.positionRiskHelp}><Button className={css.positionRiskInfo} size="sm" variant="ghost" icon={<IconQuestionOutline14 />}
            aria-label="了解止盈止损状态" aria-description={explanation} onClick={event => { event.currentTarget.focus() }} /></span>
        </Tooltip>
      </div>
      {(number(takeProfit.resolved_price) !== undefined || number(stopLoss.resolved_price) !== undefined) && (
        <dl className={css.positionRiskValues} aria-label="止盈止损价格">
          {number(takeProfit.resolved_price) !== undefined && <div><dt>止盈</dt><dd>{money(takeProfit.resolved_price)}</dd></div>}
          {number(stopLoss.resolved_price) !== undefined && <div><dt>止损</dt><dd>{money(stopLoss.resolved_price)}</dd></div>}
        </dl>
      )}
      <Button variant="ghost" size="sm" className={`${css.holdingTextButton} ${css.positionRiskAdjust}`} disabled={disabled} onClick={onEdit}>{status === 'unconfigured' ? '设置' : '调整'}</Button>
    </div>
  )
}

export function positionRiskPlanMap(value: unknown): Map<string, Record<string, unknown>> {
  return new Map(records(asRecord(value).items).map(plan => [text(plan.ticker, ''), plan] as const))
}

/** 全局与单股复用同一配置对话框；单股只保存稀疏 override。 */
export function PositionRiskDialog({ requestData, ticker, name, onClose, onChanged }: PositionRiskDialogProps) {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [value, setValue] = useState<Record<string, unknown>>({})
  const [scope, setScope] = useState<'inherit' | 'custom' | 'disabled'>(ticker === undefined ? 'custom' : 'inherit')
  const [takeProfit, setTakeProfit] = useState<TargetDraft>(EMPTY_TARGET)
  const [stopLoss, setStopLoss] = useState<TargetDraft>(EMPTY_TARGET)

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const response = asRecord(await requestData({
        operation: 'trading-core.position-risk',
        ...(ticker === undefined ? {} : { input: { ticker } }),
      }))
      const item = asRecord(response.item)
      const globalConfig = asRecord(ticker === undefined ? response.global : item.source === 'global' ? item.config : response.global)
      const config = ticker === undefined ? globalConfig : asRecord(item.config)
      const suggestion = asRecord(response.suggestion)
      if (ticker !== undefined) {
        setScope(item.source === 'override' ? config.monitoring_disabled === true ? 'disabled' : 'custom' : 'inherit')
      }
      const initial = Object.keys(config).length > 0 ? config : globalConfig
      setTakeProfit(targetDraft(initial.take_profit, number(suggestion.take_profit_pct)))
      setStopLoss(targetDraft(initial.stop_loss, number(suggestion.stop_loss_pct)))
      setValue(response)
    } catch (reason) {
      setError(productErrorText(reason))
    } finally {
      setLoading(false)
    }
  }, [requestData, ticker])

  useEffect(() => { void load() }, [load])

  const canSave = !loading && !saving && (
    ticker !== undefined && (scope === 'inherit' || scope === 'disabled')
      ? true
      : validTarget(takeProfit, 'take_profit') && validTarget(stopLoss, 'stop_loss')
  )
  const suggestion = asRecord(value.suggestion)
  const plan = asRecord(value.item)
  const targets = asRecord(plan.targets)
  const triggered = useMemo(() => (['take_profit', 'stop_loss'] as const).filter(kind => asRecord(targets[kind]).status === 'triggered'), [targets])

  const save = async (): Promise<void> => {
    if (!canSave) return
    setSaving(true); setError('')
    try {
      if (ticker === undefined) {
        await requestData({
          operation: 'trading-core.position-risk-global-save',
          input: { take_profit: targetPayload(takeProfit), stop_loss: targetPayload(stopLoss), confirmed: true },
        })
      } else if (scope === 'inherit') {
        await requestData({ operation: 'trading-core.position-risk-override-delete', input: { ticker } })
      } else if (scope === 'disabled') {
        await requestData({
          operation: 'trading-core.position-risk-override-save',
          input: { ticker, monitoring_disabled: true, confirmed: true },
        })
      } else {
        await requestData({
          operation: 'trading-core.position-risk-override-save',
          input: {
            ticker, monitoring_disabled: false, take_profit: targetPayload(takeProfit),
            stop_loss: targetPayload(stopLoss), confirmed: true,
          },
        })
      }
      onChanged(); onClose()
    } catch (reason) {
      setError(productErrorText(reason)); setSaving(false)
    }
  }

  const rearm = async (kind: TargetKind): Promise<void> => {
    if (ticker === undefined || saving) return
    setSaving(true); setError('')
    try {
      await requestData({ operation: 'trading-core.position-risk-rearm', input: { ticker, kind } })
      onChanged(); await load()
    } catch (reason) {
      setError(productErrorText(reason))
    } finally {
      setSaving(false)
    }
  }

  const isGlobal = ticker === undefined
  return (
    <DetailDialog
      title={isGlobal ? '全局止盈止损' : `${name || ticker} · 止盈止损`}
      description={isGlobal
        ? '未单独设置的持仓会继承这里的配置；建议值来自已确认的风险画像。'
        : '单股可继承全局、完整覆盖，或明确关闭监控。'}
      eyebrow="持仓风险计划"
      onClose={onClose}
      closeDisabled={saving}
      actions={<>
        <button type="button" className={css.secondaryButton} disabled={saving} onClick={onClose}>取消</button>
        <button type="button" className={css.primaryButton} disabled={!canSave} aria-busy={saving} onClick={() => { void save() }}>
          {saving ? '正在保存…' : isGlobal ? '确认并启用全局配置' : '确认设置'}
        </button>
      </>}
    >
      {loading && <div className={css.positionRiskLoading}>正在读取当前配置…</div>}
      {error !== '' && <div className={css.inlineError} role="alert">{error}</div>}
      {!loading && <div className={css.positionRiskForm}>
        {isGlobal && Object.keys(suggestion).length > 0 && (
          <div className={css.positionRiskSuggestion}>
            <strong>{PROFILE_LABELS[text(suggestion.profile, '')] ?? '风险'}画像建议</strong>
            <span>
              止盈 +{((number(suggestion.take_profit_pct) ?? 0) * 100).toFixed(0)}%
              {' · '}止损 -{((number(suggestion.stop_loss_pct) ?? 0) * 100).toFixed(0)}%
            </span>
            <small>建议不会自动生效；点击下方确认后才会保存。</small>
          </div>
        )}
        {isGlobal && Object.keys(suggestion).length === 0 && (
          <div className={css.positionRiskNotice}>
            <strong>当前没有风险画像建议</strong>
            <span>完成风险测评后可获得默认建议；你也可以直接填写并确认自己的止盈止损线。</span>
          </div>
        )}
        {!isGlobal && <div className={css.positionRiskScope} role="radiogroup" aria-label="单股配置方式">
          <label><input type="radio" name="position-risk-scope" checked={scope === 'inherit'} onChange={() => { setScope('inherit') }} />继承全局</label>
          <label><input type="radio" name="position-risk-scope" checked={scope === 'custom'} onChange={() => { setScope('custom') }} />单独设置</label>
          <label><input type="radio" name="position-risk-scope" checked={scope === 'disabled'} onChange={() => { setScope('disabled') }} />不监控</label>
        </div>}
        {(!isGlobal && scope === 'inherit') && <div className={css.positionRiskNotice}>当前股票不保存单独配置，运行时直接读取全局配置。</div>}
        {(!isGlobal && scope === 'disabled') && <div className={css.positionRiskNotice}>仅关闭这只股票的止盈止损监控；不会影响持仓，也不会执行任何交易。</div>}
        {(isGlobal || scope === 'custom') && <div className={css.positionRiskTargets}>
          <TargetEditor kind="take_profit" value={takeProfit} global={isGlobal} disabled={saving} onChange={setTakeProfit} />
          <TargetEditor kind="stop_loss" value={stopLoss} global={isGlobal} disabled={saving} onChange={setStopLoss} />
        </div>}
        {triggered.length > 0 && <div className={css.positionRiskRearm}>
          <strong>已触发目标</strong>
          <span>同一激活版本只提醒一次。如需继续监控，可手动重新启用。</span>
          <div>{triggered.map(kind => <button key={kind} type="button" className={css.secondaryButton} disabled={saving} onClick={() => { void rearm(kind) }}>重新启用{kind === 'take_profit' ? '止盈' : '止损'}</button>)}</div>
        </div>}
        {(isGlobal || scope === 'custom') && !validTarget(stopLoss, 'stop_loss') && <div className={css.inlineError}>止损幅度需大于 0% 且小于 100%。</div>}
        <p className={css.positionRiskDisclaimer}>目标会在确认时按持仓成本换算为固定价格。后续成本变化不会静默重算；本功能只提醒，不会下单、卖出或撤单。</p>
      </div>}
    </DetailDialog>
  )
}
