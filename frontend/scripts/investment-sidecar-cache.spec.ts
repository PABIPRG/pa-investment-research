import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

interface CacheModule {
  fingerprint(root: string): Promise<string>
  seal(root: string, key: string): Promise<void>
  restore(root: string, key: string, output: string): Promise<boolean>
}
const helperUrl = new URL('../../containers/investment-sidecar-cache.mjs', import.meta.url)
const cache = await import(helperUrl.href) as CacheModule
const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'investment-sidecar-cache-'))
  roots.push(root)
  await mkdir(join(root, 'sidecar/runtime/bin'), { recursive: true })
  await writeFile(join(root, 'sidecar/runtime/bin/python3'), 'fixture-python', { mode: 0o755 })
  await writeFile(join(root, 'sidecar/runtime.json'), JSON.stringify({
    schemaVersion: 1,
    python: { platform: 'linux', arch: 'x64', executable: 'runtime/bin/python3' },
    files: [{ path: 'runtime/bin/python3', sha256: createHash('sha256').update('fixture-python').digest('hex') }],
  }))
  return root
}

describe('scanned container sidecar cache', () => {
  const key = 'a'.repeat(64)

  it('restores a complete sealed sidecar and preserves executable permissions', async () => {
    const root = await fixture()
    await cache.seal(root, key)
    const output = join(root, 'restored')
    expect(await cache.restore(root, key, output)).toBe(true)
    expect(await readFile(join(output, 'runtime/bin/python3'), 'utf8')).toBe('fixture-python')
    expect((await stat(join(output, 'runtime/bin/python3'))).mode & 0o111).toBe(0o111)
  })

  it('treats an absent cache and an input mismatch as misses without installing files', async () => {
    const root = await fixture()
    const output = join(root, 'restored')
    expect(await cache.restore(root, key, output)).toBe(false)
    await cache.seal(root, key)
    expect(await cache.restore(root, 'b'.repeat(64), output)).toBe(false)
    await expect(readFile(join(output, 'runtime.json'))).rejects.toThrow()
  })

  it.each(['changed', 'extra', 'missing', 'symlink', 'mode', 'descriptor', 'metadata'])('rejects %s cache corruption', async change => {
    const root = await fixture()
    await cache.seal(root, key)
    const executable = join(root, 'sidecar/runtime/bin/python3')
    if (change === 'changed') await writeFile(executable, 'corrupt')
    if (change === 'extra') await writeFile(join(root, 'sidecar/extra'), 'unlisted')
    if (change === 'missing') await rm(executable)
    if (change === 'symlink') await symlink(executable, join(root, 'sidecar/link'))
    if (change === 'mode') await chmod(executable, 0o644)
    if (change === 'descriptor') await writeFile(join(root, 'sidecar/runtime.json'), '{}')
    if (change === 'metadata') await writeFile(join(root, 'metadata.json'), '{broken')
    expect(await cache.restore(root, key, join(root, 'restored'))).toBe(false)
  })

  it('refuses to seal an output that disagrees with its runtime descriptor', async () => {
    const root = await fixture()
    await writeFile(join(root, 'sidecar/runtime/bin/python3'), 'not-described')
    await expect(cache.seal(root, key)).rejects.toThrow()
  })

  it('uses CLI exit codes to select a verified restore or the original cold build', async () => {
    const root = await fixture()
    const output = join(root, 'cli-restored')
    const restore = () => spawnSync(process.execPath, [fileURLToPath(helperUrl), 'restore', root, key, output], { encoding: 'utf8' })
    expect(restore().status).toBe(1)
    execFileSync(process.execPath, [fileURLToPath(helperUrl), 'seal', root, key])
    const hit = restore()
    expect(hit.status).toBe(0)
    expect(hit.stdout).toContain('verified hit')
    await writeFile(join(root, 'sidecar/runtime/bin/python3'), 'corrupt')
    expect(restore().status).toBe(1)
  })

  it('checks nested runtime.json bytes even though the builder omits them from its descriptor', async () => {
    const root = await fixture()
    const nested = join(root, 'sidecar/runtime/runtime.json')
    await writeFile(nested, '{}')
    await cache.seal(root, key)
    expect(await cache.restore(root, key, join(root, 'restored'))).toBe(true)
    await writeFile(nested, '{"changed":true}')
    expect(await cache.restore(root, key, join(root, 'restored'))).toBe(false)
  })

  it('keeps UI-only changes warm and invalidates backend, lock, packaging, and toolchain changes', async () => {
    const root = await fixture()
    execFileSync('git', ['init', '-q', root])
    const paths = [
      'Dockerfile', 'containers/investment-sidecar-cache.mjs',
      'backend/dsh-trading-core/adapter/app.py', 'backend/market-watch/requirements.txt',
      'backend/industry-chain/industry_chain/app.py',
      'frontend/config/investment-python-runtime-lock.json',
      'frontend/config/investment-python-requirements/linux-x64.txt',
      'frontend/scripts/build-investment-python-sidecar.ts',
      'frontend/scripts/investment-backend-package-policy.ts',
      'frontend/scripts/investment-container-test-payloads.ts',
      'frontend/pnpm-lock.yaml', 'frontend/pnpm-workspace.yaml', 'frontend/.npmrc',
      'frontend/patches/dependency.patch', 'frontend/packages/any/package/package.json',
    ]
    for (const path of [...paths, 'frontend/apps/web/src/app.tsx']) {
      await mkdir(join(root, path, '..'), { recursive: true })
      await writeFile(join(root, path), 'original')
    }
    const baseline = await cache.fingerprint(root)
    await writeFile(join(root, 'frontend/apps/web/src/app.tsx'), 'UI-only edit')
    expect(await cache.fingerprint(root)).toBe(baseline)
    for (const path of paths) {
      await writeFile(join(root, path), 'changed')
      expect(await cache.fingerprint(root), path).not.toBe(baseline)
      await writeFile(join(root, path), 'original')
    }
    const added = join(root, 'backend/dsh-trading-core/adapter/new.py')
    await writeFile(added, 'new backend module')
    expect(await cache.fingerprint(root)).not.toBe(baseline)
    await rm(added)
    expect(await cache.fingerprint(root)).toBe(baseline)
    await rm(join(root, paths[2]!))
    expect(await cache.fingerprint(root)).not.toBe(baseline)
  })
})
