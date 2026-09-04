import { asRecord, text } from './data.ts'

interface StrategyTicker {
  readonly code: string
  readonly name: string
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim() !== '').map(item => item.trim())
    : []
}

export function strategyTickers(item: Record<string, unknown>): StrategyTicker[] {
  const byCode = new Map<string, string>()
  for (const value of Array.isArray(item.tickers) ? item.tickers : []) {
    const ticker = asRecord(value)
    const code = text(ticker.code, '').trim()
    if (code !== '') byCode.set(code, text(ticker.name, '').trim())
  }
  for (const code of strings(item.symbols)) {
    if (!byCode.has(code)) byCode.set(code, '')
  }
  const rawName = text(item.name, '')
  const embeddedCode = rawName.match(/(?:^|[·\s])(\d{6})(?:$|[·\s])/u)?.[1] ?? ''
  if (embeddedCode !== '' && !byCode.has(embeddedCode)) byCode.set(embeddedCode, '')
  return [...byCode].map(([code, name]) => ({ code, name }))
}

export function strategyKindLabel(value: unknown): string {
  const kind = text(value, '')
  return {
    ma_cross: '均线趋势',
    rsi_reversal: '超跌反弹',
    momentum: '动量跟随',
    breakout: '通道突破',
    bollinger: '布林超跌',
    volume_breakout: '放量突破',
  }[kind] ?? (kind === '' ? '策略类型待补充' : '其他策略')
}

export function strategyDirectionLabel(value: unknown): string {
  const direction = text(value, '').trim()
  const normalized = direction.toLowerCase()
  if (['利好', 'long', 'bullish', 'positive', 'up'].includes(normalized)) return '利好'
  if (['利空', 'short', 'bearish', 'negative', 'down'].includes(normalized)) return '利空'
  return direction
}

export function strategyTargetLabel(
  item: Record<string, unknown>,
  resolved: Readonly<Record<string, string>>,
): string {
  const labels = strategyTickers(item).map((ticker) => {
    const name = ticker.name || resolved[ticker.code] || ''
    return name === '' || name === ticker.code ? ticker.code : `${name} · ${ticker.code}`
  })
  if (labels.length > 0) return labels.slice(0, 2).join('、') + (labels.length > 2 ? `等${labels.length}只` : '')
  return text(item.name, text(item.id, '未命名策略'))
}

/** Human-facing evolution label; raw strategy ids and machine kinds never become the title. */
export function strategyEvolutionLabel(
  item: Record<string, unknown>,
  resolved: Readonly<Record<string, string>>,
): string {
  const ticker = strategyTickers(item)[0]
  const rawName = text(item.name, '')
  const rawSegments = rawName.split('·').map(part => part.trim()).filter(Boolean)
  const rawKind = text(item.kind, rawSegments.find(part => part.includes('_')) ?? '')
  const code = ticker?.code ?? rawSegments.find(part => /^\d{6}$/u.test(part)) ?? ''
  const embeddedHumanName = rawSegments.find(part => !/^\d{6}$/u.test(part)
    && !part.includes('_') && !['利好', '利空'].includes(part)) ?? ''
  const name = ticker?.name || resolved[code] || embeddedHumanName
  const subject = code === ''
    ? (name || '未命名策略')
    : `${name === '' || name === code ? '证券名称待补充' : name}(${code})`
  return `${subject} · ${strategyKindLabel(rawKind)}`
}
