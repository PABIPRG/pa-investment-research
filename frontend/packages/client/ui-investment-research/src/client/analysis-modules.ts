/** Stable identifiers for the four rc.10 research capabilities. */
export type AnalysisTaskKind = 'stock' | 'portfolio' | 'brief' | 'backtest'
export type AnalysisPromptTemplateId = 'general' | AnalysisTaskKind

/** Content and editable prompt-template metadata shared by analysis entry points. */
export interface AnalysisModuleDefinition {
  readonly id: AnalysisTaskKind
  readonly title: string
  readonly eyebrow: string
  readonly summary: string
  readonly experts: readonly string[]
  readonly tools: readonly string[]
  readonly sources: readonly string[]
  readonly outputs: readonly string[]
  readonly promptTemplate: string
}

/** Canonical catalog used by capability cards and research context controls. */
export const ANALYSIS_MODULES: readonly AnalysisModuleDefinition[] = [
  {
    id: 'stock', title: '个股多智能体分析', eyebrow: '证券研究',
    summary: '由基本面、估值、技术面、产业链与风险角色协同，对单一证券形成可追溯结论。',
    experts: ['基本面研究员', '估值分析师', '技术面分析师', '产业链研究员', '风险审阅员'],
    tools: ['analyze_stock', 'investment_context（industry / portfolio）'],
    sources: ['证券主数据与行情', '公司分析结果', '产业链关系', '组合关联事实'],
    outputs: ['核心投资逻辑', '估值与关键指标', '风险清单', '后续观察信号', '正式个股报告'],
    promptTemplate: '请作为个股研究专家，按需调用 analyze_stock 和 investment_context 工具，协助我复核当前个股分析任务。',
  },
  {
    id: 'portfolio', title: '持仓风险分析', eyebrow: '组合诊断',
    summary: '读取后端已保存的真实持仓，复核集中度、画像预算、关联事件与优先处理顺序。',
    experts: ['组合分析师', '风险预算专家', '事件关联研究员', '复核建议审阅员'],
    tools: ['analyze_holdings', 'investment_context（portfolio）'],
    sources: ['最新组合版本', '风险画像与预算', '风险预警', '持仓关联事件'],
    outputs: ['风险排序', '触发原因', '受影响持仓', '复核建议', '正式组合风险报告'],
    promptTemplate: '请作为组合风控专家，通过 investment_context 读取 portfolio 上下文，协助我复核当前持仓风险分析。',
  },
  {
    id: 'backtest', title: '历史决策回测', eyebrow: '决策复盘',
    summary: '对历史研究决策进行统一窗口复盘，识别结论命中、失效条件与可改进的研究规则。',
    experts: ['回测研究员', '样本审阅员', '策略评估员', '风险归因员'],
    tools: ['investment_context（reports / strategy）', '受控历史回测任务'],
    sources: ['历史研究报告', '历史行情', '决策时间与前瞻窗口', '统一止盈止损假设'],
    outputs: ['有效样本', '命中与失效分布', '收益与风险摘要', '研究规则改进项', '正式回测报告'],
    promptTemplate: '请作为历史决策复盘专家，通过 investment_context 读取 reports 和 strategy 上下文，协助我解释当前回测设定与结果。',
  },
  {
    id: 'brief', title: '市场简报', eyebrow: '盘前 · 盘中 · 盘后',
    summary: '按时段和研究范围汇总市场、行业、概念、资讯与关注列表，沉淀可再次打开的简报。',
    experts: ['市场主编', '异动研究员', '资讯核验员', '风险编辑'],
    tools: ['watch_overview', 'scan_movers', 'news_flash', 'investment_context（watch）'],
    sources: ['市场概览', '盘中异动', '基础资讯', '关注列表与关联持仓'],
    outputs: ['市场温度', '重点异动', '催化与风险', '观察清单', '正式市场简报'],
    promptTemplate: '请作为市场简报专家，按需读取 watch 上下文，协助我复核当前市场简报任务的范围和重点。',
  },
]

/**
 * Return one canonical analysis module definition.
 * @param kind - stable capability identifier to resolve.
 * @returns shared content and assistant hand-off metadata.
 * @throws When the identifier is not present in the canonical catalog.
 */
export function analysisModule(kind: AnalysisTaskKind): AnalysisModuleDefinition {
  const definition = ANALYSIS_MODULES.find(item => item.id === kind)
  if (definition === undefined) throw new Error(`unknown analysis module: ${kind}`)
  return definition
}
