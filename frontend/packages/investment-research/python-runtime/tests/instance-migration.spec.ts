import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { resolveDshInstanceLayout } from '@deepseek-ai/dsh-home-paths'
import {
  dryRunDshInstanceMigration,
  initializeDshInstance,
  migrateDshInstance,
} from '../src/instance-migration.ts'

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

  it('copies profile configuration while excluding managed node_modules links', async () => {
    const current = await fixture()
    const packageTarget = join(current.root, 'managed-package')
    await mkdir(join(current.source, 'profiles', 'research'), { recursive: true })
    await mkdir(packageTarget)
    await writeFile(join(current.source, 'profiles', 'research', 'profile.yml'), 'name: research\n')
    await symlink(packageTarget, join(current.source, 'profiles', 'research', 'node_modules'))

    const result = await migrateDshInstance({
      sourceRoot: current.source,
      targetRoot: current.target,
      mode: 'quiesced',
    })

    expect(await readFile(join(current.target, 'profiles', 'research', 'profile.yml'), 'utf8')).toBe('name: research\n')
    await expect(stat(join(current.target, 'profiles', 'research', 'node_modules')))
      .rejects.toMatchObject({ code: 'ENOENT' })
    expect(result.excluded).toContainEqual({
      relativePath: join('profiles', 'research', 'node_modules'),
      reason: 'managed profile dependency',
    })
  })

  it('rejects a target that resolves through a parent alias into the source', async () => {
    const current = await fixture()
    const alias = join(current.root, 'source-alias')
    await symlink(current.source, alias)
    const target = join(alias, 'nested-target')

    const plan = await dryRunDshInstanceMigration({
      sourceRoot: current.source,
      targetRoot: target,
      mode: 'quiesced',
    })

    expect(plan.rejections.some(({ reason }) => /physical.*separate/i.test(reason))).toBe(true)
    await expect(migrateDshInstance({ sourceRoot: current.source, targetRoot: target, mode: 'quiesced' }))
      .rejects.toThrow(/physical.*separate/i)
    await expect(stat(join(current.source, 'nested-target'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects source-root replacement after inspection', async () => {
    const current = await fixture()
    const original = join(current.root, 'original-source')
    const attacker = join(current.root, 'attacker-source')
    await mkdir(attacker)
    await writeFile(join(attacker, 'settings.yaml'), 'attacker: true\n')

    await expect(migrateDshInstance({
      sourceRoot: current.source,
      targetRoot: current.target,
      mode: 'quiesced',
      beforeCopy: async () => {
        await rename(current.source, original)
        await symlink(attacker, current.source)
      },
    })).rejects.toThrow(/source root changed/i)

    await expect(stat(current.target)).rejects.toMatchObject({ code: 'ENOENT' })
    await rm(current.source)
    await rename(original, current.source)
  })

  it('rejects source inventory growth after the confirmed dry-run', async () => {
    const current = await fixture()
    let injected = false

    await expect(migrateDshInstance({
      sourceRoot: current.source,
      targetRoot: current.target,
      mode: 'quiesced',
      beforeCopy: async () => {
        if (injected) return
        injected = true
        await writeFile(join(current.source, 'sessions', 'late.jsonl'), '{"late":true}\n')
      },
    })).rejects.toThrow(/inventory changed during copy/i)

    await expect(stat(current.target)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(current.source, 'sessions', 'late.jsonl'), 'utf8')).toBe('{"late":true}\n')
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
    await rm(join(current.source, 'sessions'), { recursive: true })
    await rm(join(current.source, 'attachments'), { recursive: true })
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
    await rm(join(current.source, 'sessions'), { recursive: true })
    await rm(join(current.source, 'attachments'), { recursive: true })
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

  it('detects extensionless SQLite by header and excludes every live sidecar', async () => {
    const current = await fixture()
    await rm(join(current.source, 'sessions'), { recursive: true })
    await rm(join(current.source, 'attachments'), { recursive: true })
    await mkdir(join(current.source, 'storages'), { recursive: true })
    const database = join(current.source, 'storages', 'catalog')
    await writeFile(database, Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(32)]))
    await writeFile(`${database}-wal`, 'wal')
    await writeFile(`${database}-shm`, 'shm')
    await writeFile(`${database}-journal`, 'rollback journal')
    const backupSqlite = vi.fn(async (_source: string, target: string) => writeFile(target, 'snapshot'))

    const result = await migrateDshInstance({
      sourceRoot: current.source,
      targetRoot: current.target,
      mode: 'online',
      backupSqlite,
    })

    expect(backupSqlite).toHaveBeenCalledOnce()
    expect(backupSqlite.mock.calls[0]?.[0]).toBe(database)
    expect(backupSqlite.mock.calls[0]?.[1].startsWith(join(current.target, '.dsh-migration-'))).toBe(true)
    expect(await readFile(join(current.target, 'storages', 'catalog'), 'utf8')).toBe('snapshot')
    for (const suffix of ['-wal', '-shm', '-journal']) {
      await expect(stat(join(current.target, 'storages', `catalog${suffix}`))).rejects.toMatchObject({ code: 'ENOENT' })
    }
    expect(result.excluded.map(entry => entry.relativePath)).toEqual(expect.arrayContaining([
      join('storages', 'catalog-wal'),
      join('storages', 'catalog-shm'),
      join('storages', 'catalog-journal'),
    ]))
  })

  it('rejects online Host sessions and attachments without a common snapshot barrier', async () => {
    const current = await fixture()

    const plan = await dryRunDshInstanceMigration({
      sourceRoot: current.source,
      targetRoot: current.target,
      mode: 'online',
      backupSqlite: async () => {},
    })

    expect(plan.rejections.map(rejection => rejection.relativePath)).toEqual(expect.arrayContaining([
      'sessions',
      join('attachments', 'v1'),
    ]))
    await expect(migrateDshInstance({
      sourceRoot: current.source,
      targetRoot: current.target,
      mode: 'online',
      backupSqlite: async () => {},
    })).rejects.toThrow(/online.*Host snapshot/i)
    await expect(stat(current.target)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps an existing empty mountpoint and rolls back a failed in-root publication', async () => {
    const current = await fixture()
    await mkdir(current.target)
    await chmod(current.target, 0o755)
    const inode = (await stat(current.target)).ino

    await expect(migrateDshInstance({
      sourceRoot: current.source,
      targetRoot: current.target,
      mode: 'quiesced',
      beforePublish: (relativePath) => {
        if (relativePath === 'sessions') throw new Error('simulated publish failure')
      },
    })).rejects.toThrow('simulated publish failure')

    expect((await stat(current.target)).ino).toBe(inode)
    expect((await stat(current.target)).mode & 0o777).toBe(0o700)
    expect(await readdir(current.target)).toEqual([])
    expect(await readFile(join(current.source, 'settings.yaml'), 'utf8')).toBe('theme: dark\n')
  })

  it('publishes into an existing empty mountpoint without replacing its inode', async () => {
    const current = await fixture()
    await mkdir(current.target)
    await chmod(current.target, 0o755)
    const inode = (await stat(current.target)).ino

    await migrateDshInstance({ sourceRoot: current.source, targetRoot: current.target, mode: 'quiesced' })

    expect((await stat(current.target)).ino).toBe(inode)
    expect((await stat(current.target)).mode & 0o777).toBe(0o700)
    expect(await readFile(join(current.target, 'settings.yaml'), 'utf8')).toBe('theme: dark\n')
  })

  it('rejects target-root replacement immediately before publication', async () => {
    const current = await fixture()
    const displaced = join(current.root, 'displaced-target')
    const attacker = join(current.root, 'attacker-target')
    await mkdir(current.target)
    await mkdir(attacker)

    await expect(migrateDshInstance({
      sourceRoot: current.source,
      targetRoot: current.target,
      mode: 'quiesced',
      beforePublish: async () => {
        await rename(current.target, displaced)
        await symlink(attacker, current.target)
      },
    })).rejects.toThrow(/target root changed/i)

    expect(await readdir(attacker)).toEqual([])
    await rm(current.target)
    await rename(displaced, current.target)
  })

  it('dry-runs without writes and reports files, exclusions, sizes, strategies, and rejections', async () => {
    const current = await fixture()
    const packageTarget = join(current.root, 'managed-package')
    await mkdir(join(current.source, 'profiles', 'research'), { recursive: true })
    await mkdir(packageTarget)
    await symlink(packageTarget, join(current.source, 'profiles', 'research', 'node_modules'))

    const plan = await dryRunDshInstanceMigration({
      sourceRoot: current.source,
      targetRoot: current.target,
      mode: 'quiesced',
    })

    await expect(stat(current.target)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(plan.publicationStrategy).toBe('target-internal-transaction')
    expect(plan.totalBytes).toBeGreaterThan(0)
    expect(plan.files).toContainEqual(expect.objectContaining({ relativePath: 'settings.yaml', strategy: 'copy' }))
    expect(plan.excluded).toContainEqual(expect.objectContaining({
      relativePath: join('profiles', 'research', 'node_modules'),
    }))
    expect(plan.rejections).toEqual([])
  })

  it('does not chmod an existing empty target during dry-run', async () => {
    const current = await fixture()
    await mkdir(current.target)
    await chmod(current.target, 0o755)

    const plan = await dryRunDshInstanceMigration({
      sourceRoot: current.source,
      targetRoot: current.target,
      mode: 'quiesced',
    })

    expect(plan.rejections).toEqual([])
    expect((await stat(current.target)).mode & 0o777).toBe(0o755)
  })

  it('rebases an internal backup directory and preserves an external directory', async () => {
    const internal = await fixture()
    const internalDirectory = join(internal.source, 'investment-research', 'backups')
    await mkdir(join(internal.source, 'investment-research'), { recursive: true })
    await writeFile(join(internal.source, 'investment-research', 'backup-settings.json'), JSON.stringify({
      version: 1,
      directory: internalDirectory,
    }))

    await migrateDshInstance({ sourceRoot: internal.source, targetRoot: internal.target, mode: 'quiesced' })
    expect(JSON.parse(await readFile(join(internal.target, 'investment-research', 'backup-settings.json'), 'utf8')))
      .toMatchObject({ directory: join(internal.target, 'investment-research', 'backups') })

    const external = await fixture()
    const externalDirectory = join(external.root, 'external-backups')
    await mkdir(join(external.source, 'investment-research'), { recursive: true })
    await writeFile(join(external.source, 'investment-research', 'backup-settings.json'), JSON.stringify({
      version: 1,
      directory: externalDirectory,
    }))

    await migrateDshInstance({ sourceRoot: external.source, targetRoot: external.target, mode: 'quiesced' })
    expect(JSON.parse(await readFile(join(external.target, 'investment-research', 'backup-settings.json'), 'utf8')))
      .toMatchObject({ directory: externalDirectory })
  })

  it('rejects a backup operation that publishes a symbolic-link target', async () => {
    const current = await fixture()
    await rm(join(current.source, 'sessions'), { recursive: true })
    await rm(join(current.source, 'attachments'), { recursive: true })
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
