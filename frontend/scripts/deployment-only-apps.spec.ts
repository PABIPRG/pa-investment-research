import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { checkWorkspace } from './check-workspace-constraints.ts'
import { isDeploymentOnlyApp } from './deployment-only-apps.ts'
import { WorkspacePackageSet } from './publish-npm-baseline.ts'
import { releaseFamily } from './release/families.ts'

const directory = 'apps/public-observatory'
const name = '@deepseek-ai/dsh-public-observatory'
const manifest = { name, version: '9.0.0', private: true, type: 'module' }
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true }) })

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'deployment-only-'))
  roots.push(root)
  for (const [dir, value] of Object.entries({
    '.': { version: '1.0.0' },
    [directory]: manifest,
    'apps/web': { name: '@deepseek-ai/dsh-web-frontend', version: '1.0.0' },
    'packages/host/public-observatory': { name: '@deepseek-ai/dsh-host-public-observatory', version: '1.0.0' },
  })) {
    mkdirSync(join(root, dir), { recursive: true })
    writeFileSync(join(root, dir, 'package.json'), JSON.stringify(value))
  }
  return root
}

describe('独立部署应用发布边界', () => {
  it('允许已登记的私有站点拥有独立版本，不要求 npm 发布元数据', () => {
    expect(isDeploymentOnlyApp(directory, manifest)).toBe(true)
    expect(checkWorkspace({ dir: directory, manifest })).toEqual([])
  })

  it.each([undefined, false])('拒绝 private=%s 的观察室', (value) => {
    const candidate = { name, version: manifest.version, type: manifest.type, ...(value === undefined ? {} : { private: value }) }
    expect(() => checkWorkspace({ dir: directory, manifest: candidate }))
      .toThrow(/private: true/)
  })

  it('拒绝目录或包名漂移；普通私有应用仍须通过原发布门禁', () => {
    expect(() => isDeploymentOnlyApp('apps/other', manifest)).toThrow(/deployment-only/)
    expect(() => isDeploymentOnlyApp(directory, { ...manifest, name: '@deepseek-ai/dsh-other' })).toThrow(/deployment-only/)
    const errors = checkWorkspace({ dir: 'apps/other', manifest: { ...manifest, name: '@deepseek-ai/dsh-other' } })
    expect(errors).toContainEqual(expect.stringContaining('must not set "private": true'))
    expect(errors).toContainEqual(expect.stringContaining('version must match root'))
    expect(errors).toContainEqual(expect.stringContaining('no publication files policy'))
  })

  it('新旧发布入口及实际 pack 筛选都排除独立站，保留网关', () => {
    const root = fixture()
    const expected = ['@deepseek-ai/dsh-host-public-observatory', '@deepseek-ai/dsh-web-frontend']
    expect(releaseFamily('dsh').members(root).map(pkg => pkg.name).sort()).toEqual(expected)
    const baseline = WorkspacePackageSet.discover(root)
    expect(baseline.packages.map(pkg => pkg.name)).toEqual(expected)
    expect(baseline.packFilters()).toEqual(expected.flatMap(pkg => ['--filter', pkg]))
    const original = readFileSync(join(root, directory, 'package.json'), 'utf8')
    baseline.stage(root, '1.0.1')
    expect(readFileSync(join(root, directory, 'package.json'), 'utf8')).toBe(original)
    expect(JSON.parse(readFileSync(join(root, 'apps/web/package.json'), 'utf8'))).toMatchObject({ version: '1.0.1' })
  })
})
