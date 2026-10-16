import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { load } from 'js-yaml'
import {
  desktopSidecarFingerprint,
  prepareDesktopSidecar,
  validateDesktopSidecarCache,
  type DesktopSidecarOptions,
} from './investment-desktop-sidecar-cache.ts'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const backendModules = { 'dsh-trading-core': 'adapter', 'market-watch': 'market_watch', 'industry-chain': 'industry_chain' }
const target = process.platform === 'win32' ? 'win32-x64' : 'darwin-arm64'
const executable = target === 'win32-x64' ? 'python.exe' : 'bin/python3'
const inputs = [
  '.github/workflows/investment-sidecar.yml',
  'frontend/package.json', 'frontend/pnpm-lock.yaml', 'frontend/pnpm-workspace.yaml', 'frontend/.npmrc',
  'frontend/scripts/build-investment-python-sidecar.ts', 'frontend/scripts/investment-backend-package-policy.ts',
  'frontend/scripts/investment-container-test-payloads.ts', 'frontend/scripts/investment-desktop-sidecar-cache.ts',
  'frontend/apps/electron/src/sidecar-file-hashes.ts',
]

async function put(root: string, path: string, value: string) {
  await mkdir(dirname(join(root, path)), { recursive: true })
  await writeFile(join(root, path), value)
}

async function fixture() {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'desktop-sidecar-cache-'))
  const repoRoot = join(root, 'repo')
  for (const path of inputs) await put(repoRoot, path, '{}')
  await mkdir(join(repoRoot, 'frontend/patches'), { recursive: true })
  const requirements: Record<string, string> = {}
  for (const [backend, module] of Object.entries(backendModules)) {
    const path = `backend/${backend}/requirements.txt`
    requirements[path] = hash('numpy==1.0\n')
    await put(repoRoot, path, 'numpy==1.0\n')
    await put(repoRoot, `backend/${backend}/${module}/app.py`, 'app = None\n')
  }
  const requirementLock = 'frontend/config/investment-python-requirements/test.txt'
  await put(repoRoot, requirementLock, 'numpy==1.0\n')
  await put(repoRoot, 'frontend/config/investment-python-runtime-lock.json', JSON.stringify({
    schemaVersion: 1, requirements,
    targets: Object.fromEntries(['darwin-arm64', 'darwin-x64', 'win32-x64'].map(value => [value, {
      pythonVersion: '3.10.19', archiveUrl: 'https://example.invalid/python.tar.gz', archiveSha256: 'a'.repeat(64),
      archiveRuntimeRoot: 'python', archiveExecutable: `python/${executable}`,
      requirementsLock: requirementLock, requirementsSha256: hash('numpy==1.0\n'),
    }])),
  }))
  const options: DesktopSidecarOptions = { repoRoot, target, compatibility: 'image-1:node-24', cacheRoot: join(root, 'investment-desktop-sidecar'), downloadCache: join(root, 'downloads') }
  const build = vi.fn(async ({ output }: { output: string }) => {
    await rm(output, { recursive: true, force: true })
    const files = [{ path: `runtime/${executable}`, content: 'python binary' }, { path: 'site-packages/native.so', content: 'native library' }]
    for (const [backend, module] of Object.entries(backendModules)) files.push({ path: `backends/${backend}/${module}/app.py`, content: 'app = None\n' })
    for (const file of files) await put(output, file.path, file.content)
    await chmod(join(output, 'runtime', executable), 0o755)
    await mkdir(join(output, 'empty'), { recursive: true })
    await put(output, 'runtime.json', JSON.stringify({
      schemaVersion: 1, python: { platform: target.split('-')[0], arch: target.split('-')[1], version: '3.10.19', executable: `runtime/${executable}` },
      sitePackages: 'site-packages',
      backends: { 'trading-core': { projectDir: 'backends/dsh-trading-core', module: 'adapter.app:app' }, 'market-watch': { projectDir: 'backends/market-watch', module: 'market_watch.app:app' }, 'industry-chain': { projectDir: 'backends/industry-chain', module: 'industry_chain.app:app' } },
      files: files.map(file => ({ path: file.path, sha256: hash(file.content) })).sort((a, b) => a.path < b.path ? -1 : 1),
    }))
  })
  return { root, options, build, payload: join(options.cacheRoot, 'investment-python') }
}

async function withFixture(action: (value: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
  const value = await fixture()
  try { await action(value) } finally { await rm(value.root, { recursive: true, force: true }) }
}

describe('desktop assembled sidecar cache', () => {
  it('builds a missing cache, then verifies every byte without invoking the builder again', async () => withFixture(async ({ options, build }) => {
    expect(await prepareDesktopSidecar(options, { build })).toBe('built')
    expect(await prepareDesktopSidecar(options, { build })).toBe('hit')
    expect(build).toHaveBeenCalledTimes(1)
    expect(await validateDesktopSidecarCache(options)).toBe(true)
  }))

  it.each(['modified', 'extra', 'missing', 'mode', 'empty-directory', 'descriptor', 'metadata'])('rejects %s output and rebuilds', async kind => withFixture(async ({ options, build, payload }) => {
    await prepareDesktopSidecar(options, { build })
    if (kind === 'modified') await writeFile(join(payload, 'site-packages/native.so'), 'changed')
    if (kind === 'extra') await writeFile(join(payload, 'extra.txt'), 'extra')
    if (kind === 'missing') await rm(join(payload, 'site-packages/native.so'))
    if (kind === 'mode') await chmod(join(payload, 'site-packages/native.so'), 0o444)
    if (kind === 'empty-directory') await rm(join(payload, 'empty'), { recursive: true })
    if (kind === 'descriptor') await writeFile(join(payload, 'runtime.json'), '{}')
    if (kind === 'metadata') await writeFile(join(options.cacheRoot, 'metadata.json'), '{')
    expect(await validateDesktopSidecarCache(options)).toBe(false)
    expect(await prepareDesktopSidecar(options, { build })).toBe('built')
    expect(build).toHaveBeenCalledTimes(2)
    expect(await validateDesktopSidecarCache(options)).toBe(true)
  }))

  it('rejects a linked payload directory without following or modifying its destination', async () => withFixture(async ({ root, options, build, payload }) => {
    await prepareDesktopSidecar(options, { build })
    await rm(payload, { recursive: true })
    const outside = join(root, 'outside')
    await put(outside, 'keep.txt', 'keep')
    await symlink(outside, payload, process.platform === 'win32' ? 'junction' : 'dir')
    expect(await validateDesktopSidecarCache(options)).toBe(false)
    expect(await prepareDesktopSidecar(options, { build })).toBe('built')
    expect(await readFile(join(outside, 'keep.txt'), 'utf8')).toBe('keep')
  }))

  it('does not accept an internally consistent but invalid descriptor or private backend payload', async () => withFixture(async ({ options, build, payload }) => {
    const invalidBuild = async (args: { output: string }) => {
      await build(args)
      const path = join(payload, 'runtime.json')
      const descriptor = JSON.parse(await readFile(path, 'utf8')) as { python: { executable: string } }
      descriptor.python.executable = '../escape'
      await writeFile(path, JSON.stringify(descriptor))
    }
    await expect(prepareDesktopSidecar(options, { build: invalidBuild })).rejects.toThrow()
    expect(await validateDesktopSidecarCache(options)).toBe(false)
    const privateBuild = async (args: { output: string }) => {
      await build(args)
      const content = 'api_key = "not-a-real-secret"\n'
      const path = 'backends/dsh-trading-core/adapter/app.py'
      await writeFile(join(payload, path), content)
      const descriptor = JSON.parse(await readFile(join(payload, 'runtime.json'), 'utf8')) as { files: { path: string; sha256: string }[] }
      const file = descriptor.files.find(file => file.path === path)
      if (!file) throw new Error('fixture descriptor entry missing')
      file.sha256 = hash(content)
      await writeFile(join(payload, 'runtime.json'), JSON.stringify(descriptor))
    }
    await expect(prepareDesktopSidecar(options, { build: privateBuild })).rejects.toThrow('privacy')
  }))

  it('invalidates for actual backend files including ignored Python inputs, but not UI sources', async () => withFixture(async ({ options }) => {
    const before = await desktopSidecarFingerprint(options.repoRoot, options.target, options.compatibility)
    await put(options.repoRoot, 'frontend/packages/client/gui/src/example.ts', 'new UI')
    expect(await desktopSidecarFingerprint(options.repoRoot, options.target, options.compatibility)).toBe(before)
    await put(options.repoRoot, '.gitignore', 'backend/dsh-trading-core/adapter/ignored.py\n')
    await put(options.repoRoot, 'backend/dsh-trading-core/adapter/ignored.py', 'value = 1\n')
    expect(await desktopSidecarFingerprint(options.repoRoot, options.target, options.compatibility)).not.toBe(before)
  }))

  it.each([inputs[0], inputs[5], inputs[6], inputs[8], 'frontend/config/investment-python-requirements/test.txt'])('invalidates when %s changes', async path => withFixture(async ({ options }) => {
    const before = await desktopSidecarFingerprint(options.repoRoot, options.target, options.compatibility)
    await writeFile(join(options.repoRoot, path!), 'changed')
    expect(await desktopSidecarFingerprint(options.repoRoot, options.target, options.compatibility)).not.toBe(before)
  }))

  it('separates targets and runner versions, rejects Linux and missing required inputs', async () => withFixture(async ({ options }) => {
    const before = await desktopSidecarFingerprint(options.repoRoot, target, options.compatibility)
    expect(await desktopSidecarFingerprint(options.repoRoot, 'darwin-x64', options.compatibility)).not.toBe(before)
    expect(await desktopSidecarFingerprint(options.repoRoot, target, 'image-2')).not.toBe(before)
    await expect(desktopSidecarFingerprint(options.repoRoot, 'linux-x64', options.compatibility)).rejects.toThrow()
    await rm(join(options.repoRoot, inputs[5]!))
    await expect(desktopSidecarFingerprint(options.repoRoot, target, options.compatibility)).rejects.toThrow()
  }))

  it('does not leave a valid marker after the locked builder fails', async () => withFixture(async ({ options, build, payload }) => {
    await prepareDesktopSidecar(options, { build })
    await writeFile(join(payload, 'site-packages/native.so'), 'changed')
    await expect(prepareDesktopSidecar(options, { build: async () => { throw new Error('pip failed') } })).rejects.toThrow('pip failed')
    await expect(lstat(join(options.cacheRoot, 'metadata.json'))).rejects.toThrow()
    expect(await validateDesktopSidecarCache(options)).toBe(false)
  }))

  it('refuses to seal metadata when build inputs change during assembly', async () => withFixture(async ({ options, build }) => {
    await expect(prepareDesktopSidecar(options, { build: async (args) => {
      await build(args)
      await put(options.repoRoot, 'backend/dsh-trading-core/adapter/app.py', 'changed = True\n')
    } })).rejects.toThrow('inputs changed')
    await expect(lstat(join(options.cacheRoot, 'metadata.json'))).rejects.toThrow()
  }))

  it.each(['metadata-directory', 'extra-root-file'])('rebuilds a damaged dedicated cache shell: %s', async kind => withFixture(async ({ options, build }) => {
    await prepareDesktopSidecar(options, { build })
    if (kind === 'metadata-directory') {
      await rm(join(options.cacheRoot, 'metadata.json'))
      await mkdir(join(options.cacheRoot, 'metadata.json'))
    } else await put(options.cacheRoot, 'unexpected', 'extra')
    expect(await prepareDesktopSidecar(options, { build })).toBe('built')
    expect(await validateDesktopSidecarCache(options)).toBe(true)
  }))

  it('rejects unsafe cleanup roots without deleting their files', async () => withFixture(async ({ root, options, build }) => {
    const outside = join(root, 'outside')
    await put(outside, 'keep', 'preserve')
    await symlink(outside, options.cacheRoot, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(prepareDesktopSidecar(options, { build })).rejects.toThrow()
    await expect(prepareDesktopSidecar({ ...options, cacheRoot: root }, { build })).rejects.toThrow('dedicated')
    await expect(prepareDesktopSidecar({ ...options, cacheRoot: join(options.repoRoot, 'investment-desktop-sidecar') }, { build })).rejects.toThrow('overlap')
    expect(await readFile(join(outside, 'keep'), 'utf8')).toBe('preserve')
    expect(build).not.toHaveBeenCalled()
  }))

  it('rejects a download-cache alias into the disposable cache before clearing it', async () => withFixture(async ({ root, options, build }) => {
    await put(options.cacheRoot, 'keep', 'preserve')
    const alias = join(root, 'download-alias')
    await symlink(options.cacheRoot, alias, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(prepareDesktopSidecar({ ...options, downloadCache: join(alias, 'not-created') }, { build })).rejects.toThrow('overlap')
    expect(await readFile(join(options.cacheRoot, 'keep'), 'utf8')).toBe('preserve')
    expect(build).not.toHaveBeenCalled()
  }))

  it('rejects a dangling download alias before clearing the cache', async () => withFixture(async ({ root, options, build }) => {
    await put(options.cacheRoot, 'keep', 'preserve')
    const alias = join(root, 'dangling-download-alias')
    await symlink(join(options.cacheRoot, 'not-created'), alias, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(prepareDesktopSidecar({ ...options, downloadCache: join(alias, 'nested') }, { build })).rejects.toThrow('unresolvable')
    expect(await readFile(join(options.cacheRoot, 'keep'), 'utf8')).toBe('preserve')
    expect(build).not.toHaveBeenCalled()
  }))

  it('ignores excluded source links but rejects retained source links', async () => withFixture(async ({ root, options }) => {
    const before = await desktopSidecarFingerprint(options.repoRoot, options.target, options.compatibility)
    const outside = join(root, 'outside')
    await mkdir(outside)
    const backend = join(options.repoRoot, 'backend/dsh-trading-core')
    await symlink(outside, join(backend, 'env'), process.platform === 'win32' ? 'junction' : 'dir')
    expect(await desktopSidecarFingerprint(options.repoRoot, options.target, options.compatibility)).toBe(before)
    await rm(join(backend, 'adapter'), { recursive: true })
    await symlink(outside, join(backend, 'adapter'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(desktopSidecarFingerprint(options.repoRoot, options.target, options.compatibility)).rejects.toThrow('link')
  }))

  it('rejects links at file-only allowlist paths', async () => withFixture(async ({ root, options }) => {
    const outside = join(root, 'outside')
    await mkdir(outside)
    await symlink(outside, join(options.repoRoot, 'backend/dsh-trading-core/LICENSE'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(desktopSidecarFingerprint(options.repoRoot, options.target, options.compatibility)).rejects.toThrow('link')
  }))

  it('keeps the cache intact when a copied application is signed or cleaned', async () => withFixture(async ({ root, options, build, payload }) => {
    await prepareDesktopSidecar(options, { build })
    const copy = join(root, 'app', 'investment-python')
    await cp(payload, copy, { recursive: true })
    await writeFile(join(copy, 'runtime', executable), 'signed binary')
    await chmod(join(copy, 'runtime', executable), 0o555)
    await rm(join(root, 'app'), { recursive: true })
    expect(await validateDesktopSidecarCache(options)).toBe(true)
  }))

  it.skipIf(process.env.DSH_TEST_DESKTOP_CACHE_TAR !== '1')('preserves cached bytes and permissions through the CI GNU tar archive', async () => withFixture(async ({ root, options, build, payload }) => {
    await prepareDesktopSidecar(options, { build: async (args) => {
      await build(args)
      await chmod(join(payload, 'site-packages/native.so'), 0o444)
      if (process.platform !== 'win32') {
        await chmod(join(payload, 'runtime', executable), 0o775)
        await chmod(join(payload, 'backends/dsh-trading-core/adapter/app.py'), 0o664)
        await chmod(join(payload, 'empty'), 0o770)
      }
    } })
    // Preserve the entire cache exactly, including the payload root mode.
    const tar = process.platform === 'darwin' ? 'gtar' : process.platform === 'win32'
      ? join(process.env.ProgramFiles ?? 'C:/Program Files', 'Git/usr/bin/tar.exe') : 'tar'
    expect(execFileSync(tar, ['--version'], { encoding: 'utf8' })).toContain('GNU tar')
    const sourceMode = (await lstat(payload)).mode
    const archive = join(root, 'cache.tar')
    execFileSync(tar, ['--force-local', '-cf', archive, '-C', options.cacheRoot, '.'])
    const restored = join(root, 'restored')
    await mkdir(restored)
    execFileSync(tar, ['--force-local', '-xf', archive, '-C', restored], { env: { ...process.env, TAR_OPTIONS: '--same-permissions' } })
    expect((await lstat(join(restored, 'investment-python'))).mode).toBe(sourceMode)
    expect(await validateDesktopSidecarCache({ ...options, cacheRoot: restored })).toBe(true)
  }))
})

// The cache's integrity manifest does not establish producer authority; this workflow does.
it('only saves accepted master-push candidates, after native and final ZIP checks', async () => {
  interface Step { name?: string; uses?: string; if?: string; env?: Record<string, string>; with?: Record<string, string>; 'continue-on-error'?: boolean }
  const workflow = load(await readFile(new URL('../../.github/workflows/investment-sidecar.yml', import.meta.url), 'utf8')) as {
    on: { push: { branches: string[] }; pull_request: unknown; workflow_dispatch: unknown }
    permissions: Record<string, string>
    jobs: { 'package-smoke': { needs: string; steps: Step[] } }
  }
  expect(workflow.on.push.branches).toEqual(['master'])
  expect(workflow.permissions).toEqual({ contents: 'read' })
  const job = workflow.jobs['package-smoke']
  expect(job.needs).toBe('shared-build')
  const restore = job.steps.find(step => step.name === 'Restore assembled desktop sidecar')!
  const save = job.steps.find(step => step.name === 'Save accepted mainline desktop sidecar')!
  const validate = job.steps.find(step => step.name === 'Revalidate unsigned cache source after final package acceptance')!
  expect(restore.uses).toMatch(/^actions\/cache\/restore@[a-f0-9]{40}$/u)
  expect(restore.env?.TAR_OPTIONS).toBe('--same-permissions')
  expect(save.uses).toMatch(/^actions\/cache\/save@[a-f0-9]{40}$/u)
  expect(save.if).toBe("github.event_name == 'push' && github.ref == 'refs/heads/master' && env.INVESTMENT_DESKTOP_SIDECAR_BUILT == 'true'")
  expect(validate.if).toBe(save.if)
  expect(save['continue-on-error']).toBeUndefined()
  expect(validate['continue-on-error']).toBeUndefined()
  expect(job.steps.indexOf(validate)).toBeGreaterThan(job.steps.findIndex(step => step.name === 'Smoke final desktop ZIP'))
  expect(job.steps.indexOf(save)).toBeGreaterThan(job.steps.indexOf(validate))
  expect(save.with?.path).toBe(restore.with?.path)
  expect(save.with?.key).toBe(restore.with?.key)
  expect(restore.with?.['restore-keys']).toBe('${{ steps.desktop_cache.outputs.prefix }}')
  expect(job.steps.find(step => step.name === 'Test backend package privacy gates')?.env?.DSH_TEST_DESKTOP_CACHE_TAR).toBe('1')
})
