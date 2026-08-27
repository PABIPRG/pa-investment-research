/** Electron packaging keeps the Python sidecar outside the application staging tree. */

import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import forgeConfig from '../forge.config.ts'
import {
  commandRequiresShell,
  createPackagerOptions,
  createPackagingPlan,
  materializePackagingWorkspaceLinks,
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
    const darwinPlan = createPackagingPlan('/tmp/dsh-electron-darwin-test', 'darwin', 'arm64')
    expect(darwinPlan.appSourceDir).toBe(resolve(darwinPlan.deploy.cwd, 'apps/electron'))
    expect(darwinPlan.workspaceDir).toBe(darwinPlan.deploy.cwd)
  })

  it('replaces deployed workspace links with one relocatable package copy', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'dsh-electron-link-test-'))
    const workspaceDir = join(rootDir, 'workspace')
    const sourceDir = join(workspaceDir, 'vendor', 'schemastery')
    const appSourceDir = join(workspaceDir, 'apps', 'electron')
    const stagingDir = join(rootDir, 'app')
    const firstLink = join(stagingDir, 'node_modules', 'first', 'schemastery')
    const secondLink = join(stagingDir, 'node_modules', 'second', 'schemastery')
    const selfLink = join(stagingDir, 'node_modules', '.pnpm', 'node_modules', '@deepseek-ai', 'dsh-electron')
    try {
      await mkdir(sourceDir, { recursive: true })
      await mkdir(appSourceDir, { recursive: true })
      await mkdir(join(appSourceDir, 'out'), { recursive: true })
      await mkdir(join(sourceDir, 'node_modules', 'ignored'), { recursive: true })
      await mkdir(dirname(firstLink), { recursive: true })
      await mkdir(dirname(secondLink), { recursive: true })
      await mkdir(dirname(selfLink), { recursive: true })
      await writeFile(join(sourceDir, 'package.json'), '{"name":"@deepseek-ai/schemastery"}')
      await writeFile(join(appSourceDir, 'package.json'), '{"name":"@deepseek-ai/dsh-electron"}')
      await writeFile(join(appSourceDir, 'out', 'marker'), 'exclude me')
      await writeFile(join(sourceDir, 'node_modules', 'ignored', 'marker'), 'exclude me')
      await writeFile(join(stagingDir, 'package.json'), '{"name":"@deepseek-ai/dsh-electron"}')

      const brokenPrefix = '../../../../../../..'
      const workspacePathWithoutRoot = workspaceDir.replace(/^\/+/, '')
      await symlink(`${brokenPrefix}/${workspacePathWithoutRoot}/vendor/schemastery`, firstLink, 'dir')
      await symlink(`${brokenPrefix}/${workspacePathWithoutRoot}/vendor/schemastery`, secondLink, 'dir')
      await symlink(`${brokenPrefix}/${workspacePathWithoutRoot}/apps/electron`, selfLink, 'dir')

      expect(await materializePackagingWorkspaceLinks(stagingDir, workspaceDir, appSourceDir)).toBe(3)

      expect(await readFile(join(firstLink, 'package.json'), 'utf8')).toBe('{"name":"@deepseek-ai/schemastery"}')
      expect(await realpath(firstLink)).toBe(await realpath(secondLink))
      await expect(readFile(join(firstLink, 'node_modules', 'ignored', 'marker'), 'utf8'))
        .rejects.toMatchObject({ code: 'ENOENT' })
      expect(await readFile(join(selfLink, 'package.json'), 'utf8')).toBe('{"name":"@deepseek-ai/dsh-electron"}')
      expect(await realpath(selfLink)).not.toBe(await realpath(stagingDir))
      await expect(stat(join(selfLink, 'node_modules'))).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(join(selfLink, 'out'))).rejects.toMatchObject({ code: 'ENOENT' })
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
