/** Electron packaging keeps the Python sidecar outside the application staging tree. */

import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import forgeConfig from '../forge.config.ts'
import {
  commandRequiresShell,
  createPackagerOptions,
  createPackagingPlan,
  materializePackagingLinkTargets,
  removePackagingRoot,
} from '../src/packaging.ts'

describe('Electron investment sidecar packaging', () => {
  it('uses the Windows command shell only for batch entrypoints', () => {
    expect(commandRequiresShell('pnpm.cmd', 'win32')).toBe(true)
    expect(commandRequiresShell('electron-forge.bat', 'win32')).toBe(true)
    expect(commandRequiresShell('pnpm', 'win32')).toBe(false)
    expect(commandRequiresShell('pnpm.cmd', 'darwin')).toBe(false)
  })

  it('enables bounded descriptor retries when removing the temporary package tree', async () => {
    let receivedPath = ''
    let receivedOptions: import('node:fs').RmDirOptions | undefined
    const remove = async (path: import('node:fs').PathLike, options?: import('node:fs').RmDirOptions) => {
      receivedPath = path.toString()
      receivedOptions = options
    }

    await removePackagingRoot('/tmp/dsh-electron-test', remove)

    expect(receivedPath).toBe('/tmp/dsh-electron-test')
    expect(receivedOptions).toMatchObject({
      force: true,
      maxRetries: 50,
      recursive: true,
      retryDelay: 50,
    })
  })

  it('deploys before building the current platform sidecar in isolated temporary paths', () => {
    const plan = createPackagingPlan('/tmp/dsh-electron-test', 'win32', 'x64')

    expect(plan.deploy.args).toEqual([
      '--filter',
      '@deepseek-ai/dsh-electron',
      'deploy',
      '--prod',
      '--legacy',
      plan.stagingDir,
    ])
    expect(plan.deploy.command).toBe('pnpm.cmd')
    expect(plan.sidecar.args).toEqual([
      '--workspace-root',
      'run',
      'investment:sidecar:build',
      '--target',
      'win32-x64',
      '--output',
      plan.sidecarDir,
      '--cache',
      plan.sidecarCacheDir,
    ])
    expect(plan.sidecar.command).toBe('pnpm.cmd')
    expect(isAbsolute(plan.sidecarDir)).toBe(true)
    expect(relative(plan.stagingDir, plan.sidecarDir)).toMatch(/^\.\./)
    expect(relative(plan.stagingDir, plan.sidecarCacheDir)).toMatch(/^\.\./)
    expect(plan.linkTargets).toEqual([])

    const darwinPlan = createPackagingPlan('/tmp/dsh-electron-darwin-test', 'darwin', 'arm64')
    expect(darwinPlan.linkTargets).toEqual([{
      sourceDir: resolve(darwinPlan.deploy.cwd, 'vendor/cosmokit'),
      targetDir: join(
        darwinPlan.stagingDir,
        'node_modules/.pnpm/node_modules/@deepseek-ai/cosmokit',
      ),
    }])
  })

  it('replaces a deployed workspace link with its vendored package contents', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'dsh-electron-link-test-'))
    const sourceDir = join(rootDir, 'source', 'cosmokit')
    const targetDir = join(rootDir, 'app', 'node_modules', 'cosmokit')
    try {
      await mkdir(sourceDir, { recursive: true })
      await mkdir(targetDir, { recursive: true })
      await writeFile(join(sourceDir, 'package.json'), '{"name":"@deepseek-ai/cosmokit"}')
      await writeFile(join(targetDir, 'stale-workspace-link'), 'remove me')

      await materializePackagingLinkTargets([{ sourceDir, targetDir }])

      expect(await readFile(join(targetDir, 'package.json'), 'utf8')).toBe('{"name":"@deepseek-ai/cosmokit"}')
      await expect(readFile(join(targetDir, 'stale-workspace-link'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(rootDir, { force: true, recursive: true })
    }
  })

  it('copies the built directory as Resources/investment-python before signing', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'dsh-electron-sidecar-copy-test-'))
    const plan = createPackagingPlan(rootDir, 'darwin', 'arm64')
    const buildPath = join(rootDir, 'DeepSeek Harness.app', 'Contents', 'Resources', 'app')
    try {
      await mkdir(join(plan.sidecarDir, 'runtime', 'bin'), { recursive: true })
      await mkdir(buildPath, { recursive: true })
      await writeFile(join(plan.sidecarDir, 'runtime.json'), '{"version":1}')
      const executable = join(plan.sidecarDir, 'runtime', 'bin', 'python')
      await writeFile(executable, '#!/bin/sh\n')
      await chmod(executable, 0o755)

      expect(plan.deploy.command).toBe('pnpm')
      expect(plan.sidecar.command).toBe('pnpm')
      const options = createPackagerOptions({
        arch: 'arm64',
        electronVersion: '43.2.0',
        electronZipDir: '/tmp/electron',
        outDir: '/tmp/out',
        platform: 'darwin',
        sidecarDir: plan.sidecarDir,
        stagingDir: plan.stagingDir,
      })

      expect(options).toEqual(expect.objectContaining({
        dir: plan.stagingDir,
        osxSign: {
          continueOnError: false,
          identity: '-',
          identityValidation: false,
        },
      }))
      expect(options.extraResource).toBeUndefined()
      expect(options.afterCopy).toHaveLength(1)
      await new Promise<void>((resolvePromise, reject) => {
        options.afterCopy![0]!(buildPath, '43.2.0', 'darwin', 'arm64', (error) => {
          if (error === undefined || error === null) resolvePromise()
          else reject(error)
        })
      })

      const packagedSidecar = join(rootDir, 'DeepSeek Harness.app', 'Contents', 'Resources', 'investment-python')
      expect(await readFile(join(packagedSidecar, 'runtime.json'), 'utf8')).toBe('{"version":1}')
      expect((await stat(join(packagedSidecar, 'runtime', 'bin', 'python'))).mode & 0o777).toBe(0o755)
    } finally {
      await rm(rootDir, { force: true, recursive: true })
    }
  })

  it('keeps sidecar outputs and caches out of ordinary Forge staging', () => {
    const ignore = forgeConfig.packagerConfig?.ignore

    expect(ignore).toEqual(expect.arrayContaining([expect.any(RegExp)]))
    expect((ignore as RegExp[]).some(pattern => pattern.test('/investment-python/runtime.json'))).toBe(true)
    expect((ignore as RegExp[]).some(pattern => pattern.test('/.cache/investment-python/archive'))).toBe(true)
  })
})
