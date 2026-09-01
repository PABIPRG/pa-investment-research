// @vitest-environment jsdom
import { createRef, useState } from 'react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ProgressBar,
  RadioCardGroup,
  SegmentedControl,
  TextArea,
} from '@deepseek-ai/dsh-client-ui-primitives'

afterEach(cleanup)

const cssText = (name: string): string => readFileSync(
  resolve(process.cwd(), `packages/client/ui-primitives/src/${name}.module.css`),
  'utf8',
)

function declaration(source: string, selector: string, property: string): string | undefined {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, ' ')
  for (const [, selectors = '', body = ''] of withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!selectors.split(',').map(value => value.trim()).includes(selector)) continue
    for (const part of body.split(';')) {
      const colon = part.indexOf(':')
      if (colon === -1 || part.slice(0, colon).trim() !== property) continue
      return part.slice(colon + 1).trim().replace(/\s+/g, ' ')
    }
  }
  return undefined
}

describe('ProgressBar', () => {
  it('clamps its accessible value and scales the indicator to the bounded ratio', () => {
    const view = render(<ProgressBar ariaLabel="Assessment progress" value={3} max={8} />)
    let progress = screen.getByRole('progressbar', { name: 'Assessment progress' })
    expect(progress.getAttribute('aria-valuemin')).toBe('0')
    expect(progress.getAttribute('aria-valuenow')).toBe('3')
    expect(progress.getAttribute('aria-valuemax')).toBe('8')
    expect((progress.firstElementChild as HTMLElement).style.transform).toBe('scaleX(0.375)')

    view.rerender(<ProgressBar ariaLabel="Assessment progress" value={12} max={8} />)
    progress = screen.getByRole('progressbar', { name: 'Assessment progress' })
    expect(progress.getAttribute('aria-valuenow')).toBe('8')
    expect((progress.firstElementChild as HTMLElement).style.transform).toBe('scaleX(1)')

    view.rerender(<ProgressBar ariaLabel="Assessment progress" value={-2} max={8} />)
    progress = screen.getByRole('progressbar', { name: 'Assessment progress' })
    expect(progress.getAttribute('aria-valuenow')).toBe('0')
    expect((progress.firstElementChild as HTMLElement).style.transform).toBe('scaleX(0)')
  })

  it('normalizes non-finite values and non-positive maxima', () => {
    render(<ProgressBar ariaLabel="Assessment progress" value={Number.NaN} max={0} />)
    const progress = screen.getByRole('progressbar', { name: 'Assessment progress' })
    expect(progress.getAttribute('aria-valuenow')).toBe('0')
    expect(progress.getAttribute('aria-valuemax')).toBe('1')
    expect((progress.firstElementChild as HTMLElement).style.transform).toBe('scaleX(0)')
  })

  it('uses an 8px animated track and disables the transition for reduced motion', () => {
    const source = cssText('ProgressBar')
    expect(declaration(source, '.root', 'height')).toBe('8px')
    expect(declaration(source, '.indicator', 'transition'))
      .toBe('transform var(--ds-transition-duration) var(--ds-ease-in-out)')
    expect(source).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*\.indicator\s*\{[\s\S]*transition:\s*none/)
  })
})

describe('TextArea and Button style contracts', () => {
  it('forwards textarea value, events, ref, disabled, and invalid semantics', () => {
    const ref = createRef<HTMLTextAreaElement>()
    const onChange = vi.fn()
    const view = render(<TextArea ref={ref} aria-label="Notes" value="draft" onChange={onChange} />)
    let input = screen.getByRole('textbox', { name: 'Notes' }) as HTMLTextAreaElement
    expect(ref.current).toBe(input)
    fireEvent.change(input, { target: { value: 'next' } })
    expect(onChange).toHaveBeenCalledTimes(1)

    view.rerender(
      <TextArea ref={ref} aria-label="Notes" aria-invalid="true" disabled value="draft" onChange={onChange} />,
    )
    input = screen.getByRole('textbox', { name: 'Notes' }) as HTMLTextAreaElement
    expect(ref.current).toBe(input)
    expect(input.disabled).toBe(true)
    expect(input.getAttribute('aria-invalid')).toBe('true')
  })

  it('keeps shared controls visibly focused', () => {
    expect(declaration(cssText('TextArea'), '.textarea:focus-visible', 'outline'))
      .toBe('2px solid var(--dsw-alias-state-business-primary)')
    expect(declaration(cssText('Button'), '.button:focus-visible', 'outline'))
      .toBe('2px solid var(--dsw-alias-state-business-primary)')
  })
})

function SegmentedHarness() {
  const [value, setValue] = useState<'quick' | 'full'>('quick')
  return (
    <SegmentedControl
      ariaLabel="Assessment length"
      value={value}
      onValueChange={setValue}
      items={[
        { value: 'quick', label: 'Quick · 3' },
        { value: 'full', label: 'Full · 8' },
      ]}
    />
  )
}

function RadioCardHarness() {
  const [value, setValue] = useState<'low' | 'high' | undefined>()
  return (
    <RadioCardGroup
      label="How much loss can you accept?"
      ordinal={2}
      value={value}
      onValueChange={setValue}
      options={[
        { value: 'low', label: 'Within 5%' },
        { value: 'high', label: 'Around 20%' },
      ]}
    />
  )
}

describe('SegmentedControl', () => {
  it('keeps selection controlled and supports arrow navigation', async () => {
    render(<SegmentedHarness />)
    const quick = screen.getByRole('radio', { name: 'Quick · 3' })
    const full = screen.getByRole('radio', { name: 'Full · 8' })
    expect(quick.getAttribute('aria-checked')).toBe('true')
    quick.focus()
    fireEvent.keyDown(quick, { key: 'ArrowRight' })
    await waitFor(() => { expect(full.getAttribute('aria-checked')).toBe('true') })
    fireEvent.keyUp(document, { key: 'ArrowRight' })
  })

  it('does not emit a value for a disabled item', () => {
    const onValueChange = vi.fn()
    render(
      <SegmentedControl<'quick' | 'full'>
        ariaLabel="Assessment length"
        value="quick"
        onValueChange={onValueChange}
        items={[
          { value: 'quick', label: 'Quick · 3' },
          { value: 'full', label: 'Full · 8', disabled: true },
        ]}
      />,
    )
    const full = screen.getByRole('radio', { name: 'Full · 8' }) as HTMLButtonElement
    expect(full.disabled).toBe(true)
    fireEvent.click(full)
    expect(onValueChange).not.toHaveBeenCalled()
  })
})

describe('RadioCardGroup', () => {
  it('labels one group and updates exactly one selected card by click or arrow key', async () => {
    render(<RadioCardHarness />)
    const group = screen.getByRole('radiogroup', { name: 'How much loss can you accept?' })
    const low = within(group).getByRole('radio', { name: 'Within 5%' })
    const high = within(group).getByRole('radio', { name: 'Around 20%' })
    expect(low.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(high)
    expect(high.getAttribute('aria-checked')).toBe('true')
    expect(low.getAttribute('aria-checked')).toBe('false')

    high.focus()
    fireEvent.keyDown(high, { key: 'ArrowLeft' })
    await waitFor(() => { expect(low.getAttribute('aria-checked')).toBe('true') })
    expect(high.getAttribute('aria-checked')).toBe('false')
    fireEvent.keyUp(document, { key: 'ArrowLeft' })
    expect(screen.getByText('2')).toBeTruthy()
  })

  it('does not select a disabled card', () => {
    const onValueChange = vi.fn()
    render(
      <RadioCardGroup<'low' | 'high'>
        label="Loss tolerance"
        value="low"
        onValueChange={onValueChange}
        options={[
          { value: 'low', label: 'Within 5%' },
          { value: 'high', label: 'Around 20%', disabled: true },
        ]}
      />,
    )
    const high = screen.getByRole('radio', { name: 'Around 20%' }) as HTMLButtonElement
    expect(high.disabled).toBe(true)
    fireEvent.click(high)
    expect(onValueChange).not.toHaveBeenCalled()
  })

  it('uses the shared neutral surfaces for segments, question groups, and cards', () => {
    expect(declaration(cssText('SegmentedControl'), '.root', 'background'))
      .toBe('var(--dsw-alias-interactive-bg-hover)')
    expect(declaration(cssText('RadioCardGroup'), '.fieldset', 'background'))
      .toBe('var(--dsw-alias-bg-module-platform)')
    expect(declaration(cssText('RadioCardGroup'), '.item', 'background'))
      .toBe('var(--dsw-alias-bg-base)')
  })
})
