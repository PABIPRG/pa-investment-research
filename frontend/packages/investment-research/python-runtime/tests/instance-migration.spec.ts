import { mkdir, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { resolveDshInstanceLayout } from '@deepseek-ai/dsh-home-paths'
import { initializeDshInstance, migrateDshInstance } from '../src/instance-migration.ts'

async function fixture(): Promise<{ root: string; source: string; target: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-instance-migration-'))
  const source = join(root, 'source')
  const target = join(root, 'target')
  await mkdir(join(source, 'sessions', 'workspace', 'session'), { recursive: true })
  await mkdir(join(source, 'attachments', 'v1'), { recursive: true })
  await mkdir(join(source, 'investment-research', 'trading-core', 'data'), { recursive: true })
  await mkdir(join(source, 'investment-research', 'trading-core', 'cache'), { recursive: true })
  await writeFile(join(source, 'settings.yaml'), 'theme: dark\n')
  await writeFile(join(source, 'sessions', 'workspace', 'session', 'session.jsonl'), '{"seq":1}\n')
  await writeFile(join(source, 'attachments', 'v1', 'image.bin'), 'attachment')
  await writeFile(join(source, 'investment-research', 'trading-core', 'data', 'reports.json'), '[]')
  await writeFile(join(source, 'investment-research', 'trading-core', 'cache', 'quotes.json'), '{}')
  return { root, source, target }
}

describe('single-instance migration', () => {
  it('initializes every mounted instance directory without inventing user data', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-instance-init-parent-'))
    const target = join(root, 'instance')

    const layout = await initializeDshInstance(target)

    expect((await stat(layout.sessionsDir)).isDirectory()).toBe(true)
    expect((await stat(layout.attachmentsDir)).isDirectory()).toBe(true)
    expect((await stat(layout.storagesDir)).isDirectory()).toBe(true)
    expect((await stat(layout.investmentResearch.backends['industry-chain'].dataDir)).isDirectory()).toBe(true)
    await expect(stat(layout.settingsFile)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reopens settings, sessions, attachments, reports, and backups after a container-style recreation', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'dsh-instance-recreate-'))
    const root = join(parent, 'mounted-data')
    const first = await initializeDshInstance(root)
    await writeFile(first.settingsFile, 'locale: zh-CN\n')
    await mkdir(join(first.sessionsDir, 'project', 'session'), { recursive: true })
    await writeFile(join(first.sessionsDir, 'project', 'session', 'session.jsonl'), '{"seq":1}\n')
    await writeFile(join(first.attachmentsDir, 'asset.bin'), 'attachment')
    await writeFile(join(first.investmentResearch.backends['trading-core'].dataDir, 'reports.json'), '[{"id":"r1"}]')
    await writeFile(join(first.investmentResearch.backupsDir, 'fixture.pabackup'), 'archive')

    const recreated = resolveDshInstanceLayout(root)

    expect(await readFile(recreated.settingsFile, 'utf8')).toBe('locale: zh-CN\n')
    expect(await readFile(join(recreated.sessionsDir, 'project', 'session', 'session.jsonl'), 'utf8')).toBe('{"seq":1}\n')
    expect(await readFile(join(recreated.attachmentsDir, 'asset.bin'), 'utf8')).toBe('attachment')
    expect(await readFile(join(recreated.investmentResearch.backends['trading-core'].dataDir, 'reports.json'), 'utf8'))
      .toBe('[{"id":"r1"}]')
    expect(await readFile(join(recreated.investmentResearch.backupsDir, 'fixture.pabackup'), 'utf8')).toBe('archive')
  })

  it('copies the durable inventory as one staged publication and preserves the source', async () => {
    const current = await fixture()

    const result = await migrateDshInstance({ sourceRoot: current.source, targetRoot: current.target, mode: 'quiesced' })

    expect(await readFile(join(current.source, 'settings.yaml'), 'utf8')).toBe('theme: dark\n')
    expect(await readFile(join(current.target, 'settings.yaml'), 'utf8')).toBe('theme: dark\n')
    expect(await readFile(join(current.target, 'sessions', 'workspace', 'session', 'session.jsonl'), 'utf8')).toBe('{"seq":1}\n')
    expect(await readFile(join(current.target, 'attachments', 'v1', 'image.bin'), 'utf8')).toBe('attachment')
    expect(await readFile(join(current.target, 'investment-research', 'trading-core', 'data', 'reports.json'), 'utf8')).toBe('[]')
    await expect(stat(join(current.target, 'investment-research', 'trading-core', 'cache'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(result.files.map(file => file.relativePath)).toContain('settings.yaml')
  })

  it('refuses a non-empty target without changing either tree', async () => {
    const current = await fixture()
    await mkdir(current.target)
    await writeFile(join(current.target, 'keep.txt'), 'keep')

    await expect(migrateDshInstance({ sourceRoot: current.source, targetRoot: current.target, mode: 'quiesced' }))
      .rejects.toThrow(/target.*empty/i)

    expect(await readFile(join(current.target, 'keep.txt'), 'utf8')).toBe('keep')
    expect(await readFile(join(current.source, 'settings.yaml'), 'utf8')).toBe('theme: dark\n')
  })

  it('rejects an incompatible source layout before creating the target', async () => {
    const current = await fixture()
    await writeFile(join(current.source, '.dsh-instance.json'), '{"schemaVersion":2}\n')

    await expect(migrateDshInstance({ sourceRoot: current.source, targetRoot: current.target, mode: 'quiesced' }))
      .rejects.toThrow(/unsupported source instance layout version: 2/)

    await expect(stat(current.target)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(current.source, 'settings.yaml'), 'utf8')).toBe('theme: dark\n')
  })

  it('does not publish a partial target when copying fails', async () => {
    const current = await fixture()
    const beforeCopy = vi.fn(async (relativePath: string) => {
      if (relativePath.endsWith('image.bin')) throw new Error('simulated copy failure')
    })

    await expect(migrateDshInstance({
      sourceRoot: current.source,
      targetRoot: current.target,
      mode: 'quiesced',
      beforeCopy,
    })).rejects.toThrow('simulated copy failure')

    await expect(stat(current.target)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(current.source, 'attachments', 'v1', 'image.bin'), 'utf8')).toBe('attachment')
  })

  it('refuses symbolic links in the durable source inventory', async () => {
    const current = await fixture()
    const outside = join(current.root, 'outside.txt')
    await writeFile(outside, 'outside')
    await symlink(outside, join(current.source, 'sessions', 'outside-link'))

    await expect(migrateDshInstance({ sourceRoot: current.source, targetRoot: current.target, mode: 'quiesced' }))
      .rejects.toThrow(/symbolic link/i)

    await expect(stat(current.target)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(outside, 'utf8')).toBe('outside')
  })

  it('requires an online SQLite consistency backup and never blind-copies the database', async () => {
    const current = await fixture()
    await mkdir(join(current.source, 'storages'), { recursive: true })
    await writeFile(join(current.source, 'storages', 'sessions.sqlite'), 'sqlite fixture')
    await writeFile(join(current.source, 'storages', 'sessions.sqlite-wal'), 'live wal')
    await writeFile(join(current.source, 'storages', 'sessions.sqlite-shm'), 'live shm')

    await expect(migrateDshInstance({ sourceRoot: current.source, targetRoot: current.target, mode: 'online' }))
      .rejects.toThrow(/SQLite.*backup/i)
    await expect(stat(current.target)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('uses the supplied online SQLite backup operation', async () => {
    const current = await fixture()
    await mkdir(join(current.source, 'storages'), { recursive: true })
    await writeFile(join(current.source, 'storages', 'sessions.sqlite'), 'sqlite fixture')
    await writeFile(join(current.source, 'storages', 'sessions.sqlite-wal'), 'live wal')
    await writeFile(join(current.source, 'storages', 'sessions.sqlite-shm'), 'live shm')
    const backupSqlite = vi.fn(async (source: string, target: string) => {
      expect(source).toBe(join(current.source, 'storages', 'sessions.sqlite'))
      await writeFile(target, 'consistent snapshot')
    })

    await migrateDshInstance({
      sourceRoot: current.source,
      targetRoot: current.target,
      mode: 'online',
      backupSqlite,
    })

    expect(backupSqlite).toHaveBeenCalledOnce()
    expect(await readFile(join(current.target, 'storages', 'sessions.sqlite'), 'utf8')).toBe('consistent snapshot')
    await expect(stat(join(current.target, 'storages', 'sessions.sqlite-wal'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(join(current.target, 'storages', 'sessions.sqlite-shm'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects a backup operation that publishes a symbolic-link target', async () => {
    const current = await fixture()
    const outside = join(current.root, 'outside.sqlite')
    await mkdir(join(current.source, 'storages'), { recursive: true })
    await writeFile(join(current.source, 'storages', 'sessions.sqlite'), 'sqlite fixture')
    await writeFile(outside, 'must remain outside the migration')

    await expect(migrateDshInstance({
      sourceRoot: current.source,
      targetRoot: current.target,
      mode: 'online',
      backupSqlite: async (_source, target) => symlink(outside, target),
    })).rejects.toThrow(/invalid target file/i)

    await expect(stat(current.target)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(outside, 'utf8')).toBe('must remain outside the migration')
  })
})
