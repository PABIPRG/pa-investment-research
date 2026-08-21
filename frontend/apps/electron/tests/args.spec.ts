import { describe, expect, it } from 'vitest'
import { resolveElectronProfile } from '../src/args.ts'

describe('resolveElectronProfile', () => {
  it('defaults to web and reads one explicit profile after Electron-owned argv', () => {
    expect(resolveElectronProfile(['/electron', '/app'])).toBe('web')
    expect(resolveElectronProfile([
      '/electron',
      '/app',
      '--profile',
      'investment-research',
    ])).toBe('investment-research')
  })

  it('rejects duplicate, missing, and empty profile values', () => {
    expect(() => resolveElectronProfile(['/electron', '/app', '--profile'])).toThrow(/--profile.*value/)
    expect(() => resolveElectronProfile(['/electron', '/app', '--profile', ''])).toThrow(/--profile.*non-empty/)
    expect(() => resolveElectronProfile([
      '/electron', '/app', '--profile', 'web', '--profile', 'investment-research',
    ])).toThrow(/--profile.*once/)
  })
})
