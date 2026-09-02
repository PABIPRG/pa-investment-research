import { useEffect, useMemo, useRef, useState } from 'react'
import type { InvestmentDataRequest } from '@deepseek-ai/dsh-client-investment-research-runtime/client'
import { asRecord, number, productErrorText, records, text } from './data.ts'
import type { TrackLocalTelemetry } from './telemetry.ts'
import css from './InvestmentShell.module.css'

type RequestData = (request: InvestmentDataRequest) => Promise<unknown>

interface PreferenceReviewPageProps {
  readonly requestData: RequestData
  readonly onBack: () => void
  readonly backLabel?: string
  readonly trackTelemetry: TrackLocalTelemetry
}

function count(value: unknown): string {
  return (number(value) ?? 0).toLocaleString('zh-CN')
}

function ratio(value: unknown): string {
  const parsed = number(value)
  return parsed === undefined ? '样本不足' : `${(parsed * 100).toFixed(1)}%`
}

function displayTime(value: unknown): string {
  const raw = text(value, '')
  const date = new Date(raw)
  if (raw === '' || Number.isNaN(date.getTime())) return raw || '时间未知'
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date)
}

/** User-owned explanation and controls for the local learning fact store. */
export function PreferenceReviewPage({
  requestData, onBack, backLabel = '← 返回我的投研', trackTelemetry,
}: PreferenceReviewPageProps) {
  const [days, setDays] = useState<7 | 30>(7)
  const [nonce, setNonce] = useState(0)
  const [phase, setPhase] = useState<'loading' | 'success' | 'error'>('loading')
  const [value, setValue] = useState<unknown>()
  const [error, setError] = useState('')
  const [controlBusy, setControlBusy] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)
  const [notice, setNotice] = useState('')
  const generation = useRef(0)

  useEffect(() => {
    void trackTelemetry({
      action: 'page_view', surface: 'portfolio', targetType: 'page',
      targetId: 'preference-review', dedupe: 'moment',
    })
  }, [trackTelemetry])

  useEffect(() => {
    const current = ++generation.current
    setPhase('loading'); setError('')
    void requestData({
      operation: 'trading-core.local-learning-review', input: { days },
    }).then((result) => {
      if (generation.current !== current) return
      setValue(result); setPhase('success')
    }, (reason: unknown) => {
      if (generation.current !== current) return
      setError(productErrorText(reason)); setPhase('error')
    })
    return () => { generation.current += 1 }
  }, [days, nonce, requestData])

  const review = asRecord(value)
  const status = asRecord(review.status)
  const overview = asRecord(review.overview)
  const funnel = asRecord(review.funnel)
  const riskProfile = asRecord(review.explicit_risk_profile)
  const insights = records(review.insights)
  const recent = records(review.recent_activity)
  const enabled = status.enabled !== false
  const loaded = phase === 'success'
  const exportPayload = useMemo(() => ({
    exported_at: new Date().toISOString(),
    window_days: review.window_days,
    rule_version: review.rule_version,
    snapshot_id: review.snapshot_id,
    overview: review.overview,
    funnel: review.funnel,
    insights: review.insights,
    explicit_risk_profile: review.explicit_risk_profile,
  }), [review])

  const updateEnabled = async (): Promise<void> => {
    setControlBusy(true); setNotice('')
    try {
      await requestData({
        operation: 'trading-core.local-learning-settings', input: { enabled: !enabled },
      })
      setNotice(enabled ? '本地学习已暂停；浏览和研究功能不受影响。' : '本地学习已恢复。')
      setNonce(current => current + 1)
    } catch (reason) {
      setNotice(`设置未保存：${productErrorText(reason)}`)
    } finally {
      setControlBusy(false)
    }
  }

  const clear = async (): Promise<void> => {
    setControlBusy(true); setNotice('')
    try {
      await requestData({
        operation: 'trading-core.local-learning-clear', input: { confirm: true },
      })
      setConfirmClear(false)
      setNotice('本地学习记录已清空；持仓、风险资料和研究成果均已保留。')
      setNonce(current => current + 1)
    } catch (reason) {
      setNotice(`清空失败：${productErrorText(reason)}`)
    } finally {
      setControlBusy(false)
    }
  }

  const exportSummary = (): void => {
    const blob = new Blob([JSON.stringify(exportPayload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `偏好复盘-${days}天.json`
    anchor.click()
    URL.revokeObjectURL(url)
    setNotice('已导出当前聚合摘要；文件不包含搜索词、对话或持仓敏感数值。')
  }

  return (
    <div className={css.pageScroll}>
      <div className={css.pageHeader}>
        <div>
          <button type="button" className={css.backTextButton} onClick={onBack}>{backLabel}</button>
          <h1>偏好复盘</h1>
          <p>查看本地记录如何解释你的研究兴趣；这些行为不会修改风险承受能力</p>
        </div>
        <div>
          <button type="button" className={css.secondaryButton} disabled={!loaded} onClick={exportSummary}>导出摘要</button>
          <button
            type="button"
            className={css.secondaryButton}
            aria-busy={phase === 'loading'}
            disabled={phase === 'loading'}
            onClick={() => { setNonce(current => current + 1) }}
          >{phase === 'loading' ? '更新中…' : '刷新'}</button>
        </div>
      </div>

      <section className={css.preferenceBoundary} aria-labelledby="preference-boundary-title">
        <div>
          <strong id="preference-boundary-title">本地、透明、可清空</strong>
          <p>只保存归一化对象和产品动作，不保存搜索原文、对话、报告正文、持仓数量或成本。</p>
        </div>
        <span data-enabled={enabled}>{enabled ? '正在记录' : '已暂停'}</span>
      </section>

      <div className={css.segmented} role="group" aria-label="复盘时间范围">
        {([7, 30] as const).map(value => (
          <button
            key={value}
            type="button"
            aria-pressed={days === value}
            className={days === value ? css.segmentActive : undefined}
            onClick={() => { setDays(value) }}
          >近 {value} 天</button>
        ))}
      </div>

      {phase === 'error' && (
        <div className={css.errorCard} role="alert">
          <div><strong>偏好复盘暂不可用</strong><p>{error}</p></div>
          <button type="button" onClick={() => { setNonce(current => current + 1) }}>重试</button>
        </div>
      )}
      {phase === 'loading' && <div className={css.loadingSkeleton} aria-label="正在加载偏好复盘"><span /><span /><span /></div>}

      {loaded && (
        <>
          <section className={css.preferenceMetrics} aria-label="本地学习摘要">
            <div><span>有效信号</span><strong>{count(overview.signal_count)}</strong><small>打开、分析与反馈</small></div>
            <div><span>活跃天数</span><strong>{count(overview.active_days)}</strong><small>当前时间窗</small></div>
            <div><span>带入分析</span><strong>{count(overview.analyses)}</strong><small>明确研究意图</small></div>
            <div><span>结论置信度</span><strong>{text(overview.confidence, '数据不足')}</strong><small>只代表兴趣稳定性</small></div>
          </section>

          <section className={css.preferencePanel} aria-labelledby="preference-insights-title">
            <div className={css.sectionHeading}>
              <div><strong id="preference-insights-title">系统发现的研究偏好</strong><small>规则 {text(review.rule_version)} · 快照 {text(review.snapshot_id)}</small></div>
            </div>
            {review.enough_data !== true && (
              <div className={css.preferenceEmpty}>
                <strong>数据不足，暂不下结论</strong>
                <p>{text(review.data_note, '继续正常使用即可。')}</p>
              </div>
            )}
            {insights.length > 0 && (
              <div className={css.preferenceInsightList}>
                {insights.map((item, index) => (
                  <article key={text(item.id, String(index))}>
                    <div><strong>{text(item.title, '研究兴趣')}</strong><span>{text(item.confidence, '低')}置信度</span></div>
                    <p>{text(item.explanation)}</p>
                    <small>{count(item.evidence_count)} 个证据 · 覆盖 {count(item.active_days)} 天</small>
                    <small>{text(item.safety_note)}</small>
                  </article>
                ))}
              </div>
            )}
          </section>

          <div className={css.preferenceGrid}>
            <section className={css.preferencePanel} aria-labelledby="preference-funnel-title">
              <div className={css.sectionHeading}><strong id="preference-funnel-title">研究行为漏斗</strong></div>
              <dl className={css.preferenceFunnel}>
                <div><dt>有效曝光</dt><dd>{count(funnel.impressions)}</dd></div>
                <div><dt>打开</dt><dd>{count(funnel.opens)}</dd></div>
                <div><dt>带入分析</dt><dd>{count(funnel.analyses)}</dd></div>
                <div><dt>明确反馈</dt><dd>{count(funnel.feedback)}</dd></div>
                <div><dt>曝光→打开</dt><dd>{ratio(funnel.open_rate)}</dd></div>
                <div><dt>打开→分析</dt><dd>{ratio(funnel.analysis_rate)}</dd></div>
              </dl>
            </section>

            <section className={css.preferencePanel} aria-labelledby="explicit-risk-title">
              <div className={css.sectionHeading}><strong id="explicit-risk-title">显式风险约束</strong></div>
              <div className={css.explicitRisk}>
                <span>当前风险画像</span>
                <strong>{text(riskProfile.label, '稳健型')}</strong>
                <p>{text(riskProfile.note, '风险承受能力来自显式设置。')}</p>
                <small>行为调整值：{count(riskProfile.behavior_adjustment)}</small>
              </div>
            </section>
          </div>

          <section className={css.preferencePanel} aria-labelledby="recent-learning-title">
            <div className={css.sectionHeading}>
              <div><strong id="recent-learning-title">最近活动</strong><small>仅显示安全标签</small></div>
            </div>
            <div className={css.preferenceActivity}>
              {recent.map((item, index) => (
                <div key={`${text(item.occurred_at)}-${index}`}>
                  <span>{text(item.label, '本地研究活动')}</span><time>{displayTime(item.occurred_at)}</time>
                </div>
              ))}
              {recent.length === 0 && <div className={css.preferenceEmpty}>还没有本地活动记录。</div>}
            </div>
          </section>

          <section className={css.preferenceControls} aria-labelledby="preference-controls-title">
            <div>
              <strong id="preference-controls-title">数据控制</strong>
              <p>暂停只停止新增记录；清空仅删除本地学习事件与反馈。</p>
            </div>
            <div>
              <button type="button" className={css.secondaryButton} disabled={controlBusy} onClick={() => { void updateEnabled() }}>
                {enabled ? '暂停本地学习' : '恢复本地学习'}
              </button>
              {!confirmClear && (
                <button type="button" className={css.dangerButton} disabled={controlBusy} onClick={() => { setConfirmClear(true); setNotice('') }}>
                  清空本地记录
                </button>
              )}
            </div>
            {confirmClear && (
              <div className={css.clearConfirmation} role="alert">
                <p>确认清空全部本地行为与反馈？持仓、风险资料和研究成果不会被删除。</p>
                <div>
                  <button type="button" className={css.secondaryButton} disabled={controlBusy} onClick={() => { setConfirmClear(false) }}>取消</button>
                  <button type="button" className={css.dangerButton} disabled={controlBusy} onClick={() => { void clear() }}>
                    {controlBusy ? '正在清空…' : '确认清空'}
                  </button>
                </div>
              </div>
            )}
          </section>
        </>
      )}
      {notice !== '' && <div className={css.importNotice} role="status" aria-live="polite">{notice}</div>}
    </div>
  )
}
