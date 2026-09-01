import { useId } from 'react'
import type { ReactNode } from 'react'
import * as RadioGroupPrimitive from '@radix-ui/react-radio-group'
import clsx from 'clsx'
import css from './RadioCardGroup.module.css'

export interface RadioCardOption<Value extends string> {
  readonly value: Value
  readonly label: ReactNode
  readonly disabled?: boolean
}

export interface RadioCardGroupProps<Value extends string> {
  readonly value: Value | undefined
  readonly onValueChange: (value: Value) => void
  readonly options: readonly RadioCardOption<Value>[]
  readonly label: ReactNode
  readonly ordinal?: number
  readonly name?: string
  readonly disabled?: boolean
  readonly className?: string | undefined
}

export function RadioCardGroup<Value extends string>({
  value,
  onValueChange,
  options,
  label,
  ordinal,
  name,
  disabled,
  className,
}: RadioCardGroupProps<Value>) {
  const labelId = useId()
  const select = (nextValue: string): void => {
    const option = options.find(candidate => candidate.value === nextValue)
    if (option !== undefined) onValueChange(option.value)
  }

  return (
    <fieldset className={clsx(css.fieldset, className)} disabled={disabled}>
      <legend className={css.legend}>
        {ordinal !== undefined && <span className={css.ordinal} aria-hidden="true">{ordinal}</span>}
        <span id={labelId}>{label}</span>
      </legend>
      <RadioGroupPrimitive.Root
        className={css.options}
        value={value ?? ''}
        onValueChange={select}
        aria-labelledby={labelId}
        name={name}
        disabled={disabled}
      >
        {options.map(option => (
          <RadioGroupPrimitive.Item
            key={option.value}
            className={css.item}
            value={option.value}
            disabled={option.disabled}
          >
            <span className={css.control} aria-hidden="true">
              <RadioGroupPrimitive.Indicator className={css.dot} />
            </span>
            <span>{option.label}</span>
          </RadioGroupPrimitive.Item>
        ))}
      </RadioGroupPrimitive.Root>
    </fieldset>
  )
}
