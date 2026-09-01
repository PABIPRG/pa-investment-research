// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { InvestmentDataRequest } from '@deepseek-ai/dsh-client-investment-research-runtime/client'
import { KycProfilePanel } from '../src/client/KycProfilePanel.tsx'

afterEach(cleanup)

const NOT_STARTED_PROFILE = {
  status: 'not_started',
  inferred_profile: null,
  effective_profile: 'balanced',
  effective_label: '稳健型',
  tiers: { quick: ['horizon', 'loss_tolerance', 'goal'], full: ['horizon', 'loss_tolerance', 'goal', 'experience'] },
  question_bank: {
    horizon: { qid: 'horizon', title: '你计划持有这笔资金多久？', options: [{ label: '1-3年', score: 3 }, { label: '5年以上', score: 5 }] },
    loss_tolerance: { qid: 'loss_tolerance', title: '你能承受多大亏损？', options: [{ label: '10%左右', score: 3 }, { label: '20%以上', score: 5 }] },
    goal: { qid: 'goal', title: '你的投资目标是？', options: [{ label: '长期稳健增值', score: 3 }, { label: '追求高回报', score: 5 }] },
    experience: { qid: 'experience', title: '你的投资经验如何？', options: [{ label: '有3年以上经验', score: 4 }, { label: '刚开始投资', score: 1 }] },
  },
  profile_labels: { conservative: '保守型', balanced: '稳健型', aggressive: '进取型' },
}

const ADJUSTED_PROFILE = {
  ...NOT_STARTED_PROFILE,
  status: 'adjusted',
  inferred_profile: 'balanced',
  effective_profile: 'aggressive',
  effective_label: '进取型',
  score: 9,
  answers: [
    { qid: 'horizon', label: '1-3年', score: 3 },
    { qid: 'loss_tolerance', label: '10%左右', score: 3 },
    { qid: 'goal', label: '长期稳健增值', score: 3 },
  ],
  manual_adjust: { risk_tolerance: 0.8, horizon_years: 5, note: '' },
  profiles_detail: { aggressive: { risk_budget: { single_stock_weight_max: 0.4 } } },
}

function renderPanel(
  value: unknown,
  requestData = vi.fn(async (_request: InvestmentDataRequest): Promise<unknown> => ({})),
) {
  const onRetry = vi.fn()
  const onChanged = vi.fn()
  const view = render(
    <KycProfilePanel
      value={value}
      loaded
      busy={false}
      error=""
      requestData={requestData}
      onRetry={onRetry}
      onChanged={onChanged}
    />,
  )
  return { ...view, requestData, onRetry, onChanged }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => { resolve = settle })
  return { promise, resolve }
}

const panelCss = readFileSync(
  resolve(process.cwd(), 'packages/client/ui-investment-research/src/client/KycProfilePanel.module.css'),
  'utf8',
)

function cssDeclarations(selector: string): Map<string, string> {
  const withoutComments = panelCss.replace(/\/\*[\s\S]*?\*\//g, ' ')
  const declarations = new Map<string, string>()
  for (const [, selectorList = '', body = ''] of withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!selectorList.split(',').map(value => value.trim()).includes(selector)) continue
    for (const [property, value] of body.split(';').flatMap((part) => {
      const colon = part.indexOf(':')
      if (colon === -1) return []
      return [[part.slice(0, colon).trim(), part.slice(colon + 1).trim().replace(/\s+/g, ' ')] as const]
    })) declarations.set(property, value)
  }
  if (declarations.size === 0) throw new Error(`KycProfilePanel.module.css has no \`${selector}\` rule`)
  return declarations
}

describe('KYC 风险画像面板', () => {
  it('使用基础表面作为问卷弹窗底板', () => {
    expect(cssDeclarations('.dialog').get('background')).toBe('var(--dsw-alias-bg-base)')
  })

  it('保留业务层的自然语言提示字号与题组切换方向动效', () => {
    expect(cssDeclarations('.naturalAnswer label').get('font-size')).toBe('0.9286rem')
    expect(cssDeclarations(".questionList[data-direction='forward']").get('animation'))
      .toContain('questionPanelForward')
    expect(cssDeclarations(".questionList[data-direction='backward']").get('animation'))
      .toContain('questionPanelBackward')
  })

  it('未测评时明确标注系统默认来源并提供开始测评入口', () => {
    renderPanel(NOT_STARTED_PROFILE)

    expect(screen.getByText('待测评')).toBeTruthy()
    expect(screen.getByText('当前采用系统默认画像')).toBeTruthy()
    expect(screen.getByText('该画像来自系统默认值，不是问卷结论。')).toBeTruthy()
    expect(screen.getByText('稳健型')).toBeTruthy()
    expect(screen.getByRole('button', { name: '开始风险测评' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '复核画像' })).toBeNull()
  })

  it('问卷弹窗约束键盘焦点，并在忙碌时禁止关闭或继续编辑', async () => {
    const parsed = deferred<unknown>()
    const requestData = vi.fn((request: InvestmentDataRequest): Promise<unknown> => (
      request.operation === 'trading-core.kyc-parse' ? parsed.promise : Promise.resolve({})
    ))
    renderPanel(NOT_STARTED_PROFILE, requestData)

    const trigger = screen.getByRole('button', { name: '开始风险测评' })
    trigger.focus()
    fireEvent.click(trigger)
    const dialog = screen.getByRole('dialog', { name: '风险测评' })
    const close = within(dialog).getByRole('button', { name: '关闭风险测评' }) as HTMLButtonElement
    await waitFor(() => { expect(document.activeElement).toBe(close) })

    const naturalText = within(dialog).getByLabelText('用一段话描述你的投资情况') as HTMLTextAreaElement
    fireEvent.change(naturalText, { target: { value: '计划持有三年。' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '识别并填写' }))

    expect(close.disabled).toBe(true)
    expect(naturalText.disabled).toBe(true)
    expect(within(dialog).getByRole<HTMLButtonElement>('radio', { name: '完整测评 · 4 题' }).disabled).toBe(true)
    expect(within(dialog).getByRole<HTMLButtonElement>('radio', { name: '1-3年' }).disabled).toBe(true)
    fireEvent.keyDown(document, { key: 'Escape' })
    const mask = dialog.previousElementSibling as HTMLElement
    expect(mask).not.toBeNull()
    await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 0) }) })
    fireEvent.pointerDown(mask, { button: 0, ctrlKey: false })
    fireEvent.click(mask, { button: 0, ctrlKey: false })
    expect(screen.getByRole('dialog', { name: '风险测评' })).toBeTruthy()

    parsed.resolve({ answers: [{ qid: 'horizon', label: '1-3年', score: 3 }] })
    await waitFor(() => { expect(close.disabled).toBe(false) })
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => { expect(screen.queryByRole('dialog', { name: '风险测评' })).toBeNull() })
    await waitFor(() => { expect(document.activeElement).toBe(trigger) })
  })

  it('快速问卷显示进度并按 KYC 合同提交完整答案', async () => {
    const requestData = vi.fn(async (request: InvestmentDataRequest): Promise<unknown> => {
      if (request.operation === 'trading-core.kyc-questionnaire') {
        return { profile: 'balanced', label: '稳健型', score: 9, inferred_profile: 'balanced' }
      }
      return {}
    })
    const view = renderPanel(NOT_STARTED_PROFILE, requestData)

    fireEvent.click(screen.getByRole('button', { name: '开始风险测评' }))
    const dialog = screen.getByRole('dialog', { name: '风险测评' })
    expect(within(dialog).getByText('已完成 0 / 3')).toBeTruthy()
    expect(within(dialog).getByRole<HTMLButtonElement>('button', { name: '提交并应用画像' }).disabled).toBe(true)

    fireEvent.click(within(dialog).getByRole('radio', { name: '1-3年' }))
    fireEvent.click(within(dialog).getByRole('radio', { name: '10%左右' }))
    fireEvent.click(within(dialog).getByRole('radio', { name: '长期稳健增值' }))
    expect(within(dialog).getByText('已完成 3 / 3')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: '提交并应用画像' }))

    await waitFor(() => {
      expect(requestData).toHaveBeenCalledWith({
        operation: 'trading-core.kyc-questionnaire',
        input: {
          answers: [
            { qid: 'horizon', label: '1-3年', score: 3 },
            { qid: 'loss_tolerance', label: '10%左右', score: 3 },
            { qid: 'goal', label: '长期稳健增值', score: 3 },
          ],
          tier: 'quick',
          method: 'questionnaire',
        },
      })
    })
    expect(view.onChanged).toHaveBeenCalledWith('风险测评已完成，当前画像更新为稳健型。')
    expect(screen.queryByRole('dialog', { name: '风险测评' })).toBeNull()
    expect(screen.getByRole('status').textContent).toContain('风险测评已完成')
  })

  it('问卷提交失败时保留答案并允许重新提交', async () => {
    const requestData = vi.fn(async (request: InvestmentDataRequest): Promise<unknown> => {
      if (request.operation === 'trading-core.kyc-questionnaire') throw new Error('测评服务繁忙')
      return {}
    })
    const view = renderPanel(NOT_STARTED_PROFILE, requestData)

    fireEvent.click(screen.getByRole('button', { name: '开始风险测评' }))
    const dialog = screen.getByRole('dialog', { name: '风险测评' })
    for (const label of ['1-3年', '10%左右', '长期稳健增值']) {
      fireEvent.click(within(dialog).getByRole('radio', { name: label }))
    }
    fireEvent.click(within(dialog).getByRole('button', { name: '提交并应用画像' }))

    expect((await within(dialog).findByRole('alert')).textContent).toContain('提交失败：测评服务繁忙')
    expect(within(dialog).getByText('已完成 3 / 3')).toBeTruthy()
    expect(within(dialog).getByRole<HTMLButtonElement>('button', { name: '提交并应用画像' }).disabled).toBe(false)
    expect(view.onChanged).not.toHaveBeenCalled()
  })

  it('题量切换时即时确认新题数并按页签方向重置题目表单', () => {
    renderPanel(NOT_STARTED_PROFILE)

    fireEvent.click(screen.getByRole('button', { name: '开始风险测评' }))
    const dialog = screen.getByRole('dialog', { name: '风险测评' })
    const quickQuestions = within(dialog).getByRole('region', { name: '快速测评题目' })
    quickQuestions.scrollTop = 160

    fireEvent.click(within(dialog).getByRole('radio', { name: '完整测评 · 4 题' }))

    expect(within(dialog).getByRole('status', { name: '测评题量状态' }).textContent)
      .toContain('完整测评已启用 · 共 4 题')
    const fullQuestions = within(dialog).getByRole('region', { name: '完整测评题目' })
    expect(fullQuestions).not.toBe(quickQuestions)
    expect(fullQuestions.dataset.direction).toBe('forward')
    expect(fullQuestions.scrollTop).toBe(0)

    fireEvent.click(within(dialog).getByRole('radio', { name: '快速测评 · 3 题' }))

    expect(within(dialog).getByRole('status', { name: '测评题量状态' }).textContent)
      .toContain('快速测评已启用 · 共 3 题')
    expect(within(dialog).getByRole('region', { name: '快速测评题目' }).dataset.direction).toBe('backward')
  })

  it('作答和扩展题量时让同一进度指示条增长与减少', () => {
    renderPanel(NOT_STARTED_PROFILE)

    fireEvent.click(screen.getByRole('button', { name: '开始风险测评' }))
    const dialog = screen.getByRole('dialog', { name: '风险测评' })
    const progress = within(dialog).getByRole('progressbar', { name: '测评进度' })
    const indicator = progress.firstElementChild as HTMLElement

    expect(progress.getAttribute('aria-valuenow')).toBe('0')
    expect(progress.getAttribute('aria-valuemax')).toBe('3')
    expect(indicator.style.transform).toBe('scaleX(0)')

    fireEvent.click(within(dialog).getByRole('radio', { name: '1-3年' }))
    expect(progress.getAttribute('aria-valuenow')).toBe('1')
    expect(indicator.style.transform).toBe('scaleX(0.3333333333333333)')

    fireEvent.click(within(dialog).getByRole('radio', { name: '完整测评 · 4 题' }))
    expect(progress.getAttribute('aria-valuenow')).toBe('1')
    expect(progress.getAttribute('aria-valuemax')).toBe('4')
    expect(indicator.style.transform).toBe('scaleX(0.25)')
  })

  it('切换完整测评后按 full 题组计算进度并提交', async () => {
    const requestData = vi.fn(async (request: InvestmentDataRequest): Promise<unknown> => {
      if (request.operation === 'trading-core.kyc-questionnaire') {
        return { profile: 'balanced', label: '稳健型', score: 13, inferred_profile: 'balanced' }
      }
      return {}
    })
    renderPanel(NOT_STARTED_PROFILE, requestData)

    fireEvent.click(screen.getByRole('button', { name: '开始风险测评' }))
    fireEvent.click(screen.getByRole('radio', { name: '完整测评 · 4 题' }))
    const dialog = screen.getByRole('dialog', { name: '风险测评' })
    expect(within(dialog).getByText('已完成 0 / 4')).toBeTruthy()

    for (const label of ['1-3年', '10%左右', '长期稳健增值', '有3年以上经验']) {
      fireEvent.click(within(dialog).getByRole('radio', { name: label }))
    }
    fireEvent.click(within(dialog).getByRole('button', { name: '提交并应用画像' }))

    await waitFor(() => {
      expect(requestData).toHaveBeenCalledWith({
        operation: 'trading-core.kyc-questionnaire',
        input: {
          answers: [
            { qid: 'horizon', label: '1-3年', score: 3 },
            { qid: 'loss_tolerance', label: '10%左右', score: 3 },
            { qid: 'goal', label: '长期稳健增值', score: 3 },
            { qid: 'experience', label: '有3年以上经验', score: 4 },
          ],
          tier: 'full',
          method: 'questionnaire',
        },
      })
    })
  })

  it('把自然语言解析结果预填到问卷并保留最终确认', async () => {
    const requestData = vi.fn(async (request: InvestmentDataRequest): Promise<unknown> => {
      if (request.operation === 'trading-core.kyc-parse') {
        return {
          answers: [
            { qid: 'horizon', label: '1-3年', score: 3 },
            { qid: 'loss_tolerance', label: '10%左右', score: 3 },
            { qid: 'goal', label: '长期稳健增值', score: 3 },
          ],
          source: 'rules',
        }
      }
      return {}
    })
    renderPanel(NOT_STARTED_PROFILE, requestData)

    fireEvent.click(screen.getByRole('button', { name: '开始风险测评' }))
    const dialog = screen.getByRole('dialog', { name: '风险测评' })
    fireEvent.change(within(dialog).getByLabelText('用一段话描述你的投资情况'), {
      target: { value: '计划持有一到三年，可以承受约 10% 回撤，希望长期稳健增值。' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: '识别并填写' }))

    await waitFor(() => {
      expect(requestData).toHaveBeenCalledWith({
        operation: 'trading-core.kyc-parse',
        input: { text: '计划持有一到三年，可以承受约 10% 回撤，希望长期稳健增值。' },
      })
    })
    expect(within(dialog).getByRole('radio', { name: '1-3年' }).getAttribute('aria-checked')).toBe('true')
    expect(within(dialog).getByRole('radio', { name: '10%左右' }).getAttribute('aria-checked')).toBe('true')
    expect(within(dialog).getByRole('radio', { name: '长期稳健增值' }).getAttribute('aria-checked')).toBe('true')
    expect(within(dialog).getByText('已完成 3 / 3')).toBeTruthy()
    expect(requestData).not.toHaveBeenCalledWith(expect.objectContaining({ operation: 'trading-core.kyc-questionnaire' }))
  })

  it('自然语言识别失败时保留原文并允许重试', async () => {
    const requestData = vi.fn(async (request: InvestmentDataRequest): Promise<unknown> => {
      if (request.operation === 'trading-core.kyc-parse') throw new Error('暂时无法识别这段描述')
      return {}
    })
    renderPanel(NOT_STARTED_PROFILE, requestData)

    fireEvent.click(screen.getByRole('button', { name: '开始风险测评' }))
    const dialog = screen.getByRole('dialog', { name: '风险测评' })
    const input = within(dialog).getByLabelText('用一段话描述你的投资情况') as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: '我可以承受约 10% 的回撤。' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '识别并填写' }))

    expect((await within(dialog).findByRole('alert')).textContent).toContain('识别失败：暂时无法识别这段描述')
    expect(input.value).toBe('我可以承受约 10% 的回撤。')
    expect(within(dialog).getByRole<HTMLButtonElement>('button', { name: '识别并填写' }).disabled).toBe(false)
  })

  it('自然语言没有识别出当前题组答案时给出可恢复提示', async () => {
    const requestData = vi.fn(async (request: InvestmentDataRequest): Promise<unknown> => (
      request.operation === 'trading-core.kyc-parse' ? { answers: [], source: 'rules' } : {}
    ))
    renderPanel(NOT_STARTED_PROFILE, requestData)

    fireEvent.click(screen.getByRole('button', { name: '开始风险测评' }))
    const dialog = screen.getByRole('dialog', { name: '风险测评' })
    const input = within(dialog).getByLabelText('用一段话描述你的投资情况') as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: '暂时没有更多信息。' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '识别并填写' }))

    expect((await within(dialog).findByRole('alert')).textContent).toContain('识别失败：没有识别出可填写的问卷答案，请补充投资期限、亏损承受度或投资目标后重试。')
    expect(input.value).toBe('暂时没有更多信息。')
    expect(within(dialog).getByText('已完成 0 / 3')).toBeTruthy()
  })

  it('完成后区分问卷推断与生效画像并展示依据和护栏', () => {
    renderPanel(ADJUSTED_PROFILE)
    const panel = screen.getByRole('region', { name: 'KYC 风险画像' })

    expect(within(panel).getByText('已微调')).toBeTruthy()
    expect(within(panel).getByText('问卷推断')).toBeTruthy()
    expect(within(panel).getByText('稳健型')).toBeTruthy()
    expect(within(panel).getByText('当前生效')).toBeTruthy()
    expect(within(panel).getByText('进取型')).toBeTruthy()
    expect(within(panel).getByText('测评依据')).toBeTruthy()
    expect(within(panel).getByText('问卷 3 项 · 得分 9')).toBeTruthy()
    expect(within(panel).getByText('单股预算上限')).toBeTruthy()
    expect(within(panel).getByText('40.0%')).toBeTruthy()
    expect(within(panel).getByRole('button', { name: '重做风险测评' })).toBeTruthy()
    expect(within(panel).getByRole('button', { name: '复核画像' })).toBeTruthy()
  })

  it('重做风险测评时带入既有问卷答案供用户复核', () => {
    renderPanel(ADJUSTED_PROFILE)

    fireEvent.click(screen.getByRole('button', { name: '重做风险测评' }))
    const dialog = screen.getByRole('dialog', { name: '风险测评' })

    expect(within(dialog).getByText('已完成 3 / 3')).toBeTruthy()
    expect(within(dialog).getByRole('radio', { name: '1-3年' }).getAttribute('aria-checked')).toBe('true')
    expect(within(dialog).getByRole('radio', { name: '10%左右' }).getAttribute('aria-checked')).toBe('true')
    expect(within(dialog).getByRole('radio', { name: '长期稳健增值' }).getAttribute('aria-checked')).toBe('true')
  })

  it('复核画像支持取消，并在确认后提交受控调整', async () => {
    const requestData = vi.fn(async (request: InvestmentDataRequest): Promise<unknown> => {
      if (request.operation === 'trading-core.kyc-adjust') {
        return { profile: 'aggressive', label: '进取型' }
      }
      return {}
    })
    const view = renderPanel(ADJUSTED_PROFILE, requestData)

    fireEvent.click(screen.getByRole('button', { name: '复核画像' }))
    let dialog = screen.getByRole('dialog', { name: '复核风险画像' })
    expect(within(dialog).getByText('确认后会更新当前生效画像，问卷推断仍保留为稳健型。')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('dialog', { name: '复核风险画像' })).toBeNull()
    expect(requestData).not.toHaveBeenCalledWith(expect.objectContaining({ operation: 'trading-core.kyc-adjust' }))

    fireEvent.click(screen.getByRole('button', { name: '复核画像' }))
    dialog = screen.getByRole('dialog', { name: '复核风险画像' })
    fireEvent.change(within(dialog).getByLabelText('风险承受度'), { target: { value: '0.7' } })
    fireEvent.change(within(dialog).getByLabelText('计划投资期限'), { target: { value: '4' } })
    fireEvent.change(within(dialog).getByLabelText('调整说明（选填）'), { target: { value: '家庭现金流更稳定' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '确认并应用' }))

    await waitFor(() => {
      expect(requestData).toHaveBeenCalledWith({
        operation: 'trading-core.kyc-adjust',
        input: { risk_tolerance: 0.7, horizon_years: 4, note: '家庭现金流更稳定' },
      })
    })
    expect(view.onChanged).toHaveBeenCalledWith('画像复核已应用，当前画像为进取型。')
    expect(screen.queryByRole('dialog', { name: '复核风险画像' })).toBeNull()
    expect(screen.getByRole('status').textContent).toContain('画像复核已应用')
  })

  it('画像调整失败时保留复核内容且不触发联动刷新', async () => {
    const requestData = vi.fn(async (request: InvestmentDataRequest): Promise<unknown> => {
      if (request.operation === 'trading-core.kyc-adjust') throw new Error('画像服务正在恢复')
      return {}
    })
    const view = renderPanel(ADJUSTED_PROFILE, requestData)

    fireEvent.click(screen.getByRole('button', { name: '复核画像' }))
    const dialog = screen.getByRole('dialog', { name: '复核风险画像' })
    const note = within(dialog).getByLabelText('调整说明（选填）') as HTMLTextAreaElement
    fireEvent.change(note, { target: { value: '等服务恢复后再确认' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '确认并应用' }))

    expect((await within(dialog).findByRole('alert')).textContent).toContain('应用失败：画像服务正在恢复')
    expect(note.value).toBe('等服务恢复后再确认')
    expect(within(dialog).getByRole<HTMLButtonElement>('button', { name: '确认并应用' }).disabled).toBe(false)
    expect(view.onChanged).not.toHaveBeenCalled()
  })

  it('画像调整提交中冻结表单并阻止关闭', async () => {
    const adjusted = deferred<unknown>()
    const requestData = vi.fn((request: InvestmentDataRequest): Promise<unknown> => (
      request.operation === 'trading-core.kyc-adjust' ? adjusted.promise : Promise.resolve({})
    ))
    const view = renderPanel(ADJUSTED_PROFILE, requestData)

    const trigger = screen.getByRole('button', { name: '复核画像' })
    trigger.focus()
    fireEvent.click(trigger)
    const dialog = screen.getByRole('dialog', { name: '复核风险画像' })
    const close = within(dialog).getByRole('button', { name: '关闭画像复核' }) as HTMLButtonElement
    await waitFor(() => { expect(document.activeElement).toBe(close) })
    fireEvent.click(within(dialog).getByRole('button', { name: '确认并应用' }))

    expect(close.disabled).toBe(true)
    expect(within(dialog).getByLabelText<HTMLInputElement>('风险承受度').disabled).toBe(true)
    expect(within(dialog).getByLabelText<HTMLInputElement>('计划投资期限').disabled).toBe(true)
    expect(within(dialog).getByLabelText<HTMLTextAreaElement>('调整说明（选填）').disabled).toBe(true)
    fireEvent.keyDown(document, { key: 'Escape' })
    const overlay = dialog.previousElementSibling as HTMLElement
    expect(overlay).not.toBeNull()
    await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 0) }) })
    fireEvent.pointerDown(overlay, { button: 0, ctrlKey: false })
    fireEvent.click(overlay, { button: 0, ctrlKey: false })
    expect(screen.getByRole('dialog', { name: '复核风险画像' })).toBeTruthy()

    adjusted.resolve({ profile: 'aggressive', label: '进取型' })
    await waitFor(() => { expect(screen.queryByRole('dialog', { name: '复核风险画像' })).toBeNull() })
    expect(view.onChanged).toHaveBeenCalledWith('画像复核已应用，当前画像为进取型。')
    await waitFor(() => { expect(document.activeElement).toBe(trigger) })
  })
})
