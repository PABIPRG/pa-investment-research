type TradingDayStatus = 'trading' | 'closed' | 'unknown' | undefined

export function marketStatus(now: Date, dayStatus: TradingDayStatus, viewingToday: boolean): { label: string; active: boolean } {
  if (!viewingToday) return { label: '历史日期', active: false }
  if (dayStatus === 'closed') return { label: '休市', active: false }

  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now)
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find(item => item.type === type)?.value ?? '0')
  const minute = part('hour') * 60 + part('minute')
  if (dayStatus !== 'trading') {
    const outsideSession = minute < 9 * 60 + 15 || minute >= 15 * 60 ||
      (minute >= 11 * 60 + 30 && minute < 13 * 60)
    return { label: outsideSession ? '非交易时段' : '交易状态待确认', active: false }
  }
  if (minute < 9 * 60 + 15) return { label: '未开市', active: false }
  if (minute < 9 * 60 + 25) return { label: '集合竞价', active: true }
  if (minute < 9 * 60 + 30) return { label: '待开盘', active: false }
  if (minute < 11 * 60 + 30) return { label: '交易中', active: true }
  if (minute < 13 * 60) return { label: '午间休市', active: false }
  if (minute < 15 * 60) return { label: '交易中', active: true }
  return { label: '已收盘', active: false }
}
