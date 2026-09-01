export interface HoldingImportItem {
  [key: string]: string | number
  ticker: string
  quantity: number
  cost_price: number
}

export interface HoldingImportResult {
  items: HoldingImportItem[]
  errors: string[]
}

const HEADER_ALIASES = {
  ticker: new Set(['ticker', 'code', 'symbol', '股票代码', '证券代码', '代码']),
  quantity: new Set(['quantity', 'qty', 'shares', '持仓数量', '数量', '股票余额', '股份余额']),
  cost_price: new Set(['cost_price', 'cost', 'avg_cost', 'average_cost', '成本价', '持仓成本', '成本']),
} as const

function normalizeHeader(value: string) {
  return value.trim().toLowerCase().replace(/[\s-]+/g, '_')
}

function parseDelimitedLine(line: string, delimiter: string) {
  const cells: string[] = []
  let cell = ''
  let quoted = false

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index] ?? ''
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        cell += '"'
        index += 1
      } else {
        quoted = !quoted
      }
    } else if (character === delimiter && !quoted) {
      cells.push(cell.trim())
      cell = ''
    } else {
      cell += character
    }
  }
  cells.push(cell.trim())
  return cells
}

function splitLine(line: string, delimiter: string | undefined) {
  if (delimiter === undefined) return line.trim().split(/\s+/)
  return parseDelimitedLine(line, delimiter)
}

function detectDelimiter(line: string) {
  const candidates = ['\t', ',', ';']
  const counts = candidates.map(delimiter => ({
    delimiter,
    count: parseDelimitedLine(line, delimiter).length - 1,
  }))
  const best = counts.sort((left, right) => right.count - left.count)[0]
  return best !== undefined && best.count > 0 ? best.delimiter : undefined
}

function findHeaderIndex(cells: string[], aliases: ReadonlySet<string>) {
  return cells.findIndex(cell => aliases.has(normalizeHeader(cell)))
}

function normalizeTicker(value: string) {
  const compact = value.trim().toUpperCase()
  const matched = compact.match(/^(\d{1,6})(?:\.(?:SH|SZ|BJ))?$/)
  return matched?.[1]?.padStart(6, '0')
}

function parseNumber(value: string) {
  const normalized = value.replace(/[,，\s]/g, '')
  if (normalized === '') return undefined
  const parsed = Number(normalized)
  return Number.isFinite(parsed) ? parsed : undefined
}

export function parseHoldingsImport(source: string): HoldingImportResult {
  const lines = source.replace(/^\uFEFF/, '').split(/\r?\n/)
    .map((value, index) => ({ value, line: index + 1 }))
    .filter(row => row.value.trim() !== '')
  const first = lines[0]
  if (first === undefined) return { items: [], errors: [] }

  const delimiter = detectDelimiter(first.value)
  const firstCells = splitLine(first.value, delimiter)
  const headerIndexes = {
    ticker: findHeaderIndex(firstCells, HEADER_ALIASES.ticker),
    quantity: findHeaderIndex(firstCells, HEADER_ALIASES.quantity),
    cost_price: findHeaderIndex(firstCells, HEADER_ALIASES.cost_price),
  }
  const recognizedHeaders = Object.values(headerIndexes).filter(index => index >= 0).length
  const hasHeader = recognizedHeaders > 0
  if (hasHeader && recognizedHeaders < 3) {
    return { items: [], errors: ['表头必须同时包含股票代码、数量和成本价。'] }
  }

  const items: HoldingImportItem[] = []
  const errors: string[] = []
  const seen = new Set<string>()

  for (const row of lines.slice(hasHeader ? 1 : 0)) {
    const cells = splitLine(row.value, delimiter)
    const fallbackOffset = cells.length >= 4 ? cells.length - 2 : 1
    const tickerCell = cells[hasHeader ? headerIndexes.ticker : 0] ?? ''
    const quantityCell = cells[hasHeader ? headerIndexes.quantity : fallbackOffset] ?? ''
    const costCell = cells[hasHeader ? headerIndexes.cost_price : fallbackOffset + 1] ?? ''
    const ticker = normalizeTicker(tickerCell)
    const quantity = parseNumber(quantityCell)
    const costPrice = parseNumber(costCell)

    if (ticker === undefined) {
      errors.push(`第 ${row.line} 行：股票代码“${tickerCell}”无效。`)
      continue
    }
    if (quantity === undefined || quantity <= 0) {
      errors.push(`第 ${row.line} 行：数量必须大于 0。`)
      continue
    }
    if (costPrice === undefined || costPrice <= 0) {
      errors.push(`第 ${row.line} 行：成本价必须大于 0。`)
      continue
    }
    if (seen.has(ticker)) {
      errors.push(`第 ${row.line} 行：股票代码 ${ticker} 重复。`)
      continue
    }

    seen.add(ticker)
    items.push({ ticker, quantity, cost_price: costPrice })
  }

  if (hasHeader && lines.length === 1) errors.push('表格中没有可导入的持仓数据。')
  return { items, errors }
}
