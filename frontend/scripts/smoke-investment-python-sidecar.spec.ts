import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { smokeInvestmentPythonSidecar } from './smoke-investment-python-sidecar.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async root => { await rm(root, { recursive: true, force: true }) }))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'investment sidecar smoke '))
  roots.push(root)
  const files = {
    'runtime/bin/python3': 'python',
    'site-packages/native.so': 'native',
    'backends/dsh-trading-core/adapter/app.py': 'trading',
    'backends/market-watch/market_watch/app.py': 'market',
  }
  for (const [path, value] of Object.entries(files)) {
    const absolute = join(root, ...path.split('/'))
    await mkdir(join(absolute, '..'), { recursive: true })
    await writeFile(absolute, value)
  }
  const descriptor = {
    schemaVersion: 1,
    python: { version: '3.10.18', platform: 'darwin', arch: 'arm64', executable: 'runtime/bin/python3' },
    sitePackages: 'site-packages',
    backends: {
      'trading-core': { projectDir: 'backends/dsh-trading-core', module: 'adapter.app:app' },
      'market-watch': { projectDir: 'backends/market-watch', module: 'market_watch.app:app' },
    },
    files: Object.entries(files).sort(([left], [right]) => left.localeCompare(right)).map(([path, value]) => ({
      path, sha256: createHash('sha256').update(value).digest('hex'),
    })),
  }
  await writeFile(join(root, 'runtime.json'), JSON.stringify(descriptor))
  return { root }
}

describe('investment Python sidecar smoke', () => {
  it('uses the sidecar interpreter to import native dependencies and verify both health routes', async () => {
    const { root } = await fixture()
    const runCommand = vi.fn(async (_command: string, _args: readonly string[], _cwd: string) => 0)
    await smokeInvestmentPythonSidecar(root, { runCommand })

    expect(runCommand).toHaveBeenCalledOnce()
    const [command, args, cwd] = runCommand.mock.calls[0]!
    expect(command).toBe(join(root, 'runtime/bin/python3'))
    expect(cwd).toBe(root)
    expect(args[0]).toBe('-c')
    expect(args[1]).toContain('"numpy", "pandas", "uvicorn"')
    expect(args[1]).toContain('/health')
    expect(args[1]).toContain('adapter.app:app')
    expect(args[1]).toContain('market_watch.app:app')
  })

  it('rejects corrupt files before launch and reports interpreter/import failures', async () => {
    const { root } = await fixture()
    const runCommand = vi.fn(async (_command: string, _args: readonly string[], _cwd: string) => 0)
    await writeFile(join(root, 'site-packages/native.so'), 'corrupt')
    await expect(smokeInvestmentPythonSidecar(root, { runCommand })).rejects.toThrow(/hash mismatch/u)
    expect(runCommand).not.toHaveBeenCalled()

    const healthy = await fixture()
    await expect(smokeInvestmentPythonSidecar(healthy.root, {
      runCommand: async () => 17,
    })).rejects.toThrow(/smoke failed with exit code 17/u)
  })
})
