import { describe, expect, it, vi } from 'vitest'
import { AnalysisPromptTemplateController } from '../src/client/analysis-prompt-templates.ts'

describe('analysis prompt template controller', () => {
  it('为未知会话返回稳定的普通对话状态', () => {
    const controller = new AnalysisPromptTemplateController()

    expect(controller.snapshot('session-a')).toBe(controller.snapshot('session-a'))
    expect(controller.snapshot('session-a')).toEqual({ templateId: 'general' })
  })

  it('按会话隔离模板与自动草稿，并只通知对应会话', () => {
    const controller = new AnalysisPromptTemplateController()
    const onSessionA = vi.fn()
    const onSessionB = vi.fn()
    controller.subscribe('session-a', onSessionA)
    controller.subscribe('session-b', onSessionB)

    controller.set('session-a', 'stock', '个股模板')

    expect(controller.snapshot('session-a')).toEqual({
      templateId: 'stock', automaticPrompt: '个股模板',
    })
    expect(controller.snapshot('session-b')).toEqual({ templateId: 'general' })
    expect(onSessionA).toHaveBeenCalledOnce()
    expect(onSessionB).not.toHaveBeenCalled()

    controller.set('session-a', 'stock', '个股模板')
    expect(onSessionA).toHaveBeenCalledOnce()
  })
})
