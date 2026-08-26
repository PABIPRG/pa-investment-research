import { describe, expect, it } from 'vitest'
import {
  inspectPresentationSource,
  inspectThemeStyles,
  verifyStrictThemePackages,
} from './verify-client-theme-styles.ts'

const tokens = new Set([
  '--dsw-alias-bg-base',
  '--dsw-alias-label-primary',
])

describe('client theme style policy', () => {
  it('accepts semantic aliases and scheme-neutral values', () => {
    expect(inspectThemeStyles(`
      .card {
        color: var(--dsw-alias-label-primary);
        background: var(--dsw-alias-bg-base);
        border-color: transparent;
      }
    `, 'valid.module.css', tokens)).toEqual([])
  })

  it('rejects literals, palette tokens, theme branches, and unknown aliases', () => {
    const violations = inspectThemeStyles(`
      :global(body[data-ds-dark-theme]) .card {
        color: #fff;
        background: red;
        border-color: var(--dsw-static-blue-500);
        box-shadow: var(--dsw-shadow-missing);
      }
    `, 'invalid.module.css', tokens)

    expect(new Set(violations.map(item => item.rule))).toEqual(new Set([
      'literal-color', 'static-token', 'theme-branch', 'undefined-token',
    ]))
  })

  it('rejects inline presentation in React source', () => {
    const violations = inspectPresentationSource(`
      export function Card() {
        return <div style={{ color: 'red' }} />
      }
    `, 'Card.tsx')

    expect(violations.map(item => item.rule)).toEqual(['inline-style'])
  })

  it('keeps every migrated package compliant', () => {
    expect(verifyStrictThemePackages()).toEqual([])
  })
})
