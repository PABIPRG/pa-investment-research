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
  return value
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

const PATH_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const TASK_IDENTIFIER = /^[a-f0-9]{32}$/

function pathIdentifier(input: Readonly<Record<string, unknown>>, key: string): string {
  const value = stringValue(input, key)
  if (!PATH_IDENTIFIER.test(value)) {
    throw new TypeError(`investment data: ${key} must be a safe identifier`)
  }
  return encodeURIComponent(value)
}

function taskIdentifier(input: Readonly<Record<string, unknown>>, key: string): string {
  const value = stringValue(input, key)
  if (!TASK_IDENTIFIER.test(value)) {
    throw new TypeError(`investment data: ${key} must be a 32-character lowercase hexadecimal identifier`)
  }
  return encodeURIComponent(value)
}

function boundedNumber(
  input: Readonly<Record<string, unknown>>,
  key: string,
  min: number,
  max: number,
  options: Readonly<{ minExclusive?: boolean; maxExclusive?: boolean }> = {},
): number | undefined {
  const value = optionalNumber(input, key)
  if (value === undefined) return undefined
  const below = options.minExclusive ? value <= min : value < min
  const above = options.maxExclusive ? value >= max : value > max
  if (below || above) {
    const interval = `${options.minExclusive ? '(' : '['}${min}, ${max}${options.maxExclusive ? ')' : ']'}`
    throw new TypeError(`investment data: ${key} must be within ${interval}`)
  }
  return value
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
      return `/reports/${taskIdentifier(input, 'report_id')}`
    },
  },
  'trading-core.strategies': {
    backendId: 'trading-core',
    method: 'GET',
    path: (input) => {
      knownKeys(input, ['limit'])
      return query('/strategies', { limit: integer(input, 'limit', 50, 1, 200) })
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
  'trading-core.strategy-run': {
    backendId: 'trading-core',
    method: 'POST',
    path: () => '/strategies/run',
    body: (input) => {
      knownKeys(input, ['strategy_id', 'lookback_years', 'oos_frac', 'initial_capital', 'min_oos_trades'])
      const strategyId = stringValue(input, 'strategy_id')
      if (!PATH_IDENTIFIER.test(strategyId)) {
        throw new TypeError('investment data: strategy_id must be a safe identifier')
      }
      const lookbackYears = boundedNumber(input, 'lookback_years', 0.5, 10)
      const oosFraction = boundedNumber(input, 'oos_frac', 0, 0.5, { minExclusive: true, maxExclusive: true })
      const initialCapital = boundedNumber(input, 'initial_capital', 0, Number.MAX_SAFE_INTEGER)
      return {
        strategy_id: strategyId,
        ...(lookbackYears === undefined ? {} : { lookback_years: lookbackYears }),
        ...(oosFraction === undefined ? {} : { oos_frac: oosFraction }),
        ...(initialCapital === undefined ? {} : { initial_capital: initialCapital }),
        ...(input.min_oos_trades === undefined
          ? {}
          : { min_oos_trades: integer(input, 'min_oos_trades', 4, 1, 100) }),
      }
    },
  },
  'trading-core.shadow-status': noInput('/shadow/status', 'trading-core'),
  'trading-core.shadow-positions': {
    backendId: 'trading-core',
    method: 'GET',
    path: (input) => {
      knownKeys(input, ['strategy_id'])
      const strategyId = optionalString(input, 'strategy_id')
      if (strategyId !== undefined && !PATH_IDENTIFIER.test(strategyId)) {
        throw new TypeError('investment data: strategy_id must be a safe identifier')
      }
      return query('/shadow/positions', { strategy_id: strategyId })
    },
  },
  'trading-core.shadow-equity': {
    backendId: 'trading-core',
    method: 'GET',
    path: (input) => {
      knownKeys(input, ['strategy_id', 'limit'])
      const strategyId = optionalString(input, 'strategy_id')
      if (strategyId !== undefined && !PATH_IDENTIFIER.test(strategyId)) {
        throw new TypeError('investment data: strategy_id must be a safe identifier')
      }
      return query('/shadow/equity', {
        strategy_id: strategyId,
        limit: integer(input, 'limit', 30, 1, 100),
      })
    },
  },
  'trading-core.shadow-run': {
    backendId: 'trading-core',
    method: 'POST',
    path: () => '/shadow/run',
    body: (input) => {
      knownKeys(input, ['force', 'strategy_id'])
      const strategyId = optionalString(input, 'strategy_id')
      if (strategyId !== undefined && !PATH_IDENTIFIER.test(strategyId)) {
        throw new TypeError('investment data: strategy_id must be a safe identifier')
      }
      return {
        force: optionalBoolean(input, 'force') ?? false,
        ...(strategyId === undefined ? {} : { strategy_id: strategyId }),
      }
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
  'trading-core.personalized-matches': noInput('/personalized/matches', 'trading-core'),
  'trading-core.personalized-impact': {
    backendId: 'trading-core',
    method: 'GET',
    path: (input) => {
      knownKeys(input, ['limit'])
      return query('/personalized/impact', { limit: integer(input, 'limit', 5, 1, 50) })
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
