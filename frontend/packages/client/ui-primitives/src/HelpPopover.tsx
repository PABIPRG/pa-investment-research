import { useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Menu } from './Menu.tsx'
import { IconQuestionOutline14 } from './icons/index.tsx'
import css from './HelpPopover.module.css'

/** Non-modal, anchored explanation. Click/touch toggles; Escape or outside press dismisses. */
export function HelpPopover({ label, children, className }: { label: string; children: ReactNode; className?: string | undefined }) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLSpanElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const id = useId()
  return <span ref={root} className={className} data-ui-popup-open={open || undefined} onKeyDown={(event) => {
    if (open && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus({ preventScroll: true }) }
  }} onBlur={(event) => {
    const next = event.relatedTarget as Node | null
    if (next && !root.current?.contains(next) && !content.current?.contains(next)) setOpen(false)
  }}>
    <Menu open={open} portal portalContainer={root.current?.closest('[role="dialog"]') ?? undefined} listClassName={css.popup} items={[]} onSelect={() => {}} onClose={() => { setOpen(false) }}
      anchor={<button ref={trigger} type="button" className={css.trigger} aria-label={label} aria-expanded={open} aria-describedby={open ? id : undefined} onClick={() => { setOpen(current => !current) }}><IconQuestionOutline14 /></button>}
      content={<div ref={content} id={id} data-ui-popup-content role="tooltip" className={css.content}>{children}</div>} />
  </span>
}
