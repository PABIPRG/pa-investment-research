// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { buildIndustryChainAssistantContext, IndustryChainPage } from '../src/client/IndustryChainPage.tsx'

afterEach(cleanup)

type RequestData = ComponentProps<typeof IndustryChainPage>['requestData']
type AskAssistant = ComponentProps<typeof IndustryChainPage>['onAskAssistant']

describe('产业链页面', () => {
  it('为投研助理构造有界、带来源与证据口径的业务数据快照', () => {
    const context = buildIndustryChainAssistantContext({
      intent: 'network-slice',
      selected: { code: '688981', name: '中芯国际', market: 'SH' },
      selectedNode: undefined,
      profile: {
        code: '688981', name: '中芯国际', industry: '半导体', supplier_count: 2,
        metrics: [{ label: '毛利率', value: '20%' }],
      },
      single: {
        company: { code: '688981', name: '中芯国际' },
        suppliers: [{ id: 's1', name: '北方华创', type: 'direct', share: 20, note: '研报明确提及' }],
      },
      expanded: { center: { code: '688981' }, up_levels: [{ level: -1, nodes: [{ id: 's1', name: '北方华创', via: '刻蚀设备' }] }] },
      network: {
        nodes: [{ id: 'cn-688981', code: '688981', name: '中芯国际', degree: 48 }],
        links: [{ source: 'cn-688981', target: 'cn-002371', kind: 'supplier', type: 'direct', share: 15, item: '设备' }],
        stats: { total_nodes: 100, relationships: 200 },
        macro_communities: [{ macroId: 1, name: '半导体', size: 20 }],
      },
      entity: undefined,
      parameters: {
        depthUp: 2, depthDown: 2, topUp: 3, topDown: 2,
        minDegree: 3, minMarketCap: 0, minShare: 10, subjectOnly: false, includeUniverse: false,
      },
    })

    expect(context).toMatchObject({
      schema: 'investment-research/industry-chain-context@1',
      intent: 'network-slice',
      subject: { code: '688981', name: '中芯国际' },
      query_parameters: { depthUp: 2, minDegree: 3, minShare: 10 },
      provenance: {
        company_profile: 'industry-chain company profile',
        network_slice: 'industry-chain server-filtered network',
      },
    })
    expect(JSON.stringify(context)).toContain('研报明确提及')
    expect(JSON.stringify(context)).toContain('cn-002371')
    expect(JSON.stringify(context)).not.toContain('init_x')
  })

  it('使用真实证券搜索选择标的并清空搜索输入', async () => {
    const requestData = vi.fn<RequestData>((request) => {
      if (request.operation === 'industry-chain.companies') {
        return Promise.resolve({ items: [{ code: '688981', name: '中芯国际', exchange: 'SH', industry: '半导体' }] })
      }
      if (request.operation === 'industry-chain.company') {
        return Promise.resolve({ code: '688981', name: '中芯国际', industry: '半导体', supplier_count: 1 })
      }
      return Promise.resolve({
        company: { code: '688981', name: '中芯国际', industry: '半导体' },
        suppliers: [{ id: 'supplier-1', name: '北方华创', share: 22 }],
        materials: [], products: [], customers: [],
      })
    })
    render(<IndustryChainPage requestData={requestData} onAskAssistant={() => {}} />)

    const input = screen.getByRole('searchbox', { name: '搜索公司、代码或行业' })
    fireEvent.change(input, { target: { value: '中芯国际' } })
    fireEvent.submit(input.closest('form')!)

    const option = await screen.findByRole('option', { name: /中芯国际/ })
    expect(requestData).toHaveBeenCalledWith({
      operation: 'industry-chain.companies', input: { keyword: '中芯国际', limit: 8 },
    })
    fireEvent.click(option)

    expect(input.getAttribute('value')).toBe('')
    expect(screen.getByText('中芯国际五列产业链')).toBeTruthy()
    expect(await screen.findByRole('button', { name: /中芯国际/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /北方华创/ })).toBeTruthy()
    expect(requestData).toHaveBeenCalledWith({ operation: 'industry-chain.company', input: { code: '688981' } })
    expect(requestData).toHaveBeenCalledWith({ operation: 'industry-chain.single', input: { code: '688981' } })
  })

  it('按页面参数读取真实多层链路并把解读交给投研助理', async () => {
    const onAskAssistant = vi.fn<AskAssistant>()
    const requestData = vi.fn<RequestData>((request) => {
      if (request.operation === 'industry-chain.companies') {
        return Promise.resolve({ items: [{ code: '688981', name: '中芯国际', exchange: 'SH', industry: '半导体' }] })
      }
      if (request.operation === 'industry-chain.chain') {
        return Promise.resolve({ center: { code: '688981', name: '中芯国际' }, up_levels: [{ level: -1, nodes: [{ id: 'u1', name: '上游节点' }] }], down_levels: [] })
      }
      if (request.operation === 'industry-chain.single') {
        return Promise.resolve({ company: { code: '688981', name: '中芯国际' }, suppliers: [], materials: [], products: [], customers: [] })
      }
      return Promise.resolve({ code: '688981', name: '中芯国际' })
    })
    render(<IndustryChainPage requestData={requestData} onAskAssistant={onAskAssistant} />)

    const input = screen.getByRole('searchbox', { name: '搜索公司、代码或行业' })
    fireEvent.change(input, { target: { value: '688981' } })
    fireEvent.submit(input.closest('form')!)
    fireEvent.click(await screen.findByRole('option', { name: /中芯国际/ }))
    fireEvent.change(screen.getByLabelText('上游深度'), { target: { value: '3' } })
    fireEvent.change(screen.getByLabelText('每层下游节点数'), { target: { value: '5' } })
    fireEvent.click(screen.getByRole('button', { name: '展开上下游' }))

    await waitFor(() => {
      expect(requestData).toHaveBeenCalledWith({
        operation: 'industry-chain.chain',
        input: { code: '688981', depth_up: 3, depth_down: 2, top_up: 3, top_down: 5 },
      })
    })
    expect(await screen.findByRole('button', { name: '上游节点' })).toBeTruthy()
    expect(onAskAssistant).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '五列链路' }))
    fireEvent.click(screen.getByRole('button', { name: '让投研助理解读链路' }))
    const action = onAskAssistant.mock.calls[0]?.[0]
    expect(typeof action).toBe('object')
    if (typeof action === 'string' || action === undefined) throw new Error('expected structured assistant action')
    expect(action.intent).toBe('industry-chain-interpret')
    expect(action.module).toBe('chain')
    expect(action.question).toContain('中芯国际（688981）')
    expect(action.data).toMatchObject({
      schema: 'investment-research/industry-chain-context@1',
      subject: { code: '688981', name: '中芯国际', market: 'SH' },
    })
  })

  it('切换五列、多层和网络视图，只有真实网络数据加载后才允许解读', async () => {
    const onAskAssistant = vi.fn<AskAssistant>()
    render(<IndustryChainPage requestData={() => Promise.resolve({ items: [] })} onAskAssistant={onAskAssistant} />)

    fireEvent.click(screen.getByRole('button', { name: '多层展开' }))
    expect(screen.getByText('多层产业链')).toBeTruthy()
    expect(screen.getByRole('button', { name: '按当前参数查询' }).hasAttribute('disabled')).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: '网络切片' }))
    const interpret = screen.getByRole<HTMLButtonElement>('button', { name: '让投研助理解读' })
    expect(interpret.disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '刷新网络切片' }))
    await waitFor(() => { expect(interpret.disabled).toBe(false) })
    fireEvent.click(interpret)
    const action = onAskAssistant.mock.calls[0]?.[0]
    expect(typeof action).toBe('object')
    if (typeof action === 'string' || action === undefined) throw new Error('expected structured assistant action')
    expect(action.intent).toBe('industry-chain-interpret')
    expect(action.module).toBe('chain')
    expect(action.data).toMatchObject({ intent: 'network-slice' })

    fireEvent.click(screen.getByRole('button', { name: '五列链路' }))
    expect(screen.getByText('先搜索并选择公司，页面会固定研究标的并保留后续探索参数。')).toBeTruthy()
  })

  it('处理无结果和搜索失败', async () => {
    const requestData = vi.fn<RequestData>()
      .mockResolvedValueOnce({ items: [] })
      .mockRejectedValueOnce(new Error('offline'))
    render(<IndustryChainPage requestData={requestData} onAskAssistant={() => {}} />)

    const input = screen.getByRole('searchbox', { name: '搜索公司、代码或行业' })
    fireEvent.change(input, { target: { value: '不存在公司' } })
    fireEvent.submit(input.closest('form')!)
    expect(await screen.findByText('没有找到匹配标的，请尝试完整公司名或证券代码。')).toBeTruthy()

    fireEvent.change(input, { target: { value: '中芯国际' } })
    fireEvent.submit(input.closest('form')!)
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toContain('公司搜索暂不可用') })
  })
})
