/** A typed UI intent is converted to a short model-facing instruction at the boundary. */
export type AssistantIntent =
  | { readonly kind: 'stock'; readonly code: string; readonly name?: string }
  | { readonly kind: 'portfolio'; readonly focus?: string }
  | { readonly kind: 'watch'; readonly code?: string }
  | { readonly kind: 'strategy'; readonly strategyId?: string }
  | { readonly kind: 'shadow'; readonly strategyId?: string }
  | { readonly kind: 'evolution'; readonly strategyId?: string }
  | { readonly kind: 'reports'; readonly reportId?: string }
  | { readonly kind: 'industry'; readonly reference?: string }
  | { readonly kind: 'prompt'; readonly prompt: string }

function subject(code: string, name?: string): string {
  const cleanCode = code.trim()
  const cleanName = name?.trim()
  return cleanName === undefined || cleanName === '' ? cleanCode : `${cleanName}（${cleanCode}）`
}

/**
 * Keep context out of the composer. The model receives a concise instruction
 * and reads current product state through the corresponding tool when needed.
 */
export function assistantPrompt(intent: AssistantIntent): string {
  if (intent.kind === 'prompt') return intent.prompt.trim()
  if (intent.kind === 'stock') {
    return `请调用 analyze_stock 工具，对 ${subject(intent.code, intent.name)} 做完整投研分析，并明确核心逻辑、风险与后续观察信号。`
  }
  if (intent.kind === 'portfolio') {
    const focus = intent.focus?.trim()
    return `请先调用 investment_context 工具读取 portfolio 上下文，再调用 analyze_holdings 分析当前真实持仓${focus === undefined || focus === '' ? '，重点评估集中度、回撤风险与优先动作。' : `，重点回答：${focus}`}`
  }
  if (intent.kind === 'watch') {
    const target = intent.code?.trim()
    return target === undefined || target === ''
      ? '请调用 watch_overview 工具读取当前盘面，再结合 scan_movers 与 news_flash 梳理最值得跟踪的异动、催化和风险。'
      : `请调用 tech_signal 与 news_events 工具盯盘 ${target}，说明当前异动、触发原因和需要继续观察的信号。`
  }
  if (intent.kind === 'strategy') {
    const target = intent.strategyId?.trim()
    return `请调用 investment_context 工具读取 strategy 上下文，评审${target === undefined || target === '' ? '当前策略池' : `策略 ${target}`}的投资假设、样本外证据和进入影子验证前的风险。`
  }
  if (intent.kind === 'shadow') {
    const target = intent.strategyId?.trim()
    return `请调用 investment_context 工具读取 shadow 上下文，解释${target === undefined || target === '' ? '当前影子验证结果' : `策略 ${target} 的影子验证结果`}，并给出继续验证、退回研究或进入进化观察的建议。`
  }
  if (intent.kind === 'evolution') {
    const target = intent.strategyId?.trim()
    return target === undefined || target === ''
      ? '请调用 investment_context 工具读取 evolution 上下文，解释闭环状态、生命周期、策略判定和最近自动动作；只解释现有证据，不请求写入。'
      : `请调用 investment_context 工具读取 evolution 上下文，并把 strategy_id 设为 ${target}，解释策略 ${target} 的证据、预计判定和自动进化历史；下一次统一自动闭环会按届时最新证据重新判定，不请求写入。`
  }
  if (intent.kind === 'reports') {
    const target = intent.reportId?.trim()
    return target === undefined || target === ''
      ? '请调用 investment_context 工具读取 reports 上下文，归纳近期正式投研报告并指出结论冲突或待验证项。'
      : `请调用 investment_context 工具读取 reports 上下文，并把 reference 设为报告 ID ${target}，复核该报告的结论、证据与后续动作。`
  }
  const reference = intent.reference?.trim()
  return `请调用 investment_context 工具读取 industry 上下文，解释${reference === undefined || reference === '' ? '当前事件的产业链传导、受益与受损环节。' : `“${reference}”相关事件的产业链传导、受益与受损环节。`}`
}
