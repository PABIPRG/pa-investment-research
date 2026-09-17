import { describe, expect, it } from 'vitest'
import { formatStartupError, presentStartupFailure, startupErrorMessages } from '../src/startup-error.ts'

describe('Electron startup diagnostics', () => {
  it('expands nested aggregate members and causes without repeating wrapper messages', () => {
    const leaf = new Error('investment Python packaged runtime is invalid (incomplete file list)')
    const aggregate = new AggregateError([
      new Error('stock analysis failed', { cause: leaf }),
      new Error('market watch failed', { cause: leaf }),
    ], 'loader fibers failed')
    const root = new Error('dsh: plugin tree failed to load: loader fibers failed', { cause: aggregate })

    expect(startupErrorMessages(root)).toEqual([
      'dsh: plugin tree failed to load: loader fibers failed',
      'loader fibers failed',
      'stock analysis failed',
      'investment Python packaged runtime is invalid (incomplete file list)',
      'market watch failed',
    ])
    expect(formatStartupError(root)).toContain('incomplete file list')
  })

  it('turns an invalid packaged runtime into an actionable reinstall message', () => {
    const failure = presentStartupFailure(
      new Error('investment Python packaged runtime is invalid (incomplete file list); reinstall the application'),
      '/tmp/investment-startup.log',
    )

    expect(failure.message).toBe('应用内置投研运行时不完整')
    expect(failure.detail).toContain('请重新安装完整应用包')
    expect(failure.detail).toContain('/tmp/investment-startup.log')
  })

  it('retains the dedicated previous-instance guidance', () => {
    const failure = presentStartupFailure(Object.assign(new Error('stop failed'), {
      code: 'DSH_INVESTMENT_INSTANCE_STOP_FAILED',
    }))

    expect(failure.message).toBe('旧实例未能正常停止')
  })
})
