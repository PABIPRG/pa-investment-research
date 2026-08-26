import { useRef, useState } from 'react'
import type { FormEvent } from 'react'
import type { InvestmentDataRequest } from '@deepseek-ai/dsh-client-investment-research-runtime/client'
import { asRecord, number, records, text } from './data.ts'
import type { InvestmentAssistantActionInput } from './assistant-context.ts'
import css from './IndustryChainPage.module.css'

type RequestData = (request: InvestmentDataRequest) => Promise<unknown>
type ChainView = 'single' | 'expanded' | 'network'

export interface SecurityCandidate {
  readonly code: string
  readonly name: string
  readonly market: string
}

interface ResourceState {
  readonly value: unknown
  readonly loading: boolean
  readonly loaded: boolean
  readonly error: string
}

const EMPTY_RESOURCE: ResourceState = { value: undefined, loading: false, loaded: false, error: '' }

function securityCandidates(value: unknown): SecurityCandidate[] {
  return records(asRecord(value).items).flatMap((item) => {
    const code = text(item.code, '')
    if (code === '') return []
    return [{ code, name: text(item.name, code), market: text(item.exchange, text(item.industry, '')) }]
  })
}

const COLUMN_LABELS = ['供应商', '原材料 / 设备', '研究标的', '主营产品', '下游客户 / 应用'] as const

export interface IndustryChainAssistantContextInput {
  readonly intent: 'single-chain' | 'expanded-chain' | 'network-slice' | 'entity-research'
  readonly selected: SecurityCandidate | undefined
  readonly selectedNode: Record<string, unknown> | undefined
  readonly profile: unknown
  readonly single: unknown
  readonly expanded: unknown
  readonly network: unknown
  readonly entity: unknown
  readonly parameters: {
    readonly depthUp: number
    readonly depthDown: number
    readonly topUp: number
    readonly topDown: number
    readonly minDegree: number
    readonly minMarketCap: number
    readonly minShare: number
    readonly subjectOnly: boolean
    readonly includeUniverse: boolean
  }
}

function selectedFields(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const source = asRecord(value)
  return Object.fromEntries(keys.flatMap((key) => {
    const candidate = source[key]
    return candidate === undefined || candidate === null || candidate === '' ? [] : [[key, candidate]]
  }))
}

function compactNode(value: unknown): Record<string, unknown> {
  return selectedFields(value, [
    'id', 'code', 'name', 'industry', 'board', 'is_subject', 'role', 'tier',
    'market_cap_cny', 'market_cap', 'degree', 'upCount', 'downCount', 'macroId', 'macroName',
    'company_code', 'company_name', 'relation', 'item', 'type', 'share', 'confidence',
    'via', 'vias', 'note', 'parent_id', 'depth',
  ])
}

function compactCompany(value: unknown): Record<string, unknown> {
  const company = asRecord(value)
  return {
    ...selectedFields(company, [
      'id', 'code', 'name', 'industry', 'desc', 'is_subject', 'market_cap_cny',
      'market_cap_display', 'stock_price', 'material_count', 'product_count',
      'supplier_count', 'customer_count', 'board', 'source', 'note', 'appearance_count',
    ]),
    metrics: records(company.metrics).slice(0, 12).map(item => selectedFields(item, ['label', 'value'])),
    related: records(company.related).slice(0, 12).map(item => selectedFields(item, ['name', 'code', 'relation', 'note'])),
  }
}

function compactEntity(value: unknown): Record<string, unknown> {
  const entity = asRecord(value)
  return {
    ...compactCompany(entity),
    as_supplier: records(entity.as_supplier).slice(0, 12).map(compactNode),
    as_customer: records(entity.as_customer).slice(0, 12).map(compactNode),
    report_materials: records(entity.report_materials).slice(0, 12).map(compactNode),
    report_products: records(entity.report_products).slice(0, 12).map(compactNode),
  }
}

function compactSingle(value: unknown): Record<string, unknown> {
  const single = asRecord(value)
  return {
    company: compactCompany(single.company),
    suppliers: records(single.suppliers).slice(0, 12).map(compactNode),
    materials: records(single.materials).slice(0, 12).map(compactNode),
    products: records(single.products).slice(0, 12).map(compactNode),
    customers: records(single.customers).slice(0, 12).map(compactNode),
  }
}

function compactExpanded(value: unknown): Record<string, unknown> {
  const expanded = asRecord(value)
  const levels = (rows: unknown): Record<string, unknown>[] => records(rows).slice(0, 3).map(level => ({
    level: number(level.level) ?? null,
    nodes: records(level.nodes).slice(0, 8).map(compactNode),
  }))
  return {
    center: compactCompany(expanded.center),
    up_levels: levels(expanded.up_levels),
    down_levels: levels(expanded.down_levels),
  }
}

function compactNetwork(value: unknown, selectedCode: string): Record<string, unknown> {
  const network = asRecord(value)
  const nodes = records(network.nodes)
    .sort((left, right) => (number(right.degree) ?? 0) - (number(left.degree) ?? 0))
    .slice(0, 16)
    .map(compactNode)
  const links = records(network.links)
  const subjectLinks = selectedCode === '' ? [] : links.filter((link) => {
    const source = text(link.source, '')
    const target = text(link.target, '')
    return source.includes(selectedCode) || target.includes(selectedCode)
  })
  return {
    returned_node_count: records(network.nodes).length,
    returned_link_count: links.length,
    stats: selectedFields(network.stats, [
      'total_nodes', 'total_edges', 'total_links', 'companies', 'items', 'relationships',
      'macro_communities', 'macro_communities_count', 'subject_count', 'universe_mode',
    ]),
    high_degree_nodes: nodes,
    relevant_links: (subjectLinks.length > 0 ? subjectLinks : links).slice(0, 16).map(link => selectedFields(link, [
      'source', 'target', 'kind', 'type', 'share', 'item', 'count', 'confidence', 'note',
    ])),
    macro_communities: records(network.macro_communities).slice(0, 12).map(item => selectedFields(item, [
      'macroId', 'name', 'size', 'industry',
    ])),
  }
}

/** Build a bounded JSON-safe snapshot of backend business data for investment reasoning. */
export function buildIndustryChainAssistantContext(input: IndustryChainAssistantContextInput): Record<string, unknown> {
  const selectedCode = input.selected?.code ?? ''
  return {
    schema: 'investment-research/industry-chain-context@1',
    intent: input.intent,
    subject: input.selected === undefined ? null : {
      code: input.selected.code,
      name: input.selected.name,
      market: input.selected.market,
    },
    selected_entity: compactEntity(input.entity ?? input.selectedNode),
    query_parameters: input.parameters,
    datasets: {
      company_profile: compactCompany(input.profile),
      single_chain: compactSingle(input.single),
      expanded_chain: compactExpanded(input.expanded),
      network_slice: compactNetwork(input.network, selectedCode),
    },
    provenance: {
      company_profile: input.profile === undefined ? 'not_loaded' : 'industry-chain company profile',
      single_chain: input.single === undefined ? 'not_loaded' : 'industry-chain five-column graph',
      expanded_chain: input.expanded === undefined ? 'not_loaded' : 'industry-chain bounded BFS graph',
      network_slice: input.network === undefined ? 'not_loaded' : 'industry-chain server-filtered network',
      selected_entity: (input.entity ?? input.selectedNode) === undefined ? 'not_loaded' : 'industry-chain entity profile',
    },
    field_semantics: {
      type: 'direct 表示直接关系，inferred 表示推断关系',
      share: '供应链权重百分比；部分缺失关系会由后端按方向给默认值，需结合 note 与 confidence 判断',
      note: '研报或关系的短依据；为空表示当前数据未提供文字依据',
      via_or_vias: '关系经过的原材料、设备、产品或业务',
      confidence: '推断关系置信度；为空不代表高置信度',
    },
  }
}

/** Industry-chain workspace with real security selection and page-local exploration state. */
export function IndustryChainPage({ requestData, onAskAssistant }: {
  requestData: RequestData
  onAskAssistant: (input: InvestmentAssistantActionInput) => void
}) {
  const [query, setQuery] = useState('')
  const [candidates, setCandidates] = useState<SecurityCandidate[]>([])
  const [selected, setSelected] = useState<SecurityCandidate>()
  const [selectedNode, setSelectedNode] = useState<Record<string, unknown>>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [searched, setSearched] = useState(false)
  const [view, setView] = useState<ChainView>('single')
  const [depthUp, setDepthUp] = useState(2)
  const [depthDown, setDepthDown] = useState(2)
  const [topUp, setTopUp] = useState(3)
  const [topDown, setTopDown] = useState(2)
  const [profile, setProfile] = useState<ResourceState>(EMPTY_RESOURCE)
  const [single, setSingle] = useState<ResourceState>(EMPTY_RESOURCE)
  const [expanded, setExpanded] = useState<ResourceState>(EMPTY_RESOURCE)
  const [network, setNetwork] = useState<ResourceState>(EMPTY_RESOURCE)
  const [entity, setEntity] = useState<ResourceState>(EMPTY_RESOURCE)
  const searchRun = useRef(0)
  const companyRun = useRef(0)
  const entityRun = useRef(0)

  const search = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const keyword = query.trim()
    if (keyword === '') return
    const run = searchRun.current + 1
    searchRun.current = run
    setLoading(true)
    setError('')
    setSearched(true)
    void requestData({
      operation: 'industry-chain.companies',
      input: { keyword, limit: 8 },
    }).then((value) => {
      if (searchRun.current !== run) return
      setCandidates(securityCandidates(value))
      setLoading(false)
    }, () => {
      if (searchRun.current !== run) return
      setCandidates([])
      setError('公司搜索暂不可用，请稍后重试。')
      setLoading(false)
    })
  }

  const loadCompany = (candidate: SecurityCandidate): void => {
    const run = companyRun.current + 1
    companyRun.current = run
    setProfile({ value: undefined, loading: true, loaded: false, error: '' })
    setSingle({ value: undefined, loading: true, loaded: false, error: '' })
    void Promise.allSettled([
      requestData({ operation: 'industry-chain.company', input: { code: candidate.code } }),
      requestData({ operation: 'industry-chain.single', input: { code: candidate.code } }),
    ]).then(([profileResult, singleResult]) => {
      if (companyRun.current !== run) return
      setProfile(profileResult.status === 'fulfilled'
        ? { value: profileResult.value, loading: false, loaded: true, error: '' }
        : { value: undefined, loading: false, loaded: false, error: '公司档案暂不可用。' })
      setSingle(singleResult.status === 'fulfilled'
        ? { value: singleResult.value, loading: false, loaded: true, error: '' }
        : { value: undefined, loading: false, loaded: false, error: '五列产业链暂不可用。' })
    })
  }

  const chooseCandidate = (candidate: SecurityCandidate): void => {
    searchRun.current += 1
    setSelected(candidate)
    setSelectedNode(candidate as unknown as Record<string, unknown>)
    entityRun.current += 1
    setEntity(EMPTY_RESOURCE)
    setCandidates([])
    setQuery('')
    setError('')
    setSearched(false)
    setView('single')
    setExpanded(EMPTY_RESOURCE)
    loadCompany(candidate)
  }

  const selectedIdentity = selected === undefined ? '' : `${selected.name}（${selected.code}）`
  const assistantContext = (intent: IndustryChainAssistantContextInput['intent']): Record<string, unknown> => (
    buildIndustryChainAssistantContext({
      intent,
      selected,
      selectedNode,
      profile: profile.value,
      single: single.value,
      expanded: expanded.value,
      network: network.value,
      entity: entity.value,
      parameters: {
        depthUp, depthDown, topUp, topDown,
        minDegree: 3, minMarketCap: 0, minShare: 10,
        subjectOnly: false, includeUniverse: false,
      },
    })
  )
  const askSingleChain = (): void => {
    if (selected === undefined) return
    onAskAssistant({
      intent: 'industry-chain-interpret',
      module: 'chain',
      question: `解读 ${selectedIdentity} 的五列产业链，核验供应商、原材料或设备、主营产品和下游客户，并指出有依据的关键风险。`,
      data: assistantContext('single-chain'),
    })
  }
  const loadExpandedChain = (): void => {
    if (selected === undefined) return
    setView('expanded')
    setExpanded(previous => ({ ...previous, loading: true, error: '' }))
    void requestData({
      operation: 'industry-chain.chain',
      input: { code: selected.code, depth_up: depthUp, depth_down: depthDown, top_up: topUp, top_down: topDown },
    }).then((value) => { setExpanded({ value, loading: false, loaded: true, error: '' }) }, () => {
      setExpanded(previous => ({ ...previous, loading: false, error: '多层产业链暂不可用。' }))
    })
  }
  const loadNetwork = (): void => {
    setView('network')
    setNetwork(previous => ({ ...previous, loading: true, error: '' }))
    void requestData({
      operation: 'industry-chain.network',
      input: { min_degree: 3, min_market_cap: 0, min_share: 10, subject_only: false, include_universe: false },
    }).then((value) => { setNetwork({ value, loading: false, loaded: true, error: '' }) }, () => {
      setNetwork(previous => ({ ...previous, loading: false, error: '全局网络暂不可用。' }))
    })
  }

  const loadEntity = (node: Record<string, unknown>): void => {
    setSelectedNode(node)
    const key = text(node.id, text(node.code, text(node.name, '')))
    if (key === '') return
    const run = entityRun.current + 1
    entityRun.current = run
    setEntity({ value: undefined, loading: true, loaded: false, error: '' })
    void requestData({ operation: 'industry-chain.entity', input: { key } }).then((value) => {
      if (entityRun.current !== run) return
      setEntity({ value, loading: false, loaded: true, error: '' })
      setSelectedNode(asRecord(value))
    }, () => {
      if (entityRun.current === run) {
        setEntity({ value: undefined, loading: false, loaded: false, error: '节点档案暂不可用。' })
      }
    })
  }

  const singleRecord = asRecord(single.value)
  const profileRecord = asRecord(profile.value)
  const singleColumns = [
    records(singleRecord.suppliers), records(singleRecord.materials),
    singleRecord.company === undefined ? [] : [asRecord(singleRecord.company)],
    records(singleRecord.products), records(singleRecord.customers),
  ]
  const expandedRecord = asRecord(expanded.value)
  const networkRecord = asRecord(network.value)
  const networkStats = asRecord(networkRecord.stats)
  const networkNodes = records(networkRecord.nodes)

  return (
    <div className={css.page}>
      <header className={css.pageHead}>
        <div>
          <h1>产业链</h1>
          <p>从真实标的出发，研究供应商、材料设备、主营产品和下游客户。</p>
        </div>
        <div className={css.headActions}>
          <button type="button" className={css.secondaryButton} onClick={loadNetwork}>全局网络</button>
          <button type="button" className={css.primaryButton} disabled={selected === undefined} onClick={loadExpandedChain}>
            展开上下游
          </button>
        </div>
      </header>

      <section className={css.panel}>
        <div className={css.panelHead}>
          <div><strong>公司检索</strong><span>输入公司名称、代码或行业</span></div>
        </div>
        <div className={css.panelBody}>
          <form className={css.searchForm} role="search" onSubmit={search}>
            <input
              type="search"
              aria-label="搜索公司、代码或行业"
              value={query}
              onChange={(event) => { setQuery(event.target.value) }}
              placeholder="例如：中芯国际 / 688981 / 半导体"
            />
            <button type="submit" className={css.primaryButton} disabled={loading || query.trim() === ''}>
              {loading ? '搜索中…' : '搜索'}
            </button>
          </form>
          {error !== '' && <div className={css.errorState} role="alert">{error}</div>}
          {!loading && candidates.length > 0 && (
            <div className={css.searchResults} role="listbox" aria-label="公司搜索结果">
              {candidates.map(candidate => (
                <button
                  type="button"
                  role="option"
                  aria-selected={selected?.code === candidate.code}
                  key={candidate.code}
                  onClick={() => { chooseCandidate(candidate) }}
                >
                  <span><strong>{candidate.name}</strong><small>{candidate.market || '证券标的'}</small></span>
                  <code>{candidate.code}</code>
                </button>
              ))}
            </div>
          )}
          {!loading && searched && error === '' && candidates.length === 0 && (
            <div className={css.emptyState}>没有找到匹配标的，请尝试完整公司名或证券代码。</div>
          )}
        </div>
      </section>

      <div className={css.workspaceGrid}>
        <section className={css.panel}>
          <div className={css.panelHead}>
            <div>
              <strong>{selected === undefined ? '单公司五列产业链' : `${selected.name}五列产业链`}</strong>
              <span>供应商 → 原材料 / 设备 → 研究标的 → 主营产品 → 下游客户</span>
            </div>
            <div className={css.viewTabs} role="group" aria-label="产业链视图">
              <button type="button" aria-pressed={view === 'single'} onClick={() => { setView('single') }}>五列链路</button>
              <button type="button" aria-pressed={view === 'expanded'} onClick={() => { setView('expanded') }}>多层展开</button>
              <button type="button" aria-pressed={view === 'network'} onClick={() => { setView('network') }}>网络切片</button>
            </div>
          </div>
          <div className={css.panelBody}>
            {view === 'single' && (
              <>
                {(single.loading || profile.loading) && <div className={css.loadingState}>正在读取公司档案与产业链…</div>}
                {(single.error !== '' || profile.error !== '') && (
                  <div className={css.errorState} role="alert">
                    {single.error || profile.error}
                    <button type="button" disabled={selected === undefined} onClick={() => { if (selected !== undefined) loadCompany(selected) }}>重试</button>
                  </div>
                )}
                <div className={css.chainScroller}>
                  <div className={css.chainColumns}>
                    {COLUMN_LABELS.map((label, index) => {
                      const columnNodes = singleColumns[index] ?? []
                      return <div className={css.chainColumn} data-center={index === 2 ? 'true' : undefined} key={label}>
                        <span>{label}</span>
                        {columnNodes.length > 0 ? columnNodes.map((node, nodeIndex) => (
                          <button
                            type="button"
                            className={css.chainNode}
                            key={text(node.id, text(node.code, `${index}-${nodeIndex}`))}
                            onClick={() => { loadEntity(node) }}
                          >
                            <strong>{text(node.name, text(node.code, '未命名节点'))}</strong>
                            <small>{text(node.code, text(node.via, text(node.type, text(node.industry, ''))))}</small>
                          </button>
                        )) : (
                          <div className={css.missingNode}>{index === 2 ? '等待选择公司' : '暂无可验证关系'}</div>
                        )}
                      </div>
                    })}
                  </div>
                </div>
                {selected === undefined ? (
                  <div className={css.emptyState}>先搜索并选择公司，页面会固定研究标的并保留后续探索参数。</div>
                ) : (
                  <div className={css.dataGap}><span>已展示服务端返回的可验证关系。</span><button type="button" onClick={askSingleChain}>让投研助理解读链路</button></div>
                )}
              </>
            )}
            {view === 'expanded' && (
              <div className={css.viewEmpty}>
                <strong>{expanded.loading ? '正在读取多层链路…' : '多层产业链'}</strong>
                {expanded.error !== '' && <span role="alert">{expanded.error}</span>}
                {expanded.loaded && [...records(expandedRecord.up_levels), ...records(expandedRecord.down_levels)].map((level, index) => (
                  <div className={css.levelRow} key={`${text(level.level, '')}-${index}`}>
                    <b>{number(level.level) === undefined ? '层级' : `${number(level.level)} 层`}</b>
                    {records(level.nodes).map((node, nodeIndex) => (
                      <button type="button" key={text(node.id, `${index}-${nodeIndex}`)} onClick={() => { loadEntity(node) }}>
                        {text(node.name, text(node.id, '未命名节点'))}
                      </button>
                    ))}
                  </div>
                ))}
                {!expanded.loading && !expanded.loaded && <span>{selected === undefined ? '选择公司后可按右侧参数展开。' : `将围绕 ${selectedIdentity} 展开上下游关系。`}</span>}
                <button type="button" className={css.primaryButton} disabled={selected === undefined || expanded.loading} onClick={loadExpandedChain}>按当前参数查询</button>
                <button
                  type="button"
                  className={css.secondaryButton}
                  disabled={!expanded.loaded || expanded.loading}
                  onClick={() => {
                    onAskAssistant({
                      intent: 'industry-chain-interpret',
                      module: 'chain',
                      question: `解读 ${selectedIdentity} 的多层上下游链路，识别关键节点、传导路径、证据强弱与风险。`,
                      data: assistantContext('expanded-chain'),
                    })
                  }}
                >让投研助理解读多层链路</button>
              </div>
            )}
            {view === 'network' && (
              <div className={css.viewEmpty}>
                <strong>{network.loading ? '正在读取网络切片…' : '全局网络切片'}</strong>
                {network.error !== '' && <span role="alert">{network.error}</span>}
                {network.loaded && (
                  <>
                    <div className={css.networkStats}>
                      <span><b>{networkNodes.length}</b>节点</span>
                      <span><b>{records(networkRecord.links).length}</b>关系</span>
                      <span><b>{number(networkStats.macro_communities_count)
                        ?? records(networkRecord.macro_communities).length}</b>社区</span>
                    </div>
                    <div className={css.networkNodes}>
                      {networkNodes.slice(0, 18).map((node, index) => <button type="button" key={text(node.id, String(index))} onClick={() => { loadEntity(node) }}>{text(node.name, text(node.code, '节点'))}</button>)}
                    </div>
                  </>
                )}
                {!network.loading && !network.loaded && <span>网络关系只展示可验证的服务端结果，不在前端补全公司关系。</span>}
                <button type="button" className={css.primaryButton} disabled={network.loading} onClick={loadNetwork}>刷新网络切片</button>
                <button type="button" className={css.secondaryButton} disabled={!network.loaded || network.loading} onClick={() => {
                  const subject = selected === undefined ? '当前产业链图谱' : `${selectedIdentity} 所在行业`
                  onAskAssistant({
                    intent: 'industry-chain-interpret',
                    module: 'chain',
                    question: `解读${subject}的全局网络切片，提炼核心公司、关键关系、宏观社区和证据边界。`,
                    data: assistantContext('network-slice'),
                  })
                }}>让投研助理解读</button>
              </div>
            )}
          </div>
        </section>

        <aside className={css.sideStack}>
          <section className={css.panel}>
            <div className={css.panelHead}><div><strong>公司档案</strong><span>当前研究标的</span></div></div>
            <div className={css.panelBody}>
              {entity.loading && <div className={css.loadingState}>正在读取节点档案…</div>}
              {entity.error !== '' && <div className={css.errorState} role="alert">{entity.error}</div>}
              {selectedNode === undefined ? (
                <div className={css.emptyState}>选择五列中的节点后查看档案。</div>
              ) : (
                <div className={css.companyProfile}>
                  <div><strong>{text(selectedNode.name, '未命名节点')}</strong><code>{text(selectedNode.code, '')}</code></div>
                  <span>{text(selectedNode.industry, text(selectedNode.market, '行业信息待补充'))}</span>
                  <dl>
                    <div><dt>上游实体</dt><dd>{number(selectedNode.supplier_count)?.toFixed(0) ?? number(profileRecord.supplier_count)?.toFixed(0) ?? '—'}</dd></div>
                    <div><dt>下游应用</dt><dd>{number(selectedNode.customer_count)?.toFixed(0) ?? number(profileRecord.customer_count)?.toFixed(0) ?? '—'}</dd></div>
                  </dl>
                  <button type="button" disabled={entity.loading} onClick={() => {
                    onAskAssistant({
                      intent: 'industry-chain-interpret',
                      module: 'chain',
                      question: `深入研究 ${text(selectedNode.name, selectedIdentity)} 的公司档案、产业链地位和上下游关系；区分直接关系与推断关系。`,
                      data: assistantContext('entity-research'),
                    })
                  }}>深入研究该节点</button>
                </div>
              )}
            </div>
          </section>

          <section className={css.panel}>
            <div className={css.panelHead}><div><strong>多层展开参数</strong><span>分别控制上下游范围</span></div></div>
            <div className={css.panelBody}>
              <div className={css.parameterGrid}>
                <label>上游深度<select aria-label="上游深度" value={depthUp} onChange={(event) => { setDepthUp(Number(event.target.value)) }}>{[1, 2, 3].map(value => <option key={value} value={value}>{value} 层</option>)}</select></label>
                <label>下游深度<select aria-label="下游深度" value={depthDown} onChange={(event) => { setDepthDown(Number(event.target.value)) }}>{[1, 2, 3].map(value => <option key={value} value={value}>{value} 层</option>)}</select></label>
                <label>每层上游<select aria-label="每层上游节点数" value={topUp} onChange={(event) => { setTopUp(Number(event.target.value)) }}>{[3, 5].map(value => <option key={value} value={value}>TOP {value}</option>)}</select></label>
                <label>每层下游<select aria-label="每层下游节点数" value={topDown} onChange={(event) => { setTopDown(Number(event.target.value)) }}>{[2, 5].map(value => <option key={value} value={value}>TOP {value}</option>)}</select></label>
              </div>
            </div>
          </section>
        </aside>
      </div>
    </div>
  )
}
