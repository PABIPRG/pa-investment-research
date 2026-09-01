import { useState } from 'react'
import type { InvestmentDataRequest } from '@deepseek-ai/dsh-client-investment-research-runtime/client'
import {
  Button,
  IconCloseOutline16,
  Modal,
  ProgressBar,
  RadioCardGroup,
  SegmentedControl,
  TextArea,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { asRecord, number, productErrorText, records, text } from './data.ts'
import css from './KycProfilePanel.module.css'

type RequestData = (request: InvestmentDataRequest) => Promise<unknown>

const ignoreClose = (): void => {}

interface KycProfilePanelProps {
  readonly value: unknown
  readonly loaded: boolean
  readonly busy: boolean
  readonly error: string
  readonly requestData: RequestData
  readonly onRetry: () => void
  readonly onChanged: (message: string) => void
}

function stringItems(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
    : []
}

function answersByQid(value: unknown): Record<string, Record<string, unknown>> {
  return Object.fromEntries(records(value).flatMap((answer) => {
    const qid = text(answer.qid, '')
    return qid === '' ? [] : [[qid, answer]]
  }))
}

export function kycProfileLabel(profile: Record<string, unknown>, value: unknown): string {
  const key = text(value, '')
  const labels = asRecord(profile.profile_labels)
  if (key !== '') return text(labels[key], key)
  return '待完善'
}

function statusLabel(value: unknown): string {
  const status = text(value, '')
  if (status === 'completed') return '已完成'
  if (status === 'adjusted') return '已微调'
  if (status === 'not_started') return '待测评'
  return status === '' ? '待完成' : status
}

function ratioLabel(value: unknown): string {
  const resolved = number(value)
  if (resolved === undefined) return '—'
  const ratio = Math.abs(resolved) <= 1 ? resolved * 100 : resolved
  return `${ratio.toFixed(1)}%`
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
  const [tierDirection, setTierDirection] = useState<'forward' | 'backward' | ''>('')
  const qids = stringItems(tiers[tier])
  const [answers, setAnswers] = useState<Record<string, Record<string, unknown>>>(() => answersByQid(profile.answers))
  const [naturalText, setNaturalText] = useState('')
  const [busy, setBusy] = useState<'parse' | 'submit' | ''>('')
  const [failure, setFailure] = useState('')
  const completed = qids.filter(qid => answers[qid] !== undefined).length
  const complete = qids.length > 0 && completed === qids.length
  const tierLabel = tier === 'quick' ? '快速测评' : '完整测评'

  const selectTier = (nextTier: 'quick' | 'full'): void => {
    if (busy !== '' || nextTier === tier) return
    setTierDirection(nextTier === 'full' ? 'forward' : 'backward')
    setTier(nextTier)
  }

  const submit = (): void => {
    if (!complete || busy !== '') return
    setFailure('')
    setBusy('submit')
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
      const label = text(result.label, kycProfileLabel(profile, result.profile))
      onSaved(`风险测评已完成，当前画像更新为${label}。`)
    }, (reason: unknown) => {
      setFailure(`提交失败：${productErrorText(reason, '风险画像暂时无法更新，请稍后重试。')}`)
      setBusy('')
    })
  }

  const parseNaturalAnswer = (): void => {
    const value = naturalText.trim()
    if (value === '' || busy !== '') return
    setFailure('')
    setBusy('parse')
    void requestData({ operation: 'trading-core.kyc-parse', input: { text: value } }).then((result) => {
      const parsed = answersByQid(asRecord(result).answers)
      const matched = Object.fromEntries(qids.flatMap(qid => (
        parsed[qid] === undefined ? [] : [[qid, parsed[qid]]]
      )))
      if (Object.keys(matched).length === 0) {
        setFailure('识别失败：没有识别出可填写的问卷答案，请补充投资期限、亏损承受度或投资目标后重试。')
        setBusy('')
        return
      }
      setAnswers(current => ({
        ...current,
        ...matched,
      }))
      setBusy('')
    }, (reason: unknown) => {
      setFailure(`识别失败：${productErrorText(reason, '暂时无法识别这段描述，请稍后重试。')}`)
      setBusy('')
    })
  }

  return (
    <Modal
      open
      headless
      title="风险测评"
      onClose={busy === '' ? onCancel : ignoreClose}
      className={css.dialog}
    >
      <header className={css.dialogHeader}>
        <div><h2>风险测评</h2><p>回答后将推断并更新当前生效画像。</p></div>
        <Button
          variant="ghost"
          size="sm"
          className={css.closeButton}
          aria-label="关闭风险测评"
          disabled={busy !== ''}
          onClick={onCancel}
        >
          <IconCloseOutline16 size={16} />
        </Button>
      </header>
      <SegmentedControl
        value={tier}
        onValueChange={selectTier}
        items={[
          { value: 'quick', label: `快速测评 · ${stringItems(tiers.quick).length} 题` },
          { value: 'full', label: `完整测评 · ${stringItems(tiers.full).length} 题` },
        ]}
        ariaLabel="测评题量"
        disabled={busy !== ''}
        className={css.tierControl}
      />
      <div className={css.progress} role="status" aria-live="polite" aria-label="测评题量状态">
        <span><b>{tierLabel}已启用</b> · 共 {qids.length} 题</span>
        <strong>已完成 {completed} / {qids.length}</strong>
        <ProgressBar
          className={css.progressBar}
          ariaLabel="测评进度"
          max={qids.length}
          value={completed}
        />
      </div>
      <div className={css.naturalAnswer}>
        <label htmlFor="kyc-natural-answer">用一段话描述你的投资情况</label>
        <TextArea
          id="kyc-natural-answer"
          className={css.naturalText}
          rows={3}
          value={naturalText}
          disabled={busy !== ''}
          placeholder="例如：计划持有 1—3 年，可以承受约 10% 的回撤。"
          onChange={(event) => { setNaturalText(event.target.value) }}
        />
        <Button
          variant="outline"
          className={css.dialogButton}
          disabled={busy !== '' || naturalText.trim() === ''}
          onClick={parseNaturalAnswer}
        >
          {busy === 'parse' ? '识别中…' : '识别并填写'}
        </Button>
      </div>
      {failure !== '' && <p className={css.dialogError} role="alert">{failure}</p>}
      <div className={css.questionStage}>
        <div
          key={tier}
          className={css.questionList}
          role="region"
          aria-label={`${tierLabel}题目`}
          data-direction={tierDirection || undefined}
        >
          {qids.map((qid, index) => {
            const question = asRecord(questionBank[qid])
            const optionRecords = records(question.options)
            const options = optionRecords.flatMap((option) => {
              const label = text(option.label, '')
              return label === '' ? [] : [{ value: label, label }]
            })
            return (
              <RadioCardGroup
                key={qid}
                ordinal={index + 1}
                label={text(question.title, qid)}
                name={qid}
                value={text(answers[qid]?.label, '') || undefined}
                options={options}
                disabled={busy !== ''}
                onValueChange={(label) => {
                  const option = optionRecords.find(candidate => text(candidate.label, '') === label)
                  setAnswers(current => ({
                    ...current,
                    [qid]: { qid, label, score: number(option?.score) ?? 0 },
                  }))
                }}
              />
            )
          })}
        </div>
      </div>
      <footer className={css.dialogFooter}>
        <Button variant="outline" className={css.dialogButton} disabled={busy !== ''} onClick={onCancel}>取消</Button>
        <Button variant="primary" className={css.dialogButton} disabled={busy !== '' || !complete} onClick={submit}>
          {busy === 'submit' ? '提交中…' : '提交并应用画像'}
        </Button>
      </footer>
    </Modal>
  )
}

function KycAdjustment({ profile, inferred, requestData, onCancel, onSaved }: {
  readonly profile: Record<string, unknown>
  readonly inferred: string
  readonly requestData: RequestData
  readonly onCancel: () => void
  readonly onSaved: (message: string) => void
}) {
  const manual = asRecord(profile.manual_adjust)
  const effective = text(profile.effective_profile, 'balanced')
  const [tolerance, setTolerance] = useState(
    number(manual.risk_tolerance) ?? (effective === 'conservative' ? 0 : effective === 'aggressive' ? 1 : 0.5),
  )
  const [horizon, setHorizon] = useState(number(manual.horizon_years) ?? 3)
  const [note, setNote] = useState(text(manual.note, ''))
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState('')

  const submit = (): void => {
    if (busy) return
    setFailure('')
    setBusy(true)
    void requestData({
      operation: 'trading-core.kyc-adjust',
      input: {
        risk_tolerance: tolerance,
        horizon_years: horizon,
        ...(note.trim() === '' ? {} : { note: note.trim() }),
      },
    }).then((value) => {
      const result = asRecord(value)
      const label = text(result.label, kycProfileLabel(profile, result.profile))
      onSaved(`画像复核已应用，当前画像为${label}。`)
    }, (reason: unknown) => {
      setFailure(`应用失败：${productErrorText(reason, '风险画像暂时无法更新，请稍后重试。')}`)
      setBusy(false)
    })
  }

  return (
    <Modal
      open
      headless
      title="复核风险画像"
      onClose={busy ? ignoreClose : onCancel}
      className={`${css.dialog} ${css.adjustDialog}`}
    >
      <header className={css.dialogHeader}>
        <div><h2>复核风险画像</h2><p>在问卷推断之上做受控调整。</p></div>
        <Button
          variant="ghost"
          size="sm"
          className={css.closeButton}
          aria-label="关闭画像复核"
          disabled={busy}
          onClick={onCancel}
        >
          <IconCloseOutline16 size={16} />
        </Button>
      </header>
      <div className={css.adjustBody}>
        <p className={css.adjustConfirm}>确认后会更新当前生效画像，问卷推断仍保留为{inferred}。</p>
        {failure !== '' && <p className={css.dialogError} role="alert">{failure}</p>}
        <label className={css.rangeField}>
          <span><strong>风险承受度</strong><b>{tolerance < 0.34 ? '偏保守' : tolerance > 0.66 ? '偏进取' : '稳健'}</b></span>
          <input aria-label="风险承受度" type="range" min="0" max="1" step="0.05" value={tolerance} disabled={busy} onChange={(event) => { setTolerance(Number(event.target.value)) }} />
          <small><span>降低波动</span><span>承受更高波动</span></small>
        </label>
        <label className={css.rangeField}>
          <span><strong>计划投资期限</strong><b>{horizon} 年</b></span>
          <input aria-label="计划投资期限" type="range" min="1" max="10" step="1" value={horizon} disabled={busy} onChange={(event) => { setHorizon(Number(event.target.value)) }} />
          <small><span>1 年</span><span>10 年</span></small>
        </label>
        <label className={css.noteField}>
          调整说明（选填）
          <TextArea rows={3} value={note} disabled={busy} onChange={(event) => { setNote(event.target.value) }} />
        </label>
      </div>
      <footer className={css.dialogFooter}>
        <Button variant="outline" className={css.dialogButton} disabled={busy} onClick={onCancel}>取消</Button>
        <Button variant="primary" className={css.dialogButton} disabled={busy} onClick={submit}>
          {busy ? '应用中…' : '确认并应用'}
        </Button>
      </footer>
    </Modal>
  )
}

/** KYC profile region embedded in the research workbench side rail. */
export function KycProfilePanel({
  value, loaded, busy, error, requestData, onRetry, onChanged,
}: KycProfilePanelProps) {
  const profile = asRecord(value)
  const inferred = kycProfileLabel(profile, profile.inferred_profile)
  const effective = text(profile.effective_label, kycProfileLabel(profile, profile.effective_profile))
  const notStarted = text(profile.status, '') === 'not_started'
  const effectiveDetail = asRecord(asRecord(profile.profiles_detail)[text(profile.effective_profile, '')])
  const riskBudget = asRecord(effectiveDetail.risk_budget)
  const answerCount = records(profile.answers).length
  const score = number(profile.score)
  const [questionnaireOpen, setQuestionnaireOpen] = useState(false)
  const [adjustmentOpen, setAdjustmentOpen] = useState(false)
  const [notice, setNotice] = useState('')

  const finishQuestionnaire = (message: string): void => {
    setQuestionnaireOpen(false)
    setNotice(message)
    onChanged(message)
  }

  const finishAdjustment = (message: string): void => {
    setAdjustmentOpen(false)
    setNotice(message)
    onChanged(message)
  }

  return (
    <section className={css.panel} tabIndex={-1} aria-labelledby="dashboard-kyc-title" aria-busy={busy}>
      <div className={css.header}>
        <div><h2 id="dashboard-kyc-title">KYC 风险画像</h2><p>区分问卷推断与当前生效画像</p></div>
        <span>{busy ? '加载中…' : loaded ? statusLabel(profile.status) : '等待数据'}</span>
      </div>
      {error !== '' && (
        <div className={css.error} role="alert">
          <div><strong>风险画像暂不可用</strong><p>{error}</p></div>
          <Button variant="outline" size="sm" className={css.panelButton} onClick={onRetry}>重试</Button>
        </div>
      )}
      {notice !== '' && <div className={css.notice} role="status">{notice}</div>}
      {!loaded && error === '' && <div className={css.skeleton} aria-label="正在加载 KYC 风险画像"><i /><i /><i /></div>}
      {loaded && notStarted && (
        <div className={css.defaultState}>
          <span>当前采用系统默认画像</span>
          <strong>{effective}</strong>
          <p>该画像来自系统默认值，不是问卷结论。</p>
          <Button variant="primary" className={css.panelButton} onClick={() => { setQuestionnaireOpen(true) }}>开始风险测评</Button>
        </div>
      )}
      {loaded && !notStarted && (
        <>
          <dl className={css.profileGrid}>
            <div><dt>问卷推断</dt><dd>{inferred}</dd></div>
            <div><dt>当前生效</dt><dd>{effective}</dd></div>
          </dl>
          <dl className={css.detailGrid}>
            <div><dt>测评依据</dt><dd>问卷 {answerCount} 项 · 得分 {score ?? '—'}</dd></div>
            <div><dt>单股预算上限</dt><dd>{ratioLabel(riskBudget.single_stock_weight_max)}</dd></div>
          </dl>
          <div className={css.actions}>
            <Button variant="outline" className={`${css.panelButton} ${css.actionButton}`} onClick={() => { setQuestionnaireOpen(true) }}>重做风险测评</Button>
            <Button variant="primary" className={`${css.panelButton} ${css.actionButton}`} onClick={() => { setAdjustmentOpen(true) }}>复核画像</Button>
          </div>
        </>
      )}
      {questionnaireOpen && (
        <KycQuestionnaire
          profile={profile}
          requestData={requestData}
          onCancel={() => { setQuestionnaireOpen(false) }}
          onSaved={finishQuestionnaire}
        />
      )}
      {adjustmentOpen && (
        <KycAdjustment
          profile={profile}
          inferred={inferred}
          requestData={requestData}
          onCancel={() => { setAdjustmentOpen(false) }}
          onSaved={finishAdjustment}
        />
      )}
    </section>
  )
}
