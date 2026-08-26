import type {
  InvestmentBackendId, InvestmentDataOperation, InvestmentDataRequest, InvestmentJsonValue,
} from './types.ts'

interface RequestSpec {
  readonly backendId: InvestmentBackendId
  readonly method: 'GET' | 'POST'
  readonly path: (input: Readonly<Record<string, unknown>>) => string
  readonly body?: (input: Readonly<Record<string, unknown>>) => Readonly<Record<string, unknown>>
}

const EMPTY_INPUT: Readonly<Record<string, unknown>> = Object.freeze({})

function record(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (value === undefined) return EMPTY_INPUT
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`investment data: ${label} must be an object`)
  }
  return value as Readonly<Record<string, unknown>>
}

function knownKeys(input: Readonly<Record<string, unknown>>, allowed: readonly string[]): void {
  const permit = new Set(allowed)
  const unknown = Object.keys(input).find(key => !permit.has(key))
  if (unknown !== undefined) throw new TypeError(`investment data: unknown input key ${JSON.stringify(unknown)}`)
}

function optionalString(input: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = input[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`investment data: ${key} must be a non-empty string`)
  }
  return value
}

function optionalNumber(input: Readonly<Record<string, unknown>>, key: string): number | undefined {
  const value = input[key]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`investment data: ${key} must be a finite number`)
  }
  return value
}

function optionalBoolean(input: Readonly<Record<string, unknown>>, key: string): boolean | undefined {
  const value = input[key]
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new TypeError(`investment data: ${key} must be a boolean`)
  return value
}

function optionalStringArray(input: Readonly<Record<string, unknown>>, key: string): string[] | undefined {
  const value = input[key]
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.trim() === '')) {
    throw new TypeError(`investment data: ${key} must be an array of non-empty strings`)
  }
  return value.map(item => item as string)
}

function oneOf<const T extends string>(
  input: Readonly<Record<string, unknown>>,
  key: string,
  allowed: readonly T[],
  required = false,
): T | undefined {
  const value = optionalString(input, key)
  if (value === undefined) {
    if (required) throw new TypeError(`investment data: ${key} is required`)
    return undefined
  }
  if (!(allowed as readonly string[]).includes(value)) {
    throw new TypeError(`investment data: unsupported ${key} ${JSON.stringify(value)}`)
  }
  return value as T
}

function stringValue(input: Readonly<Record<string, unknown>>, key: string): string {
  const value = optionalString(input, key)
  if (value === undefined) throw new TypeError(`investment data: ${key} is required`)
  return value
}

function integer(input: Readonly<Record<string, unknown>>, key: string, fallback: number, min: number, max: number): number {
  const value = optionalNumber(input, key) ?? fallback
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new TypeError(`investment data: ${key} must be an integer between ${min} and ${max}`)
  }
  return value
}

function boundedNumber(
  input: Readonly<Record<string, unknown>>, key: string, fallback: number, min: number, max: number,
): number {
  const value = optionalNumber(input, key) ?? fallback
  if (value < min || value > max) {
    throw new TypeError(`investment data: ${key} must be between ${min} and ${max}`)
  }
  return value
}

function pathValue(input: Readonly<Record<string, unknown>>, key: string): string {
  const value = stringValue(input, key).trim()
  if (value.length > 128) throw new TypeError(`investment data: ${key} must be at most 128 characters`)
  return encodeURIComponent(value)
}

const PATH_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const REPORT_IDENTIFIER = /^[a-f0-9]{32}$/

function pathIdentifier(input: Readonly<Record<string, unknown>>, key: string): string {
  const value = stringValue(input, key)
  if (!PATH_IDENTIFIER.test(value)) {
    throw new TypeError(`investment data: ${key} must be a safe identifier`)
  }
  return encodeURIComponent(value)
}

function reportIdentifier(input: Readonly<Record<string, unknown>>, key: string): string {
  const value = stringValue(input, key)
  if (!REPORT_IDENTIFIER.test(value)) {
    throw new TypeError(`investment data: ${key} must be a 32-character lowercase hexadecimal identifier`)
  }
  return encodeURIComponent(value)
}

function taskIdentifier(input: Readonly<Record<string, unknown>>, key: string): string {
  const value = stringValue(input, key)
  if (!REPORT_IDENTIFIER.test(value) && !PATH_IDENTIFIER.test(value)) {
    throw new TypeError(`investment data: ${key} must be a 32-character lowercase hexadecimal identifier or safe task identifier`)
  }
  return encodeURIComponent(value)
}

function query(path: string, values: Readonly<Record<string, string | number | boolean | undefined>>): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) params.set(key, typeof value === 'boolean' ? (value ? '1' : '0') : String(value))
  }
  const suffix = params.toString()
  return suffix === '' ? path : `${path}?${suffix}`
}

function noInput(path: string, backendId: InvestmentBackendId): RequestSpec {
  return {
    backendId,
    method: 'GET',
    path: (input) => {
      knownKeys(input, [])
      return path
    },
  }
}

const SPECS: Record<InvestmentDataOperation, RequestSpec> = {
  'market-watch.overview': noInput('/overview', 'market-watch'),
  'market-watch.security-search': {
    backendId: 'market-watch',
    method: 'GET',
    path: (input) => {
      knownKeys(input, ['query', 'limit'])
      return query('/securities/search', {
        q: stringValue(input, 'query'),
        limit: integer(input, 'limit', 8, 1, 20),
      })
    },
  },
  'market-watch.security-detail': {
    backendId: 'market-watch',
    method: 'POST',
    path: () => '/securities/detail',
    body: (input) => {
      knownKeys(input, ['code', 'lookback'])
      return { code: stringValue(input, 'code'), lookback: integer(input, 'lookback', 120, 30, 500) }
    },
  },
  'market-watch.scan': {
    backendId: 'market-watch',
    method: 'POST',
    path: () => '/scan',
    body: (input) => {
      knownKeys(input, ['kind', 'top_n', 'min_amount_yi'])
      const kind = optionalString(input, 'kind') ?? 'gainers'
      if (!['gainers', 'volume_ratio', 'limit', 'turnover', 'amount'].includes(kind)) {
        throw new TypeError(`investment data: unsupported scan kind ${JSON.stringify(kind)}`)
      }
      return {
        kind,
        top_n: integer(input, 'top_n', 10, 1, 50),
        ...(optionalNumber(input, 'min_amount_yi') === undefined
          ? {}
          : { min_amount_yi: optionalNumber(input, 'min_amount_yi') }),
      }
    },
  },
  'market-watch.tech-signal': {
    backendId: 'market-watch',
    method: 'POST',
    path: () => '/tech-signal',
    body: (input) => {
      knownKeys(input, ['code', 'lookback'])
      return { code: stringValue(input, 'code'), lookback: integer(input, 'lookback', 120, 30, 500) }
    },
  },
  'market-watch.news-flash': {
    backendId: 'market-watch',
    method: 'GET',
    path: (input) => {
      knownKeys(input, ['limit', 'enrich', 'personal'])
      return query('/news/flash', {
        limit: integer(input, 'limit', 20, 5, 100),
        enrich: optionalBoolean(input, 'enrich') ?? false,
        personal: optionalBoolean(input, 'personal') ?? false,
      })
    },
  },
  'market-watch.news-events': {
    backendId: 'market-watch',
    method: 'GET',
    path: (input) => {
      knownKeys(input, ['limit'])
      return query('/news/events', { limit: integer(input, 'limit', 20, 5, 100) })
    },
  },
  'market-watch.watchlist': noInput('/watchlist', 'market-watch'),
  'market-watch.watch-add': {
    backendId: 'market-watch',
    method: 'POST',
    path: () => '/watchlist/add',
    body: (input) => {
      knownKeys(input, ['code', 'name'])
      return { code: stringValue(input, 'code'), ...(optionalString(input, 'name') === undefined ? {} : { name: optionalString(input, 'name') }) }
    },
  },
  'market-watch.watch-remove': {
    backendId: 'market-watch',
    method: 'POST',
    path: () => '/watchlist/remove',
    body: (input) => {
      knownKeys(input, ['code'])
      return { code: stringValue(input, 'code') }
    },
  },
  'market-watch.alerts': noInput('/alerts', 'market-watch'),
  'trading-core.analyze': {
    backendId: 'trading-core',
    method: 'POST',
    path: () => '/analyze',
    body: (input) => {
      knownKeys(input, ['ticker', 'date', 'market', 'research_depth', 'risk_profile'])
      const researchDepth = optionalString(input, 'research_depth') ?? 'standard'
      const riskProfile = optionalString(input, 'risk_profile')
      if (!['quick', 'basic', 'standard', 'deep', 'full'].includes(researchDepth)) {
        throw new TypeError('investment data: unsupported research_depth')
      }
      if (riskProfile !== undefined && !['conservative', 'balanced', 'aggressive'].includes(riskProfile)) {
        throw new TypeError('investment data: unsupported risk_profile')
      }
      return {
        ticker: stringValue(input, 'ticker'),
        ...(optionalString(input, 'date') === undefined ? {} : { date: optionalString(input, 'date') }),
        market: optionalString(input, 'market') ?? 'a_shares',
        research_depth: researchDepth,
        ...(riskProfile === undefined ? {} : { risk_profile: riskProfile }),
      }
    },
  },
  'trading-core.holdings': noInput('/holdings', 'trading-core'),
  'trading-core.holdings-save': {
    backendId: 'trading-core',
    method: 'POST',
    path: () => '/holdings/save',
    body: (input) => {
      knownKeys(input, ['holdings'])
      const holdings = input.holdings
      if (!Array.isArray(holdings)) throw new TypeError('investment data: holdings must be an array')
      return { holdings }
    },
  },
  'trading-core.holdings-analyze': {
    backendId: 'trading-core',
    method: 'POST',
    path: () => '/holdings/analyze',
    body: (input) => {
      knownKeys(input, ['holdings', 'mode', 'use_saved', 'risk_profile'])
      const holdings = input.holdings
      const mode = optionalString(input, 'mode') ?? 'deep'
      const riskProfile = optionalString(input, 'risk_profile')
      if (holdings !== undefined && !Array.isArray(holdings)) {
        throw new TypeError('investment data: holdings must be an array')
      }
      if (!['quick', 'deep'].includes(mode)) throw new TypeError('investment data: mode must be quick or deep')
      if (riskProfile !== undefined && !['conservative', 'balanced', 'aggressive'].includes(riskProfile)) {
        throw new TypeError('investment data: unsupported risk_profile')
      }
      return {
        ...(holdings === undefined ? {} : { holdings }),
        mode,
        use_saved: optionalBoolean(input, 'use_saved') ?? true,
        ...(riskProfile === undefined ? {} : { risk_profile: riskProfile }),
      }
    },
  },
  'trading-core.risk-portfolio': noInput('/risk/portfolio', 'trading-core'),
  'trading-core.risk-alerts': noInput('/risk/alerts', 'trading-core'),
  'trading-core.personalized-cards': {
    backendId: 'trading-core',
    method: 'GET',
    path: (input) => {
      knownKeys(input, ['limit', 'bucket', 'match', 'comment', 'strategy_id'])
      return query('/personalized/cards', {
        limit: integer(input, 'limit', 20, 1, 100),
        bucket: optionalString(input, 'bucket') ?? 'all',
        match: optionalBoolean(input, 'match') ?? false,
        comment: optionalBoolean(input, 'comment') ?? false,
        strategy_id: optionalString(input, 'strategy_id'),
      })
    },
  },
  'trading-core.personalized-feedback': {
    backendId: 'trading-core',
    method: 'POST',
    path: () => '/personalized/feedback',
    body: (input) => {
      knownKeys(input, ['card_id', 'sentiment', 'meta'])
      const sentiment = stringValue(input, 'sentiment')
      if (sentiment !== 'useful' && sentiment !== 'useless') {
        throw new TypeError('investment data: sentiment must be useful or useless')
      }
      return {
        card_id: stringValue(input, 'card_id'),
        sentiment,
        ...(input.meta === undefined ? {} : { meta: record(input.meta, 'meta') }),
      }
    },
  },
  'trading-core.personalized-matches': noInput('/personalized/matches', 'trading-core'),
  'trading-core.personalized-impact': {
    backendId: 'trading-core',
    method: 'GET',
    path: (input) => {
      knownKeys(input, ['limit'])
      return query('/personalized/impact', { limit: integer(input, 'limit', 5, 1, 50) })
    },
  },
  'trading-core.personalized-profile': noInput('/personalized/profile', 'trading-core'),
  'trading-core.risk-profile': noInput('/risk_profile', 'trading-core'),
  'trading-core.kyc-profile': noInput('/kyc/profile', 'trading-core'),
  'trading-core.kyc-questionnaire': {
    backendId: 'trading-core',
    method: 'POST',
    path: () => '/kyc/questionnaire',
    body: (input) => {
      knownKeys(input, ['answers', 'tier', 'method', 'voice_source'])
      const tier = stringValue(input, 'tier')
      const method = optionalString(input, 'method') ?? 'questionnaire'
      if (tier !== 'quick' && tier !== 'full') throw new TypeError('investment data: tier must be quick or full')
      if (method !== 'questionnaire' && method !== 'voice') {
        throw new TypeError('investment data: method must be questionnaire or voice')
      }
      if (!Array.isArray(input.answers) || input.answers.length === 0) {
        throw new TypeError('investment data: answers must be a non-empty array')
      }
      const answers = input.answers.map((candidate, index) => {
        const answer = record(candidate, `answers[${index}]`)
        knownKeys(answer, ['qid', 'label', 'score'])
        return {
          qid: stringValue(answer, 'qid'),
          label: stringValue(answer, 'label'),
          score: integer(answer, 'score', 0, 1, 5),
        }
      })
      return {
        answers,
        tier,
        method,
        ...(optionalString(input, 'voice_source') === undefined ? {} : { voice_source: optionalString(input, 'voice_source') }),
      }
    },
  },
  'trading-core.kyc-adjust': {
    backendId: 'trading-core',
    method: 'POST',
    path: () => '/kyc/adjust',
    body: (input) => {
      knownKeys(input, ['risk_tolerance', 'horizon_years', 'note'])
      return {
        risk_tolerance: boundedNumber(input, 'risk_tolerance', 0.5, 0, 1),
        horizon_years: integer(input, 'horizon_years', 3, 1, 10),
        note: optionalString(input, 'note') ?? '',
      }
    },
  },
  'trading-core.kyc-parse': {
    backendId: 'trading-core',
    method: 'POST',
    path: () => '/kyc/parse',
    body: (input) => {
      knownKeys(input, ['text'])
      return { text: stringValue(input, 'text') }
    },
  },
  'trading-core.reports': {
    backendId: 'trading-core',
    method: 'GET',
    path: (input) => {
      knownKeys(input, ['limit', 'task_type'])
      return query('/reports', {
        limit: integer(input, 'limit', 20, 1, 200),
        task_type: oneOf(input, 'task_type', ['stock', 'holdings', 'brief', 'backtest', 'strategy', 'shadow']),
      })
    },
  },
  'trading-core.report': {
    backendId: 'trading-core',
    method: 'GET',
    path: (input) => {
      knownKeys(input, ['report_id'])
      return `/reports/${reportIdentifier(input, 'report_id')}`
    },
  },
  'trading-core.strategies': {
    backendId: 'trading-core',
    method: 'GET',
    path: (input) => {
      knownKeys(input, ['status', 'limit'])
      return query('/strategies', {
        status: optionalString(input, 'status'),
        limit: integer(input, 'limit', 100, 1, 500),
      })
    },
  },
  'trading-core.strategy-detail': {
    backendId: 'trading-core',
    method: 'GET',
    path: (input) => {
      knownKeys(input, ['strategy_id'])
      return `/strategies/${pathValue(input, 'strategy_id')}`
    },
  },
  'trading-core.strategies-hypothesize': {
    backendId: 'trading-core',
    method: 'POST',
    path: () => '/strategies/hypothesize',
    body: (input) => {
      knownKeys(input, ['limit', 'dry_run'])
      return {
        limit: integer(input, 'limit', 20, 1, 100),
        dry_run: optionalBoolean(input, 'dry_run') ?? false,
      }
    },
  },
  'trading-core.strategy-run': {
    backendId: 'trading-core',
    method: 'POST',
    path: () => '/strategies/run',
    body: (input) => {
      knownKeys(input, ['strategy_id', 'lookback_years', 'oos_frac', 'initial_capital', 'min_oos_trades'])
      return {
        strategy_id: stringValue(input, 'strategy_id'),
        lookback_years: boundedNumber(input, 'lookback_years', 2, 0.5, 10),
        oos_frac: boundedNumber(input, 'oos_frac', 0.3, 0.001, 0.499),
        initial_capital: boundedNumber(input, 'initial_capital', 0, 0, 1_000_000_000_000),
        min_oos_trades: integer(input, 'min_oos_trades', 4, 1, 100),
      }
    },
  },
  'trading-core.strategy-action': {
    backendId: 'trading-core',
    method: 'POST',
    path: (input) => {
      knownKeys(input, ['strategy_id', 'action'])
      const action = stringValue(input, 'action')
      if (!['activate', 'reject', 'retire'].includes(action)) {
        throw new TypeError('investment data: action must be activate, reject, or retire')
      }
      return `/strategies/${pathValue(input, 'strategy_id')}/${action}`
    },
  },
  'trading-core.strategy-transition': {
    backendId: 'trading-core',
    method: 'POST',
    path: (input) => {
      knownKeys(input, ['strategy_id', 'action'])
      const strategyId = pathIdentifier(input, 'strategy_id')
      const action = oneOf(input, 'action', ['activate', 'reject', 'retire'], true)!
      return `/strategies/${strategyId}/${action}`
    },
  },
  'trading-core.brief-start': {
    backendId: 'trading-core',
    method: 'POST',
    path: () => '/brief',
    body: (input) => {
      knownKeys(input, ['period', 'scope', 'tickers', 'risk_profile'])
      const tickers = optionalStringArray(input, 'tickers')
      const riskProfile = oneOf(input, 'risk_profile', ['conservative', 'balanced', 'aggressive'])
      return {
        period: oneOf(input, 'period', ['pre_market', 'post_market', 'now']) ?? 'pre_market',
        scope: oneOf(input, 'scope', ['market', 'industry', 'concept', 'news', 'watchlist', 'all']) ?? 'all',
        ...(tickers === undefined ? {} : { tickers }),
        ...(riskProfile === undefined ? {} : { risk_profile: riskProfile }),
      }
    },
  },
  'trading-core.brief-run': {
    backendId: 'trading-core',
    method: 'POST',
    path: () => '/brief',
    body: (input) => {
      knownKeys(input, ['period', 'scope', 'tickers', 'risk_profile'])
      const period = optionalString(input, 'period') ?? 'now'
      const scope = optionalString(input, 'scope') ?? 'all'
      const riskProfile = optionalString(input, 'risk_profile')
      if (!['pre_market', 'post_market', 'now'].includes(period)) {
        throw new TypeError('investment data: period must be pre_market, post_market, or now')
      }
      if (!['market', 'industry', 'concept', 'news', 'watchlist', 'all'].includes(scope)) {
        throw new TypeError('investment data: unsupported brief scope')
      }
      if (riskProfile !== undefined && !['conservative', 'balanced', 'aggressive'].includes(riskProfile)) {
        throw new TypeError('investment data: unsupported risk_profile')
      }
      return {
        period,
        scope,
        ...(optionalStringArray(input, 'tickers') === undefined ? {} : { tickers: optionalStringArray(input, 'tickers') }),
        ...(riskProfile === undefined ? {} : { risk_profile: riskProfile }),
      }
    },
  },
  'trading-core.backtest-run': {
    backendId: 'trading-core',
    method: 'POST',
    path: () => '/backtest/run',
    body: (input) => {
      knownKeys(input, ['code', 'force', 'eval_window_days', 'min_age_days', 'limit', 'stop_loss_pct', 'take_profit_pct', 'neutral_band_pct'])
      return {
        ...(optionalString(input, 'code') === undefined ? {} : { code: optionalString(input, 'code') }),
        force: optionalBoolean(input, 'force') ?? false,
        eval_window_days: integer(input, 'eval_window_days', 10, 1, 120),
        min_age_days: integer(input, 'min_age_days', 14, 0, 365),
        limit: integer(input, 'limit', 200, 1, 2_000),
        stop_loss_pct: boundedNumber(input, 'stop_loss_pct', 5, 0, 100),
        take_profit_pct: boundedNumber(input, 'take_profit_pct', 10, 0, 1_000),
        neutral_band_pct: boundedNumber(input, 'neutral_band_pct', 2, 0, 100),
      }
    },
  },
  'trading-core.task-status': {
    backendId: 'trading-core',
    method: 'GET',
    path: (input) => {
      knownKeys(input, ['task_id'])
      return `/analyze/${taskIdentifier(input, 'task_id')}`
    },
  },
  'trading-core.task-result': {
    backendId: 'trading-core',
    method: 'GET',
    path: (input) => {
      knownKeys(input, ['task_id'])
      return `/analyze/${taskIdentifier(input, 'task_id')}/result`
    },
  },
  'trading-core.shadow-run': {
    backendId: 'trading-core',
    method: 'POST',
    path: () => '/shadow/run',
    body: (input) => {
      knownKeys(input, ['force', 'strategy_id'])
      return {
        force: optionalBoolean(input, 'force') ?? false,
        ...(optionalString(input, 'strategy_id') === undefined ? {} : { strategy_id: optionalString(input, 'strategy_id') }),
      }
    },
  },
  'trading-core.shadow-status': noInput('/shadow/status', 'trading-core'),
  'trading-core.shadow-positions': {
    backendId: 'trading-core',
    method: 'GET',
    path: (input) => {
      knownKeys(input, ['strategy_id'])
      return query('/shadow/positions', { strategy_id: optionalString(input, 'strategy_id') })
    },
  },
  'trading-core.shadow-equity': {
    backendId: 'trading-core',
    method: 'GET',
    path: (input) => {
      knownKeys(input, ['strategy_id', 'limit'])
      return query('/shadow/equity', {
        strategy_id: optionalString(input, 'strategy_id'),
        limit: integer(input, 'limit', 120, 1, 1_000),
      })
    },
  },
  'trading-core.evolution-status': noInput('/evolution/status', 'trading-core'),
  'trading-core.evolution-attribution': noInput('/evolution/attribution', 'trading-core'),
  'trading-core.evolution-run': {
    backendId: 'trading-core',
    method: 'POST',
    path: () => '/evolution/run',
    body: (input) => {
      knownKeys(input, ['apply'])
      return { apply: optionalBoolean(input, 'apply') ?? false }
    },
  },
  'industry-chain.stats': noInput('/stats', 'industry-chain'),
  'industry-chain.companies': {
    backendId: 'industry-chain',
    method: 'GET',
    path: (input) => {
      knownKeys(input, ['keyword', 'limit'])
      return query('/companies', {
        keyword: optionalString(input, 'keyword') ?? '',
        limit: integer(input, 'limit', 20, 1, 100),
      })
    },
  },
  'industry-chain.company': {
    backendId: 'industry-chain',
    method: 'GET',
    path: (input) => {
      knownKeys(input, ['code'])
      return `/companies/${pathValue(input, 'code')}`
    },
  },
  'industry-chain.entity': {
    backendId: 'industry-chain',
    method: 'GET',
    path: (input) => {
      knownKeys(input, ['key'])
      return `/graph/entity/${pathValue(input, 'key')}`
    },
  },
  'industry-chain.single': {
    backendId: 'industry-chain',
    method: 'GET',
    path: (input) => {
      knownKeys(input, ['code'])
      return `/graph/single/${pathValue(input, 'code')}`
    },
  },
  'industry-chain.chain': {
    backendId: 'industry-chain',
    method: 'GET',
    path: (input) => {
      knownKeys(input, ['code', 'depth_up', 'depth_down', 'top_up', 'top_down'])
      return query(`/graph/chain/${pathValue(input, 'code')}`, {
        depth_up: integer(input, 'depth_up', 2, 1, 3),
        depth_down: integer(input, 'depth_down', 2, 1, 3),
        top_up: integer(input, 'top_up', 3, 1, 5),
        top_down: integer(input, 'top_down', 2, 1, 5),
      })
    },
  },
  'industry-chain.network': {
    backendId: 'industry-chain',
    method: 'GET',
    path: (input) => {
      knownKeys(input, ['min_degree', 'min_market_cap', 'min_share', 'subject_only', 'include_universe'])
      return query('/graph/network', {
        min_degree: integer(input, 'min_degree', 3, 0, 500),
        min_market_cap: boundedNumber(input, 'min_market_cap', 0, 0, 10_000_000),
        min_share: boundedNumber(input, 'min_share', 10, 0, 100),
        subject_only: optionalBoolean(input, 'subject_only') ?? false,
        include_universe: optionalBoolean(input, 'include_universe') ?? false,
      })
    },
  },
}

/** Resolve and execute one fixed backend operation without exposing an origin or URL to the browser. */
export async function requestInvestmentData(
  request: InvestmentDataRequest,
  acquire: (id: InvestmentBackendId) => Promise<{ baseUrl: string; release(): Promise<void> }>,
): Promise<InvestmentJsonValue> {
  const spec = SPECS[request.operation]
  if (spec === undefined) {
    throw new TypeError(`investment data: unsupported operation ${JSON.stringify(request.operation)}`)
  }
  const input = record(request.input, 'input')
  const path = spec.path(input)
  const body = spec.body?.(input)
  const lease = await acquire(spec.backendId)
  try {
    const response = await fetch(`${lease.baseUrl}${path}`, {
      method: spec.method,
      ...(body === undefined
        ? {}
        : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    })
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 2_000)
      throw new Error(`investment data: ${request.operation} failed with HTTP ${response.status}: ${detail}`)
    }
    return await response.json() as InvestmentJsonValue
  } finally {
    await lease.release()
  }
}
