import { useRef } from 'react'
import type { ReactNode } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import clsx from 'clsx'
import { IconCloseOutline16 } from './icons/index.tsx'
import css from './Modal.module.css'

/**
 * Render a centered modal over a blurred page mask.
 * @param props.open - whether the dialog is showing.
 * @param props.onClose - Escape or mask click.
 * @param props.title - dialog heading and accessible name in every mode.
 * @param props.closeLabel - accessible close-button label.
 * @param props.description - optional supporting sentence under the title.
 * @param props.children - body (inputs, etc.).
 * @param props.footer - action row (Cancel / Create).
 * @param props.contentClassName - optional class for a scrollable content region.
 * @param props.headless - render children directly in the card (no default
 * header/close/body chrome) for dialogs whose figma frame owns its own
 * header structure; mask, card, Escape, and dialog semantics remain.
 * @returns null when closed; otherwise the overlay tree.
 */
export function Modal({
  open, onClose, title, closeLabel = 'Close', description, children, footer, className, contentClassName, headless = false,
}: {
  open: boolean
  onClose: () => void
  title: string
  closeLabel?: string
  description?: string
  children?: ReactNode
  footer?: ReactNode
  className?: string | undefined
  contentClassName?: string | undefined
  headless?: boolean
}) {
  const restoreFocusRef = useRef<HTMLElement | null>(null)

  if (!open) return null

  const hasDescription = !headless && description !== undefined && description !== ''

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose()
      }}
    >
      <DialogPrimitive.Portal>
        <div className={css.root} role="presentation">
          <DialogPrimitive.Overlay className={css.mask} />
          <DialogPrimitive.Content
            className={clsx(css.dialog, className)}
            onOpenAutoFocus={() => {
              const activeElement = document.activeElement
              restoreFocusRef.current = activeElement instanceof HTMLElement ? activeElement : null
            }}
            onCloseAutoFocus={(event) => {
              event.preventDefault()
              restoreFocusRef.current?.focus()
              restoreFocusRef.current = null
            }}
          >
            {headless
              ? (
                <>
                  <DialogPrimitive.Title className={css.srOnly}>{title}</DialogPrimitive.Title>
                  {children}
                </>
              )
              : (
                <>
                  <div className={clsx(css.content, contentClassName)}>
                    <div className={css.header}>
                      <DialogPrimitive.Title className={css.title}>{title}</DialogPrimitive.Title>
                      <DialogPrimitive.Close asChild>
                        <button type="button" className={css.close} aria-label={closeLabel}>
                          <IconCloseOutline16 size={14} />
                        </button>
                      </DialogPrimitive.Close>
                    </div>
                    {hasDescription && (
                      <DialogPrimitive.Description className={css.description}>
                        {description}
                      </DialogPrimitive.Description>
                    )}
                    {children !== undefined && <div className={css.body}>{children}</div>}
                  </div>
                  {footer !== undefined && <div className={css.footer}>{footer}</div>}
                </>
              )}
          </DialogPrimitive.Content>
        </div>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
