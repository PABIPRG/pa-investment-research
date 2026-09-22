import { useState } from 'react'
import { Modal } from './Modal.tsx'
import css from './DatePicker.module.css'

const MONTHS = ['一月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '十一月', '十二月']

export interface MonthPickerProps {
  value: string
  onChange: (value: string) => void
  label?: string
  disabled?: boolean
}

/** Token-styled month picker paired with DatePicker. */
export function MonthPicker({ value, onChange, label = '选择月份', disabled }: MonthPickerProps) {
  const [open, setOpen] = useState(false)
  const [year, month] = value.split('-').map(Number)
  const [viewYear, setViewYear] = useState(year ?? new Date().getFullYear())
  return (
    <>
      <button
        type="button"
        className={css.trigger}
        disabled={disabled}
        aria-label={`${label}，当前 ${value}`}
        onClick={() => { setViewYear(year ?? new Date().getFullYear()); setOpen(true) }}
      >
        <span>{label}</span><strong>{value.replace('-', '.')}</strong>
      </button>
      <Modal open={open} onClose={() => { setOpen(false) }} title={label} closeLabel={`关闭${label}`}>
        <div className={css.navigation}>
          <button type="button" aria-label="上一年" onClick={() => { setViewYear(current => current - 1) }}>‹</button>
          <strong>{viewYear} 年</strong>
          <button type="button" aria-label="下一年" onClick={() => { setViewYear(current => current + 1) }}>›</button>
        </div>
        <div className={css.monthGrid}>
          {MONTHS.map((name, index) => {
            const candidate = `${viewYear}-${String(index + 1).padStart(2, '0')}`
            return (
              <button
                type="button"
                key={candidate}
                aria-current={viewYear === year && index + 1 === month ? 'date' : undefined}
                className={viewYear === year && index + 1 === month ? css.selected : undefined}
                onClick={() => { onChange(candidate); setOpen(false) }}
              >{name}</button>
            )
          })}
        </div>
      </Modal>
    </>
  )
}
