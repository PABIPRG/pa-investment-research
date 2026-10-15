import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmod, cp, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { load } from 'js-yaml'
import { afterEach, describe, expect, it } from 'vitest'

interface CacheModule {
  fingerprint(root: string): Promise<string>
  seal(root: string, key: string): Promise<void>
  restore(root: string, key: string, output: string): Promise<boolean>
}
const helperUrl = new URL('../../containers/investment-sidecar-cache.mjs', import.meta.url)
const cache = await import(helperUrl.href) as CacheModule
const roots: string[] = []
const tarCommand = process.platform === 'darwin' ? 'gtar' : 'tar'
const hasGnuTar = process.platform !== 'win32' && spawnSync(tarCommand, ['--version'], { encoding: 'utf8' }).stdout?.includes('GNU tar')
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'investment-sidecar-cache-'))
  roots.push(root)
  const files = [
    { path: 'runtime/bin/python3', content: 'fixture-python', mode: 0o775 },
    { path: 'runtime/lib/python3.10/site-packages/certifi/cacert.pem', content: 'public CA fixture', mode: 0o664 },
    { path: 'runtime/lib/python3.10/site-packages/package/data/schema.json', content: '{}', mode: 0o664 },
  ]
  for (const file of files) {
    await mkdir(join(root, 'sidecar', file.path, '..'), { recursive: true })
    await writeFile(join(root, 'sidecar', file.path), file.content)
    await chmod(join(root, 'sidecar', file.path), file.mode)
  }
  await writeFile(join(root, 'sidecar/runtime.json'), JSON.stringify({
    schemaVersion: 1,
    python: { platform: 'linux', arch: 'x64', executable: 'runtime/bin/python3' },
    files: files.map(({ path, content }) => ({ path, sha256: createHash('sha256').update(content).digest('hex') })),
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

  it.skipIf(process.platform !== 'linux' && !hasGnuTar)('preserves sealed modes through the Actions GNU tar restore under a restrictive umask', async () => {
    expect(hasGnuTar).toBe(true)
    // Hosted Linux CI and local reproduction run as non-root, like actions/cache.
    expect(process.getuid?.()).not.toBe(0)
    const root = await fixture()
    await cache.seal(root, key)
    const archive = join(root, 'cache.tar')
    execFileSync(tarCommand, ['--posix', '-cf', archive, '-C', root, 'sidecar', 'metadata.json'], {
      env: { ...process.env, TAR_OPTIONS: '' },
    })
    const workflow = load(await readFile(new URL('../../.github/workflows/investment-container.yml', import.meta.url), 'utf8')) as {
      jobs: { 'image-smoke': { steps: { name?: string; env?: Record<string, string> }[] } }
    }
    const restoreEnv = workflow.jobs['image-smoke'].steps.find(step => step.name === 'Restore a previously scanned sidecar')?.env
    const extract = async (name: string, tarOptions: string) => {
      const output = join(root, name)
      await mkdir(output)
      execFileSync(process.execPath, ['-e', `
        process.umask(0o022)
        require('node:child_process').execFileSync(process.argv[1], ['-xf', process.argv[2], '-P', '-C', process.argv[3]], { stdio: 'inherit' })
      `, tarCommand, archive, output], { env: { ...process.env, TAR_OPTIONS: tarOptions } })
      return output
    }
    const unpreserved = await extract('default-restore', '')
    expect((await stat(join(unpreserved, 'sidecar/runtime/bin/python3'))).mode & 0o777).toBe(0o755)
    expect(await cache.restore(unpreserved, key, join(root, 'rejected'))).toBe(false)
    const preserved = await extract('workflow-restore', restoreEnv?.TAR_OPTIONS ?? '')
    expect((await stat(join(preserved, 'sidecar/runtime/bin/python3'))).mode & 0o777).toBe(0o775)
    expect((await stat(join(preserved, 'sidecar/runtime/lib/python3.10/site-packages/certifi/cacert.pem'))).mode & 0o777).toBe(0o664)
    expect(await cache.restore(preserved, key, join(root, 'accepted'))).toBe(true)
  })

  // The container CI lane requires this real Docker transfer; ordinary host suites stay Docker-free.
  it.skipIf(process.env.DSH_TEST_DOCKER_CONTEXT !== '1')('keeps a sealed sidecar intact through Docker context filtering while excluding private source files', async () => {
    const root = await fixture()
    await cache.seal(root, key)
    const context = await mkdtemp(join(tmpdir(), 'investment-cache-context-'))
    roots.push(context)
    await cp(root, join(context, '.investment-sidecar-cache'), { recursive: true })
    await cp(new URL('../../.dockerignore', import.meta.url), join(context, '.dockerignore'))
    const privateFiles = ['private.pem', '.env', 'nested/credentials.json', 'user/data/account.json', 'secrets/token']
    for (const path of privateFiles) {
      await mkdir(join(context, path, '..'), { recursive: true })
      await writeFile(join(context, path), 'excluded fixture')
    }
    await writeFile(join(context, 'Dockerfile'), 'FROM scratch\nCOPY . /\n')
    const output = join(root, 'exported-context')
    execFileSync('docker', ['build', '--network=none', '--output', `type=local,dest=${output}`, context], {
      env: { ...process.env, DOCKER_BUILDKIT: '1' }, encoding: 'utf8', timeout: 120_000,
    })
    const restored = join(root, 'restored-from-context')
    expect(await cache.restore(join(output, '.investment-sidecar-cache'), key, restored)).toBe(true)
    expect(await readFile(join(restored, 'runtime/lib/python3.10/site-packages/certifi/cacert.pem'), 'utf8')).toBe('public CA fixture')
    expect(await readFile(join(restored, 'runtime/lib/python3.10/site-packages/package/data/schema.json'), 'utf8')).toBe('{}')
    expect((await stat(join(restored, 'runtime/bin/python3'))).mode & 0o111).toBe(0o111)
    for (const path of privateFiles) await expect(stat(join(output, path))).rejects.toMatchObject({ code: 'ENOENT' })
  }, 180_000)

  it('treats an absent cache and an input mismatch as misses without installing files', async () => {
    const root = await fixture()
    const output = join(root, 'restored')
    expect(await cache.restore(root, key, output)).toBe(false)
    await cache.seal(root, key)
    expect(await cache.restore(root, 'b'.repeat(64), output)).toBe(false)
    await expect(readFile(join(output, 'runtime.json'))).rejects.toThrow()
  })

  it.each(['changed', 'extra', 'missing', 'symlink', 'mode', 'descriptor', 'metadata'])('rejects %s cache corruption', async (change) => {
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
