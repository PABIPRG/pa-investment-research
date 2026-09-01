import type { ReactNode } from 'react'
import * as RadioGroupPrimitive from '@radix-ui/react-radio-group'
import clsx from 'clsx'
import css from './SegmentedControl.module.css'

export interface SegmentedControlItem<Value extends string> {
  readonly value: Value
  readonly label: ReactNode
  readonly disabled?: boolean
}

export interface SegmentedControlProps<Value extends string> {
  readonly value: Value
  readonly onValueChange: (value: Value) => void
  readonly items: readonly SegmentedControlItem<Value>[]
  readonly ariaLabel: string
  readonly disabled?: boolean
  readonly className?: string | undefined
}

export function SegmentedControl<Value extends string>({
  value,
  onValueChange,
  items,
  ariaLabel,
  disabled,
  className,
}: SegmentedControlProps<Value>) {
  const select = (nextValue: string): void => {
    const item = items.find(candidate => candidate.value === nextValue)
    if (item !== undefined) onValueChange(item.value)
  }

  return (
    <RadioGroupPrimitive.Root
      className={clsx(css.root, className)}
      value={value}
      onValueChange={select}
      aria-label={ariaLabel}
      disabled={disabled}
      orientation="horizontal"
    >
      {items.map(item => (
        <RadioGroupPrimitive.Item
          key={item.value}
          className={css.item}
          value={item.value}
          disabled={item.disabled}
        >
          <RadioGroupPrimitive.Indicator className={css.check} aria-hidden="true">
            ✓
          </RadioGroupPrimitive.Indicator>
          {item.label}
        </RadioGroupPrimitive.Item>
      ))}
    </RadioGroupPrimitive.Root>
  )
}
