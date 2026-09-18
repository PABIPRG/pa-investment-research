import type { ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { DetailDialog } from './DetailDialogs.tsx'
import css from './InvestmentShell.module.css'

/** A holdings task closes independently of its retained parent portfolio. */
export function HoldingsActionDialog({ title, description, ticker, busy, wide = false, onClose, children, onEscapeKeyDown }: {
  title: string
  description: string
  ticker?: string
  busy: boolean
  wide?: boolean
  onClose: () => void
  children: ReactNode
  onEscapeKeyDown?: ((event: KeyboardEvent) => void) | undefined
}) {
  return <DetailDialog title={title} description={description} eyebrow={ticker || '持仓操作'} wide={wide} onClose={onClose} closeDisabled={busy} onEscapeKeyDown={onEscapeKeyDown}
    actions={<>
      <span className={css.holdingCloseHint}>关闭后返回持仓明细</span>
      <Button variant="primary" className={`${css.holdingButton} ${css.holdingCloseButton}`} disabled={busy} onClick={onClose}>关闭</Button>
    </>}>
    {children}
  </DetailDialog>
}
