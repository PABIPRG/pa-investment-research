import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_DSH_HOME_DISPLAY,
  DSH_HOME_DIR_NAME,
  canonicalizeWatchPath,
  defaultDshHome,
  dshHomeDisplay,
  dshHomePath,
  expandHomePath,
  resolveDshInstanceLayout,
  resolveDshHome,
} from '@deepseek-ai/dsh-home-paths'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('dsh path helpers', () => {
  it('owns the shared default DSH home directory name', () => {
    expect(DSH_HOME_DIR_NAME).toBe('.dsh')
    expect(DEFAULT_DSH_HOME_DISPLAY).toBe('~/.dsh')
    expect(defaultDshHome()).toBe(join(homedir(), '.dsh'))
  })

  it('expands tilde paths without changing non-tilde paths', () => {
    expect(expandHomePath('~')).toBe(homedir())
    expect(expandHomePath('~/.dsh')).toBe(join(homedir(), '.dsh'))
    expect(expandHomePath('~\\.dsh')).toBe(join(homedir(), '.dsh'))
    expect(expandHomePath('/tmp/.dsh')).toBe('/tmp/.dsh')
    expect(expandHomePath('~other/.dsh')).toBe('~other/.dsh')
  })

  it('resolves explicit path before DSH_HOME and the default', () => {
    const envHome = join(homedir(), 'env-dsh')

    expect(resolveDshHome('/tmp/explicit-dsh', { DSH_HOME: '~/env-dsh' })).toBe(resolve('/tmp/explicit-dsh'))
    expect(resolveDshHome(undefined, { DSH_HOME: '~/env-dsh' })).toBe(envHome)
    expect(resolveDshHome(undefined, {})).toBe(defaultDshHome())
  })

  it('treats an empty or whitespace-only DSH_HOME as unset', () => {
    expect(resolveDshHome(undefined, { DSH_HOME: '' })).toBe(defaultDshHome())
    expect(resolveDshHome(undefined, { DSH_HOME: '   ' })).toBe(defaultDshHome())
  })

  it('joins child segments onto the resolved DSH_HOME', () => {
    vi.stubEnv('DSH_HOME', '~/env-dsh')
    expect(dshHomePath()).toBe(join(homedir(), 'env-dsh'))
    expect(dshHomePath('storages', 'cache')).toBe(join(homedir(), 'env-dsh', 'storages', 'cache'))
  })

  it('labels a resolved home by whether it is the default root', () => {
    expect(dshHomeDisplay(resolve(defaultDshHome()))).toBe('~/.dsh')
    expect(dshHomeDisplay('/some/other/root')).toBe('$DSH_HOME')
  })

  it('resolves the complete single-instance persistence contract beneath one root', () => {
    const root = resolve('/tmp/dsh-instance')

    expect(resolveDshInstanceLayout(root)).toEqual({
      root,
      settingsFile: join(root, 'settings.yaml'),
      cordisPatchFile: join(root, 'cordis.patch.yml'),
      profilesDir: join(root, 'profiles'),
      sessionsDir: join(root, 'sessions'),
      attachmentsDir: join(root, 'attachments', 'v1'),
      storagesDir: join(root, 'storages'),
      investmentResearch: {
        root: join(root, 'investment-research'),
        backupSettingsFile: join(root, 'investment-research', 'backup-settings.json'),
        backupsDir: join(root, 'investment-research', 'backups'),
        backends: {
          'trading-core': {
            root: join(root, 'investment-research', 'trading-core'),
            dataDir: join(root, 'investment-research', 'trading-core', 'data'),
            stateDir: join(root, 'investment-research', 'trading-core', 'state'),
            userConfigDir: join(root, 'investment-research', 'trading-core', 'user-config'),
            cacheDir: join(root, 'investment-research', 'trading-core', 'cache'),
            logsDir: join(root, 'investment-research', 'trading-core', 'logs'),
          },
          'market-watch': {
            root: join(root, 'investment-research', 'market-watch'),
            dataDir: join(root, 'investment-research', 'market-watch', 'data'),
            stateDir: join(root, 'investment-research', 'market-watch', 'state'),
            userConfigDir: join(root, 'investment-research', 'market-watch', 'user-config'),
            cacheDir: join(root, 'investment-research', 'market-watch', 'cache'),
            logsDir: join(root, 'investment-research', 'market-watch', 'logs'),
          },
          'industry-chain': {
            root: join(root, 'investment-research', 'industry-chain'),
            dataDir: join(root, 'investment-research', 'industry-chain', 'data'),
            stateDir: join(root, 'investment-research', 'industry-chain', 'state'),
            userConfigDir: join(root, 'investment-research', 'industry-chain', 'user-config'),
            cacheDir: join(root, 'investment-research', 'industry-chain', 'cache'),
            logsDir: join(root, 'investment-research', 'industry-chain', 'logs'),
          },
        },
      },
    })
  })

  it('canonicalizes a watcher ancestor while preserving a missing suffix', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-watch-path-'))
    const target = join(root, 'target')
    const alias = join(root, 'alias')
    try {
      await mkdir(target)
      await symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir')
      await expect(canonicalizeWatchPath(join(alias, 'later', 'config.yml'))).resolves.toBe(
        join(await realpath(target), 'later', 'config.yml'),
      )
      const file = join(root, 'file')
      await writeFile(file, 'not a directory')
      await expect(canonicalizeWatchPath(join(file, 'child'))).rejects.toMatchObject({ code: 'ENOTDIR' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
