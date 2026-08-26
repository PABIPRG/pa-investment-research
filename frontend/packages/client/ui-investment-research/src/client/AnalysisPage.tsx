import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { InvestmentDataRequest } from '@deepseek-ai/dsh-client-investment-research-runtime/client'
import type { AssistantIntent } from './assistant-intent.ts'
import { asRecord, productErrorText, records, text } from './data.ts'
import { DetailDialog } from './DetailDialogs.tsx'
import type { AssistantModule } from './state.ts'
import { TASK_CANCELLED, taskId, waitForTask } from './task-client.ts'
import css from './InvestmentShell.module.css'

type RequestData = (request: InvestmentDataRequest) => Promise<unknown>
type AnalysisTaskKind = 'stock' | 'portfolio' | 'brief' | 'backtest'
type AnalysisTaskPhase = 'idle' | 'running' | 'background' | 'done' | 'error'
type HoldingsAvailability = 'loading' | 'ready' | 'empty' | 'error'

interface AnalysisTaskState {
  readonly phase: AnalysisTaskPhase
  readonly message: string
  readonly taskId?: string
}

interface AnalysisModuleDefinition {
  readonly id: AnalysisTaskKind
  readonly assistantModule: AssistantModule
  readonly title: string
  readonly eyebrow: string
  readonly summary: string
  readonly experts: readonly string[]
  readonly tools: readonly string[]
  readonly sources: readonly string[]
  readonly outputs: readonly string[]
  readonly assistantPrompt: string
}

const ANALYSIS_MODULES: readonly AnalysisModuleDefinition[] = [
  {
    id: 'stock', assistantModule: 'stock', title: '个股多智能体分析', eyebrow: '证券研究',
    summary: '由基本面、估值、技术面、产业链与风险角色协同，对单一证券形成可追溯结论。',
    experts: ['基本面研究员', '估值分析师', '技术面分析师', '产业链研究员', '风险审阅员'],
    tools: ['analyze_stock', 'investment_context（industry / portfolio）'],
    sources: ['证券主数据与行情', '公司分析结果', '产业链关系', '组合关联事实'],
    outputs: ['核心投资逻辑', '估值与关键指标', '风险清单', '后续观察信号', '正式个股报告'],
    assistantPrompt: '请作为个股研究专家，按需调用 analyze_stock 和 investment_context 工具，协助我复核当前个股分析任务。',
  },
  {
    id: 'portfolio', assistantModule: 'portfolio', title: '持仓风险分析', eyebrow: '组合诊断',
    summary: '读取后端已保存的真实持仓，复核集中度、画像预算、关联事件与优先处理顺序。',
    experts: ['组合分析师', '风险预算专家', '事件关联研究员', '复核建议审阅员'],
    tools: ['analyze_holdings', 'investment_context（portfolio）'],
    sources: ['最新组合版本', '风险画像与预算', '风险预警', '持仓关联事件'],
    outputs: ['风险排序', '触发原因', '受影响持仓', '复核建议', '正式组合风险报告'],
    assistantPrompt: '请作为组合风控专家，通过 investment_context 读取 portfolio 上下文，协助我复核当前持仓风险分析。',
  },
  {
    id: 'brief', assistantModule: 'watch', title: '市场简报', eyebrow: '盘前 · 盘中 · 盘后',
    summary: '按时段和研究范围汇总市场、行业、概念、资讯与关注列表，沉淀可再次打开的简报。',
    experts: ['市场主编', '异动研究员', '资讯核验员', '风险编辑'],
    tools: ['watch_overview', 'scan_movers', 'news_flash', 'investment_context（watch）'],
    sources: ['市场概览', '盘中异动', '基础资讯', '关注列表与关联持仓'],
    outputs: ['市场温度', '重点异动', '催化与风险', '观察清单', '正式市场简报'],
    assistantPrompt: '请作为市场简报专家，按需读取 watch 上下文，协助我复核当前市场简报任务的范围和重点。',
  },
  {
    id: 'backtest', assistantModule: 'strategy', title: '历史决策回测', eyebrow: '决策复盘',
    summary: '对历史研究决策进行统一窗口复盘，识别结论命中、失效条件与可改进的研究规则。',
    experts: ['回测研究员', '样本审阅员', '策略评估员', '风险归因员'],
    tools: ['investment_context（reports / strategy）', '受控历史回测任务'],
    sources: ['历史研究报告', '历史行情', '决策时间与前瞻窗口', '统一止盈止损假设'],
    outputs: ['有效样本', '命中与失效分布', '收益与风险摘要', '研究规则改进项', '正式回测报告'],
    assistantPrompt: '请作为历史决策复盘专家，通过 investment_context 读取 reports 和 strategy 上下文，协助我解释当前回测设定与结果。',
  },
]

function analysisModule(kind: AnalysisTaskKind): AnalysisModuleDefinition {
  const definition = ANALYSIS_MODULES.find(item => item.id === kind)
  if (definition === undefined) throw new Error(`unknown analysis module: ${kind}`)
  return definition
}

const EMPTY_TASK: AnalysisTaskState = Object.freeze({ phase: 'idle', message: '尚未运行' })

function TaskState({ state, onOpenReports }: { state: AnalysisTaskState; onOpenReports: () => void }) {
  return (
    <div className={css.analysisTaskState} data-phase={state.phase} role="status" aria-live="polite">
      <span aria-hidden="true" />
      <div>
        <strong>{state.phase === 'idle' ? '等待开始'
          : state.phase === 'running' ? '任务进行中'
            : state.phase === 'background' ? '后台处理中'
              : state.phase === 'done' ? '分析已完成' : '任务需要处理'}</strong>
        <small>{state.message}</small>
      </div>
      {(state.phase === 'done' || state.phase === 'background') && (
        <button type="button" onClick={onOpenReports}>查看投研报告</button>
      )}
    </div>
  )
}

function ModuleHeader({
  definition, onDetail,
}: { definition: AnalysisModuleDefinition; onDetail: () => void }) {
  return (
    <div className={css.analysisModuleHeader}>
      <div>
        <span>{definition.eyebrow}</span>
        <h2>{definition.title}</h2>
        <p>{definition.summary}</p>
      </div>
      <button type="button" className={css.secondaryButton} aria-haspopup="dialog" onClick={onDetail}>
        查看模块详情
      </button>
    </div>
  )
}

export interface SmartAnalysisPageProps {
  readonly requestData: RequestData
  readonly stockQuery: string
  readonly backtestQuery: string
  readonly onStockQuery: (value: string) => void
  readonly onBacktestQuery: (value: string) => void
  readonly onOpenReports: () => void
  readonly onOpenAssistant: (intent: AssistantIntent, module?: AssistantModule) => void
  readonly onOpenPortfolio: () => void
}

/** v0.0.2-aligned business workbench. Conversation remains a separate global surface. */
export function SmartAnalysisPage({
  requestData, stockQuery, backtestQuery, onStockQuery, onBacktestQuery,
  onOpenReports, onOpenAssistant, onOpenPortfolio,
}: SmartAnalysisPageProps) {
  const aliveRef = useRef(true)
  const [detailId, setDetailId] = useState<AnalysisTaskKind>()
  const [depth, setDepth] = useState('standard')
  const [riskProfile, setRiskProfile] = useState('balanced')
  const [holdingsMode, setHoldingsMode] = useState('quick')
  const [briefPeriod, setBriefPeriod] = useState('now')
  const [briefScope, setBriefScope] = useState('all')
  const [backtestWindow, setBacktestWindow] = useState('20')
  const [backtestMinAge, setBacktestMinAge] = useState('14')
  const [holdingsSummary, setHoldingsSummary] = useState('正在读取已保存持仓…')
  const [holdingsAvailability, setHoldingsAvailability] = useState<HoldingsAvailability>('loading')
  const [tasks, setTasks] = useState<Record<AnalysisTaskKind, AnalysisTaskState>>({
    stock: EMPTY_TASK, portfolio: EMPTY_TASK, brief: EMPTY_TASK, backtest: EMPTY_TASK,
  })

  useEffect(() => () => { aliveRef.current = false }, [])
  useEffect(() => {
    let active = true
    requestData({ operation: 'trading-core.holdings' }).then((value) => {
      if (!active) return
      const root = asRecord(value)
      const items = records(root.items ?? root.holdings)
      setHoldingsAvailability(items.length === 0 ? 'empty' : 'ready')
      setHoldingsSummary(items.length === 0
        ? '尚未保存持仓，可前往“我的投研”导入或录入。'
        : `已读取 ${items.length} 项真实持仓；任务将使用最新保存版本。`)
    }).catch(() => {
      if (active) {
        setHoldingsAvailability('error')
        setHoldingsSummary('持仓摘要暂不可用，请先恢复数据连接后再运行分析。')
      }
    })
    return () => { active = false }
  }, [requestData])

  const updateTask = useCallback((kind: AnalysisTaskKind, state: AnalysisTaskState): void => {
    if (!aliveRef.current) return
    setTasks(current => ({ ...current, [kind]: state }))
  }, [])

  const runTask = useCallback(async (kind: AnalysisTaskKind, request: InvestmentDataRequest): Promise<void> => {
    if (tasks[kind].phase === 'running') return
    updateTask(kind, { phase: 'running', message: '正在创建后台任务…' })
    try {
      const started = await requestData(request)
      const id = taskId(started)
      if (id === '') throw new Error('后端没有返回任务编号')
      updateTask(kind, { phase: 'running', message: '任务已创建，正在准备研究资料…', taskId: id })
      const result = await waitForTask(
        requestData,
        id,
        (label) => { updateTask(kind, { phase: 'running', message: label, taskId: id }) },
        () => aliveRef.current,
      )
      if (result === TASK_CANCELLED || !aliveRef.current) return
      const reportId = text(asRecord(result).report_id, '')
      updateTask(kind, {
        phase: 'done', taskId: id,
        message: reportId === '' ? '任务已完成，结果已同步到投研报告。' : `报告 ${reportId} 已生成。`,
      })
    } catch (reason) {
      if (!aliveRef.current) return
      const message = productErrorText(reason)
      updateTask(kind, message.includes('仍在后台执行')
        ? { phase: 'background', message }
        : { phase: 'error', message })
    }
  }, [requestData, tasks, updateTask])

  const selectedDefinition = useMemo(
    () => ANALYSIS_MODULES.find(module => module.id === detailId),
    [detailId],
  )
  const stockValid = /^\d{6}$/.test(stockQuery.trim())
  const backtestValid = backtestQuery.trim() === '' || /^\d{6}$/.test(backtestQuery.trim())

  return (
    <div className={css.pageScroll} data-testid="analysis-workbench">
      <div className={css.pageHeader}>
        <div>
          <h1>智能分析</h1>
          <p>运行结构化研究任务，由专家分工、真实数据和统一报告承接结果</p>
        </div>
        <div>
          <button type="button" className={css.secondaryButton} onClick={onOpenReports}>查看全部投研报告</button>
          <button
            type="button"
            className={css.primaryButton}
            onClick={() => { onOpenAssistant({ kind: 'prompt', prompt: '请根据我当前所在的智能分析工作台，帮助我梳理研究目标和应选择的分析模块。' }, 'general') }}
          >打开 AI 研究助理</button>
        </div>
      </div>

      <section className={css.analysisOverview} aria-labelledby="analysis-overview-title">
        <div>
          <span>结构化任务</span>
          <strong id="analysis-overview-title">4 类</strong>
          <small>个股、持仓、简报、回测相互独立</small>
        </div>
        <div>
          <span>专家协作</span>
          <strong>17 个角色</strong>
          <small>按任务读取资料，不在输入框传 JSON</small>
        </div>
        <div>
          <span>结果归档</span>
          <strong>投研报告</strong>
          <small>任务离开页面后继续运行</small>
        </div>
        <div>
          <span>执行边界</span>
          <strong>研究支持</strong>
          <small>不触发真实交易</small>
        </div>
      </section>

      <div className={css.analysisModuleGrid}>
        <article className={css.analysisModuleCard} data-analysis-module-id="stock">
          <ModuleHeader definition={analysisModule('stock')} onDetail={() => { setDetailId('stock') }} />
          <div className={css.analysisFormGrid}>
            <label><span>A 股代码</span><input aria-label="个股分析股票代码" className={css.fieldInput} inputMode="numeric" maxLength={6} value={stockQuery} placeholder="例如 600519" onChange={(event) => { onStockQuery(event.target.value) }} /></label>
            <label><span>研究深度</span><select className={css.fieldInput} value={depth} onChange={(event) => { setDepth(event.target.value) }}><option value="quick">快速</option><option value="standard">标准</option><option value="deep">深度</option><option value="full">完整</option></select></label>
            <label><span>风险画像</span><select className={css.fieldInput} value={riskProfile} onChange={(event) => { setRiskProfile(event.target.value) }}><option value="conservative">保守型</option><option value="balanced">稳健型</option><option value="aggressive">进取型</option></select></label>
          </div>
          {!stockValid && stockQuery.trim() !== '' && <p className={css.analysisValidation}>请输入 6 位 A 股代码。</p>}
          <div className={css.analysisCardActions}>
            <span>任务将调用真实个股分析后端并生成正式报告。</span>
            <button type="button" className={css.primaryButton} disabled={!stockValid || tasks.stock.phase === 'running'} onClick={() => { void runTask('stock', { operation: 'trading-core.analyze', input: { ticker: stockQuery.trim(), research_depth: depth, risk_profile: riskProfile } }) }}>{tasks.stock.phase === 'running' ? '分析中…' : '开始个股分析'}</button>
          </div>
          <TaskState state={tasks.stock} onOpenReports={onOpenReports} />
        </article>

        <article className={css.analysisModuleCard} data-analysis-module-id="portfolio">
          <ModuleHeader definition={analysisModule('portfolio')} onDetail={() => { setDetailId('portfolio') }} />
          <p className={css.analysisDataNotice}>{holdingsSummary}</p>
          <div className={css.analysisChoiceRow} role="group" aria-label="持仓分析模式">
            <button type="button" aria-pressed={holdingsMode === 'quick'} onClick={() => { setHoldingsMode('quick') }}>快速诊断</button>
            <button type="button" aria-pressed={holdingsMode === 'deep'} onClick={() => { setHoldingsMode('deep') }}>深入研究</button>
          </div>
          <div className={css.analysisCardActions}>
            <button type="button" className={css.secondaryButton} onClick={onOpenPortfolio}>查看与编辑持仓</button>
            <button
              type="button"
              className={css.primaryButton}
              disabled={holdingsAvailability !== 'ready' || tasks.portfolio.phase === 'running'}
              title={holdingsAvailability === 'ready' ? undefined : '请先在“我的投研”保存可用持仓'}
              onClick={() => { void runTask('portfolio', { operation: 'trading-core.holdings-analyze', input: { mode: holdingsMode, use_saved: true, risk_profile: riskProfile } }) }}
            >{tasks.portfolio.phase === 'running' ? '分析中…' : '分析持仓风险'}</button>
          </div>
          <TaskState state={tasks.portfolio} onOpenReports={onOpenReports} />
        </article>

        <article className={css.analysisModuleCard} data-analysis-module-id="backtest">
          <ModuleHeader definition={analysisModule('backtest')} onDetail={() => { setDetailId('backtest') }} />
          <div className={css.analysisFormGrid}>
            <label><span>股票代码（可留空）</span><input aria-label="历史回测股票代码" className={css.fieldInput} inputMode="numeric" maxLength={6} value={backtestQuery} placeholder="留空复盘全部历史决策" onChange={(event) => { onBacktestQuery(event.target.value) }} /></label>
            <label><span>前瞻窗口</span><select className={css.fieldInput} value={backtestWindow} onChange={(event) => { setBacktestWindow(event.target.value) }}><option value="10">10 个交易日</option><option value="20">20 个交易日</option><option value="60">60 个交易日</option></select></label>
            <label><span>最小决策年龄</span><select className={css.fieldInput} value={backtestMinAge} onChange={(event) => { setBacktestMinAge(event.target.value) }}><option value="7">7 天</option><option value="14">14 天</option><option value="30">30 天</option></select></label>
          </div>
          {!backtestValid && <p className={css.analysisValidation}>股票代码需为 6 位数字，或留空回测全部决策。</p>}
          <div className={css.analysisCardActions}>
            <span>按统一止损 5%、止盈 10%、中性带 2% 复盘。</span>
            <button type="button" className={css.primaryButton} disabled={!backtestValid || tasks.backtest.phase === 'running'} onClick={() => { void runTask('backtest', { operation: 'trading-core.backtest-run', input: { ...(backtestQuery.trim() === '' ? {} : { code: backtestQuery.trim() }), eval_window_days: Number(backtestWindow), min_age_days: Number(backtestMinAge), stop_loss_pct: 5, take_profit_pct: 10, neutral_band_pct: 2 } }) }}>{tasks.backtest.phase === 'running' ? '回测中…' : '运行历史回测'}</button>
          </div>
          <TaskState state={tasks.backtest} onOpenReports={onOpenReports} />
        </article>

        <article className={css.analysisModuleCard} data-analysis-module-id="brief">
          <ModuleHeader definition={analysisModule('brief')} onDetail={() => { setDetailId('brief') }} />
          <div className={css.analysisFormGrid}>
            <label><span>简报时段</span><select className={css.fieldInput} value={briefPeriod} onChange={(event) => { setBriefPeriod(event.target.value) }}><option value="pre_market">盘前</option><option value="now">盘中 / 当前</option><option value="post_market">盘后</option></select></label>
            <label><span>研究范围</span><select className={css.fieldInput} value={briefScope} onChange={(event) => { setBriefScope(event.target.value) }}><option value="all">全市场</option><option value="watchlist">关注列表</option><option value="industry">行业</option><option value="news">资讯</option></select></label>
          </div>
          <div className={css.analysisCardActions}>
            <span>简报完成后进入统一投研报告，不依赖当前对话。</span>
            <button type="button" className={css.primaryButton} disabled={tasks.brief.phase === 'running'} onClick={() => { void runTask('brief', { operation: 'trading-core.brief-start', input: { period: briefPeriod, scope: briefScope, risk_profile: riskProfile } }) }}>{tasks.brief.phase === 'running' ? '生成中…' : '生成市场简报'}</button>
          </div>
          <TaskState state={tasks.brief} onOpenReports={onOpenReports} />
        </article>
      </div>

      <section className={css.analysisPipeline} aria-labelledby="analysis-pipeline-title">
        <div><h2 id="analysis-pipeline-title">后台任务进度</h2><p>任务离开页面后继续运行，最终结果统一进入投研报告。</p></div>
        <ol>
          {(['stock', 'portfolio', 'brief', 'backtest'] as const).map((kind) => {
            const module = analysisModule(kind)
            const state = tasks[kind]
            return <li key={kind} data-phase={state.phase}><span aria-hidden="true" /><div><strong>{module.title}</strong><small>{state.message}</small></div><em>{state.phase === 'idle' ? '待开始' : state.phase === 'running' ? '进行中' : state.phase === 'done' ? '已完成' : state.phase === 'background' ? '后台中' : '需处理'}</em></li>
          })}
        </ol>
      </section>

      {selectedDefinition !== undefined && (
        <DetailDialog
          title={selectedDefinition.title}
          description={selectedDefinition.summary}
          eyebrow="智能分析模块"
          onClose={() => { setDetailId(undefined) }}
          actions={<>
            <button type="button" className={css.secondaryButton} onClick={() => { setDetailId(undefined) }}>继续配置任务</button>
            <button type="button" className={css.primaryButton} data-action="analysis-module-chat" data-analysis-module-id={selectedDefinition.id} onClick={() => { setDetailId(undefined); onOpenAssistant({ kind: 'prompt', prompt: selectedDefinition.assistantPrompt }, selectedDefinition.assistantModule) }}>用此模块打开 AI 助理</button>
          </>}
        >
          <div className={css.detailTags} data-testid="analysis-module-tags">
            <span>{selectedDefinition.eyebrow}</span>
            {selectedDefinition.experts.map(expert => <span key={expert}>{expert}</span>)}
          </div>
          <section className={css.detailSection} data-testid="expert-team"><h3>专家团分工</h3><ul className={css.detailList}>{selectedDefinition.experts.map(expert => <li key={expert}>{expert}</li>)}</ul></section>
          <section className={css.detailSection}>
            <h3>工具与数据来源</h3>
            <ul className={css.detailList}>
              {selectedDefinition.tools.map(tool => <li key={tool}>{tool}</li>)}
              {selectedDefinition.sources.map(source => <li key={source}>数据：{source}</li>)}
            </ul>
            <p className={css.detailFootnote}>模型按需读取资料；输入框只保留自然语言问题，不会出现业务 JSON。</p>
          </section>
          <section className={css.detailSection}>
            <h3>预期产出</h3>
            <ul className={css.detailList}>
              {selectedDefinition.outputs.map(output => <li key={output}>{output}</li>)}
            </ul>
          </section>
        </DetailDialog>
      )}
    </div>
  )
}
