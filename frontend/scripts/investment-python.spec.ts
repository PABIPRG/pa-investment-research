import { EventEmitter } from 'node:events'
import { posix, win32 } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { runInvestmentPython } from './investment-python.ts'

function child(exitCode: number) {
  const emitter = new EventEmitter()
  queueMicrotask(() => { emitter.emit('exit', exitCode) })
  return emitter
}

describe('investment Python setup driver', () => {
  it('runs POSIX backend scripts in the fixed order without using caller cwd', async () => {
    const root = '/tmp/项目 with spaces'
    const spawn = vi.fn().mockImplementation(() => child(0))

    await expect(runInvestmentPython('init', {
      repoRoot: root,
      platform: 'darwin',
      spawn,
    })).resolves.toBe(0)

    expect(spawn.mock.calls).toEqual([
      ['bash', [posix.join(root, 'backend/dsh-trading-core/init.sh')], {
        cwd: posix.join(root, 'backend/dsh-trading-core'), stdio: 'inherit',
      }],
      ['bash', [posix.join(root, 'backend/market-watch/init.sh')], {
        cwd: posix.join(root, 'backend/market-watch'), stdio: 'inherit',
      }],
      ['bash', [posix.join(root, 'backend/industry-chain/init.sh')], {
        cwd: posix.join(root, 'backend/industry-chain'), stdio: 'inherit',
      }],
    ])
  })

  it('uses cmd argv entries for Windows paths with spaces and Chinese characters', async () => {
    const root = 'C:\\Program Files\\深度求索'
    const spawn = vi.fn().mockImplementation(() => child(0))

    await expect(runInvestmentPython('verify', {
      repoRoot: root,
      platform: 'win32',
      exists: () => true,
      spawn,
    })).resolves.toBe(0)

    expect(spawn.mock.calls.map(call => [call[0], call[1]])).toEqual([
      ['cmd.exe', ['/d', '/s', '/c', win32.join(root, 'backend/dsh-trading-core/verify.bat')]],
      ['cmd.exe', ['/d', '/s', '/c', win32.join(root, 'backend/market-watch/verify.bat')]],
      ['cmd.exe', ['/d', '/s', '/c', win32.join(root, 'backend/industry-chain/verify.bat'), '--environment']],
    ])
  })

  it('stops at the first failing backend and preserves its exit code', async () => {
    const spawn = vi.fn().mockReturnValue(child(37))
    await expect(runInvestmentPython('init', {
      repoRoot: '/repo',
      platform: 'linux',
      spawn,
    })).resolves.toBe(37)
    expect(spawn).toHaveBeenCalledOnce()
  })

  it('reports every missing environment and never installs during verify', async () => {
    const errors: string[] = []
    const spawn = vi.fn()
    const root = '/tmp/空 格'

    await expect(runInvestmentPython('verify', {
      repoRoot: root,
      platform: 'linux',
      exists: () => false,
      spawn,
      writeError: message => { errors.push(message) },
    })).resolves.toBe(1)

    expect(spawn).not.toHaveBeenCalled()
    const output = errors.join('')
    expect(output).toContain(posix.join(root, 'backend/dsh-trading-core'))
    expect(output).toContain(posix.join(root, 'backend/dsh-trading-core/init.sh'))
    expect(output).toContain(posix.join(root, 'backend/market-watch'))
    expect(output).toContain(posix.join(root, 'backend/market-watch/init.sh'))
    expect(output).toContain(posix.join(root, 'backend/industry-chain'))
    expect(output).toContain(posix.join(root, 'backend/industry-chain/init.sh'))
  })
})
