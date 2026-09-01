import * as ProgressPrimitive from '@radix-ui/react-progress'
import clsx from 'clsx'
import css from './ProgressBar.module.css'

export interface ProgressBarProps {
  value: number
  max?: number
  ariaLabel: string
  className?: string | undefined
}

export function ProgressBar({ value, max = 100, ariaLabel, className }: ProgressBarProps) {
  const safeMax = Number.isFinite(max) && max > 0 ? max : 1
  const finiteValue = Number.isFinite(value) ? value : 0
  const safeValue = Math.min(safeMax, Math.max(0, finiteValue))
  const ratio = safeValue / safeMax

  return (
    <ProgressPrimitive.Root
      className={clsx(css.root, className)}
      value={safeValue}
      max={safeMax}
      aria-label={ariaLabel}
    >
      <ProgressPrimitive.Indicator
        className={css.indicator}
        style={{ transform: `scaleX(${String(ratio)})` }}
      />
    </ProgressPrimitive.Root>
  )
}
