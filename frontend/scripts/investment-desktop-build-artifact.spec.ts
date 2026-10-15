import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import * as yaml from 'js-yaml'
import { afterEach, describe, expect, it } from 'vitest'
import { captureDesktopBuild, restoreDesktopBuild } from './investment-desktop-build-artifact.js'

const revision = 'a'.repeat(40)
const temporary: string[] = []
const entries = ['apps/cli/lib/bin.js', 'apps/electron/lib/index.js', 'apps/electron/lib/main.js',
  'apps/electron/lib/preload.cjs', 'apps/web/dist/index.html', 'apps/electron/renderer/index.html',
  'native/landlock-run/packages/entry/lib/index.js', 'packages/client/ui-theme/lib/styles/base.css']
function put(root: string, path: string, text = path) {
  mkdirSync(dirname(resolve(root, path)), { recursive: true })
  writeFileSync(resolve(root, path), text)
}
function fixture() {
  const root = mkdtempSync(resolve(tmpdir(), 'desktop-build-artifact-'))
  temporary.push(root)
  const source = resolve(root, 'source')
  const target = resolve(root, 'target')
  const artifact = resolve(root, 'artifact')
  for (const entry of entries) put(source, entry)
  put(source, 'apps/electron/lib/tsconfig.tsbuildinfo')
  put(source, 'native/landlock-run/packages/entry/lib/.tsbuildinfo')
  put(source, 'node_modules/native-addon.node')
  put(source, 'native/landlock-run/packages/linux-x64/bin/landlock')
  chmodSync(resolve(source, entries[0]!), 0o755)
  put(target, 'apps/electron/src/main.ts', 'source must survive')
  put(target, 'node_modules/native-addon.node', 'native must survive')
  put(target, 'apps/electron/lib/stale.js')
  return { root, source, target, artifact }
}
afterEach(() => { for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('same-run portable desktop build', () => {
  it('restores compiled outputs and executable modes while retaining native dependencies and source', () => {
    const { source, target, artifact } = fixture()
    captureDesktopBuild(source, artifact, revision)
    // GitHub artifact downloads normalize file permissions.
    chmodSync(resolve(artifact, 'payload', entries[0]!), 0o644)
    restoreDesktopBuild(target, artifact, revision)
    for (const entry of entries) expect(readFileSync(resolve(target, entry), 'utf8')).toBe(entry)
    if (process.platform !== 'win32') expect(statSync(resolve(target, entries[0]!)).mode & 0o777).toBe(0o755)
    expect(existsSync(resolve(target, 'apps/electron/lib/stale.js'))).toBe(false)
    expect(existsSync(resolve(target, 'apps/electron/lib/tsconfig.tsbuildinfo'))).toBe(false)
    expect(existsSync(resolve(target, 'native/landlock-run/packages/entry/lib/.tsbuildinfo'))).toBe(false)
    expect(readFileSync(resolve(target, 'node_modules/native-addon.node'), 'utf8')).toBe('native must survive')
    expect(readFileSync(resolve(target, 'apps/electron/src/main.ts'), 'utf8')).toBe('source must survive')
  })

  it.each(['revision', 'corrupt', 'missing', 'extra', 'traversal', 'duplicate', 'mode'])('rejects %s before changing the checkout', (kind) => {
    const { source, target, artifact } = fixture()
    captureDesktopBuild(source, artifact, revision)
    const manifestPath = resolve(artifact, 'manifest.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { revision: string; files: { path: string; mode: number }[] }
    if (kind === 'revision') manifest.revision = 'b'.repeat(40)
    if (kind === 'corrupt') put(artifact, `payload/${entries[0]!}`, 'tampered')
    if (kind === 'missing') rmSync(resolve(artifact, 'payload', entries[0]!))
    if (kind === 'extra') put(artifact, 'payload/apps/electron/lib/unlisted.js')
    if (kind === 'traversal') manifest.files[0]!.path = '../source.ts'
    if (kind === 'duplicate') manifest.files.push(manifest.files[0]!)
    if (kind === 'mode') manifest.files[0]!.mode = 0o777
    writeFileSync(manifestPath, JSON.stringify(manifest))
    expect(() => { restoreDesktopBuild(target, artifact, revision) }).toThrow()
    expect(readFileSync(resolve(target, 'apps/electron/lib/stale.js'), 'utf8')).toBe('apps/electron/lib/stale.js')
  })

  it('requires the runtime entries and rejects native binaries in the shared build', () => {
    const { source, artifact } = fixture()
    rmSync(resolve(source, 'apps/web/dist/index.html'))
    expect(() => { captureDesktopBuild(source, artifact, revision) }).toThrow(/entry/)
    put(source, 'apps/web/dist/index.html')
    put(source, 'apps/electron/lib/addon.node')
    expect(() => { captureDesktopBuild(source, artifact, revision) }).toThrow(/output/)
  })

  it.each(['4d5a0000', '7f454c46', 'feedfacf', 'cafebabf', 'bfbafeca'])('rejects native magic %s disguised as JavaScript', (magic) => {
    const { source, artifact } = fixture()
    writeFileSync(resolve(source, 'apps/electron/lib/main.js'), Buffer.from(magic, 'hex'))
    expect(() => { captureDesktopBuild(source, artifact, revision) }).toThrow(/Native executable/)
  })

  it.skipIf(process.platform === 'win32')('rejects symbolic links in both the artifact and destination ancestors', () => {
    const { source, target, artifact, root } = fixture()
    captureDesktopBuild(source, artifact, revision)
    const payload = resolve(artifact, 'payload', entries[0]!)
    rmSync(payload)
    symlinkSync(resolve(source, entries[0]!), payload)
    expect(() => { restoreDesktopBuild(target, artifact, revision) }).toThrow(/link/)
    rmSync(artifact, { recursive: true })
    captureDesktopBuild(source, artifact, revision)
    rmSync(resolve(target, 'apps/electron/lib'), { recursive: true })
    symlinkSync(root, resolve(target, 'apps/electron/lib'))
    expect(() => { restoreDesktopBuild(target, artifact, revision) }).toThrow(/link/)
    expect(existsSync(resolve(root, 'source'))).toBe(true)
    unlinkSync(resolve(target, 'apps/electron/lib'))
    symlinkSync(resolve(root, 'missing'), resolve(target, 'apps/electron/lib'))
    expect(() => { restoreDesktopBuild(target, artifact, revision) }).toThrow(/link/)
  })

  it('builds once and binds native restore to the exact artifact from this run, retaining final acceptance', () => {
    const workflow = yaml.load(readFileSync(resolve(import.meta.dirname, '../../.github/workflows/investment-sidecar.yml'), 'utf8')) as {
      jobs: Record<string, {
        needs?: string
        steps: { name?: string; uses?: string; run?: string; with?: Record<string, unknown> }[]
      }>
    }
    const shared = workflow.jobs['shared-build']!
    const native = workflow.jobs['package-smoke']!
    expect(shared.steps.filter(step => step.run === 'pnpm run build')).toHaveLength(1)
    expect(native.needs).toBe('shared-build')
    expect(shared.steps.find(step => step.run?.includes('investment-desktop-build-artifact.ts capture'))?.run)
      .toContain('${{ github.sha }}')
    const download = native.steps.find(step => step.uses?.startsWith('actions/download-artifact@'))!
    expect(download.with?.['artifact-ids']).toBe('${{ needs.shared-build.outputs.artifact-id }}')
    expect(download.with?.['run-id']).toBeUndefined()
    expect(download.with?.['merge-multiple']).toBe(true)
    const commands = native.steps.map(step => step.run ?? '').join('\n')
    expect(commands).not.toContain('pnpm run make:electron')
    expect(native.steps.find(step => step.run?.includes('investment-desktop-build-artifact.ts restore'))?.run)
      .toContain('${{ github.sha }}')
    expect(commands).toContain('apps/electron/src/packaging.ts make')
    expect(commands).toContain('codesign --verify --deep --strict')
    expect(commands).toContain('scripts/smoke-investment-python-sidecar.ts')
    expect(commands).toContain('scripts/smoke-investment-desktop.ts')
    const restoreIndex = native.steps.findIndex(step => step.run?.includes('investment-desktop-build-artifact.ts restore'))
    expect(restoreIndex).toBeGreaterThan(native.steps.findIndex(step => step.run === 'pnpm install --frozen-lockfile'))
    expect(restoreIndex).toBeLessThan(native.steps.findIndex(step => step.run?.includes('packaging.ts make')))
  })
})
