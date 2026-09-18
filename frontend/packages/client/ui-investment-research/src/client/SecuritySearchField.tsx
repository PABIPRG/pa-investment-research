import { useEffect, useId, useRef, useState } from 'react'
import { Button, Input, Menu, IconSearchOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InvestmentDataRequest } from '@deepseek-ai/dsh-client-investment-research-runtime/client'
import { searchSecurities, type SecuritySearchItem } from './security-search.ts'
import css from './SecuritySearchField.module.css'

/** 复用菜单浮层；由所在 Modal 协调 Esc，先收起搜索再关闭子窗口。 */
export function SecuritySearchField({ requestData, disabled, onSelect, open, onOpenChange }: {
  requestData: (request: InvestmentDataRequest) => Promise<unknown>
  disabled: boolean
  onSelect: (security: SecuritySearchItem | undefined) => void
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const id = useId()
  const root = useRef<HTMLDivElement>(null)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(false)
  const [items, setItems] = useState<SecuritySearchItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const [activeIndex, setActiveIndex] = useState(0)
  const showResults = open && !selected && query.trim() !== ''
  useEffect(() => {
    root.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' })
  }, [activeIndex, items])

  useEffect(() => {
    if (!showResults) return
    let current = true
    setLoading(true); setError(''); setItems([])
    const timer = window.setTimeout(() => {
      void searchSecurities(requestData, query.trim()).then(results => {
        if (!current) return
        setItems(results.filter(item => /^\d{6}$/.test(item.code))); setActiveIndex(0); setLoading(false)
      }, () => {
        if (!current) return
        setError('证券搜索暂不可用，请重试。'); setLoading(false)
      })
    }, 180)
    return () => { current = false; window.clearTimeout(timer) }
  }, [query, requestData, retry, showResults])

  const select = (item: SecuritySearchItem): void => {
    setQuery(`${item.name} ${item.code}`); setSelected(true); setItems([]); setError('')
    onSelect(item)
    root.current?.querySelector('input')?.focus()
    onOpenChange(false)
  }

  return <div ref={root} className={css.field} onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget)) onOpenChange(false)
  }}>
    <label htmlFor={id}>证券名称或代码</label>
    <Menu open={showResults} className={css.anchor ?? ''} listClassName={css.dropdown} items={[]}
      onSelect={() => {}} onClose={() => { onOpenChange(false) }} anchor={
    <Input id={id} className={css.input ?? ''} icon={<IconSearchOutline16 />} type="search" role="combobox"
      value={query} disabled={disabled} placeholder="搜索名称或代码，如 科士达" autoComplete="off"
      aria-expanded={showResults} aria-autocomplete="list" aria-haspopup="listbox"
      aria-controls={showResults && !loading && !error && items.length > 0 ? `${id}-results` : undefined}
      aria-activedescendant={showResults && items[activeIndex] ? `${id}-${items[activeIndex]!.code}` : undefined}
      onFocus={() => { if (!selected && query.trim()) onOpenChange(true) }}
      onChange={event => {
        setQuery(event.target.value); setSelected(false); setItems([]); setError(''); setActiveIndex(0)
        setLoading(event.target.value.trim() !== ''); onOpenChange(event.target.value.trim() !== ''); onSelect(undefined)
      }}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing) return
        if (event.key === 'Tab') {
          // Remove the scrollable popup before the browser computes its next tab stop.
          onOpenChange(false)
        } else if (event.key === 'Enter') {
          event.preventDefault()
          const item = items[activeIndex]
          if (showResults && !loading && item) select(item)
        } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          if (!showResults && !selected && query.trim()) onOpenChange(true)
          else if (items.length > 0) setActiveIndex(index => (index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length)
        }
      }} />} content={<div className={css.results}>
      {loading ? <p role="status">正在搜索证券…</p>
        : error ? <div className={css.error} role="status"><span>{error}</span><Button variant="ghost" size="sm" disabled={disabled} onClick={() => { setRetry(retry + 1) }}>重试搜索</Button></div>
        : items.length === 0 ? <p role="status">未找到匹配证券，请尝试其他名称或代码。</p>
        : <div id={`${id}-results`} role="listbox" aria-label="匹配的证券" tabIndex={-1} className={css.options}>
          {items.map((item, index) => <Button key={item.code} id={`${id}-${item.code}`} role="option" variant="ghost"
            tabIndex={-1}
            className={css.option} aria-selected={activeIndex === index} disabled={disabled}
            onMouseEnter={() => { setActiveIndex(index) }} onClick={() => { select(item) }}>
            <strong>{item.name}</strong><span>{item.code}</span><small>{item.market}</small>
          </Button>)}
        </div>}
    </div>} />
  </div>
}
