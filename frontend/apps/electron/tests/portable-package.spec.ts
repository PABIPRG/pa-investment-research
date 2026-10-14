/** Windows portable copies retain the deployed dependency graph after relocation. */
import { mkdtemp, mkdir, writeFile, symlink, rm, lstat, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { describe, it, expect } from 'vitest'
import { copyPortablePackageTree } from '../src/packaging.ts'

describe('portable package dependencies', () => {
  it('preserves transitive versions and cycles after dereferencing and relocating a pnpm tree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'portable-dependency-graph-'))
    const source = join(root, 'source')
    const destination = join(root, 'relocated')
    const packageDir = (name: string, version: string) => join(source, 'node_modules/.pnpm', `${name}@${version}`, 'node_modules', name)
    const dependencyLink = async (owner: string, name: string, target: string) => {
      const link = join(owner, 'node_modules', name)
      await mkdir(dirname(link), { recursive: true })
      await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir')
    }
    const writePackage = async (directory: string, name: string, version: string, dependencies: Record<string, string>, body: string) => {
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, 'package.json'), JSON.stringify({ name, version, main: 'index.cjs', dependencies }))
      await writeFile(join(directory, 'index.cjs'), body)
    }
    try {
      const first = packageDir('first', '1')
      const second = packageDir('second', '1')
      const one = packageDir('dependency', '1')
      const two = packageDir('dependency', '2')
      await writePackage(source, 'app', '1', { first: '1', second: '1' }, "module.exports = [require('first'), require('second')]")
      await writePackage(first, 'first', '1', { dependency: '1' }, "exports.label = 'first'; exports.value = require('dependency').value")
      await writePackage(second, 'second', '1', { dependency: '2' }, "module.exports = require('dependency')")
      await writePackage(one, 'dependency', '1', { first: '1' }, "exports.value = require('first').label + '-v1'")
      await writePackage(two, 'dependency', '2', {}, "exports.value = 'v2'")
      await dependencyLink(source, 'first', first)
      await dependencyLink(source, 'second', second)
      // pnpm's per-package links live beside a package, not inside it.
      await symlink(one, join(first, '../dependency'), process.platform === 'win32' ? 'junction' : 'dir')
      await symlink(two, join(second, '../dependency'), process.platform === 'win32' ? 'junction' : 'dir')
      await symlink(first, join(one, '../first'), process.platform === 'win32' ? 'junction' : 'dir')
      expect(createRequire(join(source, 'package.json'))('./index.cjs')).toEqual([{ label: 'first', value: 'first-v1' }, { value: 'v2' }])
      await copyPortablePackageTree(source, destination)
      await expect(stat(join(destination, 'node_modules/.pnpm'))).rejects.toMatchObject({ code: 'ENOENT' })
      await rm(source, { recursive: true, force: true })
      expect(createRequire(join(destination, 'package.json'))('./index.cjs')).toEqual([{ label: 'first', value: 'first-v1' }, { value: 'v2' }])
      expect((await lstat(join(destination, 'node_modules/dependency'))).isSymbolicLink()).toBe(false)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it.each([false, true])('handles a missing dependency according to optional=%s', async (optional) => {
    const root = await mkdtemp(join(tmpdir(), 'portable-missing-dependency-'))
    const source = join(root, 'source')
    try {
      await mkdir(source)
      await writeFile(join(source, 'package.json'), JSON.stringify({
        name: 'portable-fixture',
        [optional ? 'optionalDependencies' : 'dependencies']: { 'missing-portable-fixture': '1.0.0' },
      }))
      const copy = copyPortablePackageTree(source, join(root, 'destination'))
      if (optional) await expect(copy).resolves.toBeUndefined()
      else await expect(copy).rejects.toThrow('deployed runtime dependency is missing: portable-fixture -> missing-portable-fixture')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('rejects a required dependency resolved outside the deployment', async () => {
    const root = await mkdtemp(join(tmpdir(), 'portable-external-dependency-'))
    const source = join(root, 'source')
    try {
      await mkdir(source)
      await mkdir(join(root, 'node_modules/outside'), { recursive: true })
      await writeFile(join(root, 'node_modules/outside/package.json'), JSON.stringify({ name: 'outside', version: '1.0.0' }))
      await writeFile(join(source, 'package.json'), JSON.stringify({ name: 'app', dependencies: { outside: '1.0.0' } }))
      await expect(copyPortablePackageTree(source, join(root, 'destination'))).rejects.toThrow('deployed runtime dependency escapes staging: app -> outside')
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
