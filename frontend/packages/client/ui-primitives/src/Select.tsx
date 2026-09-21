import { useEffect, useId, useRef, useState } from 'react'
import type { ButtonHTMLAttributes } from 'react'
import clsx from 'clsx'
import { Menu } from './Menu.tsx'
import { IconCheckOutline16, IconChevronDownOutline14 } from './icons/index.tsx'
import css from './Select.module.css'

export interface SelectOption<Value extends string> {
  readonly value: Value
  readonly label: string
  readonly disabled?: boolean | undefined
}

export interface SelectProps<Value extends string> extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'value' | 'onChange' | 'children'> {
  readonly value: Value
  readonly options: readonly SelectOption<Value>[]
  readonly onValueChange: (value: Value) => void
  readonly placeholder?: string | undefined
  readonly displayLabel?: string | undefined
}

function focusOption(item: HTMLButtonElement | undefined) {
  item?.focus({ preventScroll: true })
  const viewport = item?.closest<HTMLElement>('[data-menu-viewport]')
  if (!item || !viewport) return
  const target = item.getBoundingClientRect()
  const bounds = viewport.getBoundingClientRect()
  // Only scroll the option list, never the outer modal or page.
  if (target.top < bounds.top) viewport.scrollTop -= bounds.top - target.top
  else if (target.bottom > bounds.bottom) viewport.scrollTop += target.bottom - bounds.bottom
}

/** Controlled single selection. Values remain opaque strings, including empty values. */
export function Select<Value extends string>({ value, options, onValueChange, placeholder = '请选择', displayLabel, disabled, className, ...props }: SelectProps<Value>) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLSpanElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const id = useId()
  const openingEdge = useRef<'first' | 'last' | undefined>(undefined)
  const optionsKey = JSON.stringify(options)
  const enabled = options.filter(option => !option.disabled)
  const selected = options.find(option => option.value === value)
  const search = useRef({ text: '', at: 0 })
  const close = (restore = false) => { setOpen(false); if (restore) trigger.current?.focus({ preventScroll: true }) }
  useEffect(() => {
    if (!open) return
    if (disabled) { setOpen(false); return }
    const items = Array.from(list.current?.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)') ?? [])
    const index = enabled.findIndex(option => option.value === value)
    const item = items[openingEdge.current === 'first' ? 0 : openingEdge.current === 'last' ? items.length - 1 : Math.max(0, index)]
    focusOption(item)
    openingEdge.current = undefined
    // The portal starts hidden for measurement. Browsers reject focus until
    // Menu commits its position; retry after that commit without stealing an
    // already focused option or scrolling the enclosing dialog.
    const frame = requestAnimationFrame(() => {
      if (!list.current?.contains(document.activeElement)) focusOption(item)
    })
    return () => { cancelAnimationFrame(frame) }
  }, [open, disabled, optionsKey, value])
  return <span ref={root} className={css.root} data-ui-popup-open={open || undefined}
    onBlur={(event) => {
      const next = event.relatedTarget as Node | null
      if (!root.current?.contains(next) && !list.current?.contains(next)) close()
    }}
    onKeyDown={(event) => {
      if (event.key === 'Tab' && open) { close(true); return }
      if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); close(true); return }
      if (disabled || options.length === 0) return
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); event.stopPropagation()
        if (!open) { openingEdge.current = event.key === 'Home' ? 'first' : event.key === 'End' ? 'last' : undefined; setOpen(true); return }
        const items = Array.from(list.current?.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)') ?? [])
        const index = items.indexOf(document.activeElement as HTMLButtonElement)
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
        focusOption(items[next])
      } else if (open && event.key.length === 1 && event.key !== ' ' && !event.ctrlKey && !event.metaKey) {
        event.preventDefault()
        const now = Date.now()
        search.current = { text: (now - search.current.at < 600 ? search.current.text : '') + event.key.toLocaleLowerCase(), at: now }
        const index = enabled.findIndex(option => option.label.toLocaleLowerCase().startsWith(search.current.text))
        focusOption(list.current?.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)')[index])
      }
    }}>
    <Menu open={open} portal portalContainer={root.current?.closest('[role="dialog"]') ?? undefined} className={css.anchor ?? ''} listClassName={css.list} items={[]} onSelect={() => {}} onClose={() => { close() }}
      anchor={<button {...props} ref={trigger} type="button" role="combobox" aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? id : undefined} disabled={disabled || options.length === 0} className={clsx(css.trigger, className)} onClick={() => { setOpen(current => !current) }}><span>{displayLabel ?? selected?.label ?? placeholder}</span><IconChevronDownOutline14 /></button>}
      content={<div ref={list} id={id} role="listbox" aria-label={props['aria-label']} aria-labelledby={props['aria-labelledby']} data-ui-popup-content>
        {options.map((option, index) => <button key={index} type="button" role="option" aria-selected={option.value === value} disabled={option.disabled} tabIndex={-1} className={css.option} onClick={() => { onValueChange(option.value); close(true) }}><span>{option.label}</span>{option.value === value && <IconCheckOutline16 />}</button>)}
      </div>} />
  </span>
}
