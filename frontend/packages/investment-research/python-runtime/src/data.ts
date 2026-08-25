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
        enrich: optionalBoolean(input, 'enrich') ?? true,
        personal: optionalBoolean(input, 'personal') ?? true,
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
}

/** Resolve and execute one fixed backend operation without exposing an origin or URL to the browser. */
export async function requestInvestmentData(
  request: InvestmentDataRequest,
  acquire: (id: InvestmentBackendId) => Promise<{ baseUrl: string; release(): Promise<void> }>,
): Promise<InvestmentJsonValue> {
  const spec = SPECS[request.operation]
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
