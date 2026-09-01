import css from './InvestmentShell.module.css'

export function SurfaceResizeIcon({ expanded }: { readonly expanded: boolean }) {
  return (
    <svg
      className={css.actionIcon}
      viewBox="0 0 16 16"
      aria-hidden="true"
      data-icon={expanded ? 'surface-collapse' : 'surface-expand'}
    >
      {expanded
        ? <><path d="M7 2.5V7H2.5" /><path d="m2.5 7 4.5-4.5" /><path d="M9 13.5V9h4.5" /><path d="M13.5 9 9 13.5" /></>
        : <><path d="M6.5 2.5h-4v4" /><path d="m2.5 2.5 4.5 4.5" /><path d="M9.5 13.5h4v-4" /><path d="M13.5 13.5 9 9" /></>}
    </svg>
  )
}
