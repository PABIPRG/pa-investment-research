import { describe, expect, it } from 'vitest'
import { assistantPrompt, type AssistantIntent } from '../src/client/assistant-intent.ts'

describe('assistantPrompt', () => {
  it.each<readonly [AssistantIntent, string]>([
    [{ kind: 'portfolio' }, 'investment_context 工具读取 portfolio 上下文'],
    [{ kind: 'strategy', strategyId: 'strategy-1' }, 'investment_context 工具读取 strategy 上下文'],
    [{ kind: 'shadow', strategyId: 'strategy-1' }, 'investment_context 工具读取 shadow 上下文'],
    [{ kind: 'evolution' }, 'investment_context 工具读取 evolution 上下文'],
    [{ kind: 'evolution', strategyId: 'strategy-1' }, '策略 strategy-1 的证据、预计判定和自动进化历史'],
    [{ kind: 'reports', reportId: 'a'.repeat(32) }, `reference 设为报告 ID ${'a'.repeat(32)}`],
    [{ kind: 'industry', reference: '半导体' }, 'investment_context 工具读取 industry 上下文'],
  ])('asks the model to read product context through a tool for %o', (intent, expected) => {
    const prompt = assistantPrompt(intent)
    expect(prompt).toContain(expected)
    expect(prompt).not.toContain('{')
    expect(prompt).not.toContain('}')
    expect(prompt).not.toContain('"kind"')
  })

  it('uses stock and watch tools instead of serializing UI state into the composer', () => {
    expect(assistantPrompt({ kind: 'stock', code: ' 600519 ', name: ' 贵州茅台 ' }))
      .toContain('调用 analyze_stock 工具，对 贵州茅台（600519）')
    expect(assistantPrompt({ kind: 'watch', code: '000001' }))
      .toContain('调用 tech_signal 与 news_events 工具盯盘 000001')
  })

  it('keeps global and scoped evolution explanations read-only', () => {
    const globalPrompt = assistantPrompt({ kind: 'evolution' })
    const scopedPrompt = assistantPrompt({ kind: 'evolution', strategyId: 'strategy-1' })
    expect(globalPrompt).toContain('闭环状态、生命周期、策略判定和最近自动动作')
    expect(scopedPrompt).toContain('下一次统一自动闭环')
    expect(globalPrompt).not.toContain('人工应用')
    expect(scopedPrompt).not.toContain('人工应用')
  })
})
