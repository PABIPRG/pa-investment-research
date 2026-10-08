import { useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Menu } from './Menu.tsx'
import { IconQuestionOutline14 } from './icons/index.tsx'
import css from './HelpPopover.module.css'
import { usePointerGrace } from './pointer-grace.ts'

/** Non-modal explanation. Optional hover/focus reveals it; click/touch pins it until dismissal. */
export function HelpPopover({ label, children, className, openOnHover = false }: { label: string; children: ReactNode; className?: string | undefined; openOnHover?: boolean }) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLSpanElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const pinned = useRef(false)
  const dismiss = () => { pinned.current = false; setOpen(false) }
  const contains = (node: Node | null) => root.current?.contains(node) || content.current?.contains(node)
  const grace = usePointerGrace(() => { if (!pinned.current && !contains(document.activeElement)) setOpen(false) })
  const reveal = () => { if (openOnHover) { grace.cancel(); setOpen(true) } }
  const id = useId()
  return <span ref={root} className={className} data-ui-popup-open={open || undefined} onMouseEnter={reveal} onMouseLeave={() => { if (openOnHover) grace.arm() }} onFocus={(event) => {
    if (!contains(event.relatedTarget)) reveal()
  }} onKeyDown={(event) => {
    if (open && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); trigger.current?.focus({ preventScroll: true }); dismiss() }
  }} onBlur={(event) => {
    const next = event.relatedTarget as Node | null
    if (next && !contains(next)) dismiss()
  }}>
    <Menu open={open} portal portalContainer={root.current?.closest('[role="dialog"]') ?? undefined} listClassName={css.popup} items={[]} onSelect={() => {}} onClose={dismiss}
      anchor={<button ref={trigger} type="button" className={css.trigger} aria-label={label} aria-expanded={open} aria-describedby={open ? id : undefined} onClick={() => { if (pinned.current) dismiss(); else { pinned.current = true; setOpen(true) } }}><IconQuestionOutline14 /></button>}
      content={<div ref={content} id={id} data-ui-popup-content role="tooltip" className={css.content} onMouseEnter={reveal} onMouseLeave={() => { if (openOnHover) grace.arm() }}>{children}</div>} />
  </span>
}
