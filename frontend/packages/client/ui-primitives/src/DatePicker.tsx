import { useMemo, useState } from 'react'
import { Modal } from './Modal.tsx'
import css from './DatePicker.module.css'

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日']

function parseDate(value: string): Date {
  const [year, month, day] = value.split('-').map(Number)
  return new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1)
}

function dateValue(value: Date): string {
  return `${String(value.getFullYear()).padStart(4, '0')}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
}

function displayDate(value: string): string {
  const [year, month, day] = value.split('-')
  return `${year}.${month}.${day}`
}

export interface DatePickerProps {
  value: string
  onChange: (value: string) => void
  label?: string
  iconOnly?: boolean
  min?: string
  max?: string
  disabled?: boolean
}

/** Token-styled calendar picker that does not depend on the browser's native date input UI. */
export function DatePicker({ value, onChange, label = '选择日期', iconOnly = false, min, max, disabled }: DatePickerProps) {
  const [open, setOpen] = useState(false)
  const [view, setView] = useState(() => {
    const date = parseDate(value)
    return new Date(date.getFullYear(), date.getMonth(), 1)
  })
  const cells = useMemo(() => {
    const firstWeekday = (view.getDay() + 6) % 7
    const days = new Date(view.getFullYear(), view.getMonth() + 1, 0).getDate()
    return [...Array(firstWeekday).fill(null), ...Array.from({ length: days }, (_, index) => index + 1)]
  }, [view])
  return (
    <>
      <button
        type="button"
        className={`${css.trigger} ${iconOnly ? css.iconOnly : ''}`}
        disabled={disabled}
        aria-label={`${label}，当前 ${displayDate(value)}`}
        onClick={() => {
          const date = parseDate(value)
          setView(new Date(date.getFullYear(), date.getMonth(), 1))
          setOpen(true)
        }}
      >
        {iconOnly
          ? <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M7 3v4M17 3v4M3 10h18" /></svg>
          : <><span>{label}</span><strong>{displayDate(value)}</strong></>}
      </button>
      <Modal open={open} onClose={() => { setOpen(false) }} title={label} closeLabel={`关闭${label}`}>
        <div className={css.navigation}>
          <button type="button" aria-label="上个月" onClick={() => { setView(new Date(view.getFullYear(), view.getMonth() - 1, 1)) }}>‹</button>
          <strong>{view.getFullYear()} 年 {view.getMonth() + 1} 月</strong>
          <button type="button" aria-label="下个月" onClick={() => { setView(new Date(view.getFullYear(), view.getMonth() + 1, 1)) }}>›</button>
        </div>
        <div className={css.weekdays} aria-hidden="true">
          {WEEKDAYS.map(day => <span key={day}>{day}</span>)}
        </div>
        <div className={css.grid}>
          {cells.map((day, index) => {
            if (day === null) return <span key={`blank-${index}`} />
            const candidate = dateValue(new Date(view.getFullYear(), view.getMonth(), day))
            const unavailable = (min !== undefined && candidate < min) || (max !== undefined && candidate > max)
            return (
              <button
                type="button"
                key={candidate}
                disabled={unavailable}
                aria-current={candidate === value ? 'date' : undefined}
                className={candidate === value ? css.selected : undefined}
                onClick={() => { onChange(candidate); setOpen(false) }}
              >{day}</button>
            )
          })}
        </div>
      </Modal>
    </>
  )
}
