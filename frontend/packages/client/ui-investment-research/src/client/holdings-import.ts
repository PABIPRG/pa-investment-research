import { read, utils } from 'xlsx/xlsx.mjs'

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
  cost_price: new Set(['cost_price', 'cost', 'avg_cost', 'average_cost', '成本价', '参考成本价', '成本均价', '持仓成本', '成本']),
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

  let delimiter = detectDelimiter(first.value)
  let headerLineIndex = -1
  let headerIndexes = { ticker: -1, quantity: -1, cost_price: -1 }
  let partialHeader = false
  for (let index = 0; index < Math.min(lines.length, 20); index += 1) {
    const row = lines[index]
    if (row === undefined) continue
    const candidateDelimiter = detectDelimiter(row.value)
    const cells = splitLine(row.value, candidateDelimiter)
    const candidateIndexes = {
      ticker: findHeaderIndex(cells, HEADER_ALIASES.ticker),
      quantity: findHeaderIndex(cells, HEADER_ALIASES.quantity),
      cost_price: findHeaderIndex(cells, HEADER_ALIASES.cost_price),
    }
    const recognized = Object.values(candidateIndexes).filter(cellIndex => cellIndex >= 0).length
    if (recognized === 3) {
      delimiter = candidateDelimiter
      headerLineIndex = index
      headerIndexes = candidateIndexes
      break
    }
    partialHeader ||= recognized > 0
  }
  const hasHeader = headerLineIndex >= 0
  if (!hasHeader && partialHeader) {
    return { items: [], errors: ['表头必须同时包含股票代码、数量和成本价。'] }
  }

  const items: HoldingImportItem[] = []
  const errors: string[] = []
  const seen = new Set<string>()

  for (const row of lines.slice(hasHeader ? headerLineIndex + 1 : 0)) {
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

  if (hasHeader && lines.length === headerLineIndex + 1) errors.push('表格中没有可导入的持仓数据。')
  return { items, errors }
}

export function holdingsWorkbookToDelimitedText(data: ArrayBuffer | Uint8Array): string {
  const workbook = read(data, { type: 'array', cellDates: false, dense: true })
  const sheetName = workbook.SheetNames[0]
  if (sheetName === undefined) throw new Error('工作簿中没有可导入的工作表。')
  const sheet = workbook.Sheets[sheetName]
  if (sheet === undefined) throw new Error('无法读取工作簿中的首个工作表。')
  return utils.sheet_to_csv(sheet, { FS: '\t', RS: '\n', blankrows: false })
}

export function parseHoldingsWorkbook(data: ArrayBuffer | Uint8Array): HoldingImportResult {
  try {
    return parseHoldingsImport(holdingsWorkbookToDelimitedText(data))
  } catch {
    return { items: [], errors: ['无法读取 Excel 文件，请确认文件未损坏且包含持仓表格。'] }
  }
}
