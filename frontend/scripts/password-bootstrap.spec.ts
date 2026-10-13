import { mkdtemp, readFile, rm, mkdir, writeFile, chmod, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'
const entry = await import(/* @vite-ignore */ pathToFileURL(join(import.meta.dirname, '../../containers/investment-entrypoint.mjs')).href) as {
  preparePasswordHash(source: string, destination: string): Promise<void>
}
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
it('initializes a persistent secret once and preserves the changed password on subsequent starts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'password-bootstrap-')); roots.push(root)
  const source = join(root, 'bootstrap'); const target = join(root, 'auth/password.hash')
  await writeFile(source, 'initial-hash', { mode: 0o600 })
  await entry.preparePasswordHash(source, target)
  await writeFile(target, 'changed-hash', { mode: 0o600 })
  await entry.preparePasswordHash(source, target)
  expect(await readFile(target, 'utf8')).toBe('changed-hash')
  await rm(source)
  await entry.preparePasswordHash(source, target)
  expect(await readFile(target, 'utf8')).toBe('changed-hash')
  await rm(target)
  await expect(entry.preparePasswordHash(source, target)).rejects.toThrow(/missing/)
})
it('does not fall back to bootstrap on an empty, unsafe or linked persisted file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'password-bootstrap-')); roots.push(root)
  const source = join(root, 'bootstrap'); const target = join(root, 'auth/password.hash')
  await mkdir(join(root, 'auth'), { mode: 0o700 }); await writeFile(source, 'initial-hash', { mode: 0o600 })
  await writeFile(target, '', { mode: 0o600 })
  await expect(entry.preparePasswordHash(source, target)).rejects.toThrow()
  expect(await readFile(target, 'utf8')).toBe('')
  await writeFile(target, 'changed-hash'); await chmod(target, 0o644)
  await expect(entry.preparePasswordHash(source, target)).rejects.toThrow()
  await rm(target); await symlink(source, target)
  await expect(entry.preparePasswordHash(source, target)).rejects.toThrow()
  expect(await readFile(source, 'utf8')).toBe('initial-hash')
})
it('resets only a stopped instance using its application lease', async () => {
  const { hashPassword, verifyPassword } = await import('../packages/api/web-auth/src/index.ts')
  const reset = await import(/* @vite-ignore */ pathToFileURL(join(import.meta.dirname, '../../containers/reset-web-password.mjs')).href) as {
    resetPasswordRecord(home: string, record: string): Promise<void>
  }
  const lockOwner = entry as unknown as { acquireInstanceLock(root: string): Promise<{ release(): Promise<void> }> }
  const root = await mkdtemp(join(tmpdir(), 'password-reset-')); roots.push(root)
  const encoded = hashPassword('Reset-Only-Test-Password')
  const lease = await lockOwner.acquireInstanceLock(join(root, 'investment-research'))
  try { await expect(reset.resetPasswordRecord(root, encoded)).rejects.toThrow(/already owns/) }
  finally { await lease.release() }
  await reset.resetPasswordRecord(root, encoded)
  expect(verifyPassword('Reset-Only-Test-Password', await readFile(join(root, 'web-auth/password.hash'), 'utf8'))).toBe(true)
  await expect(reset.resetPasswordRecord(root, 'invalid')).rejects.toThrow(/invalid/)
})
