/** Electron packaging keeps the Python sidecar outside the application staging tree. */

import { chmod, cp, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import forgeConfig from '../forge.config.ts'
import { appIdentity } from '../src/app-identity.ts'
import {
  commandRequiresShell,
  createPackagerOptions,
  createPackagingPlan,
  materializePackagingWorkspaceLinks,
  refreshPackagedSidecarDescriptor,
  removePackagingRoot,
  signPackagedMacApplications,
  signPackagedElectronHelpers,
  signPackagedSidecarMachO,
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
    const dependencySourceDir = join(workspaceDir, 'vendor', 'cosmokit')
    const agentSourceDir = join(workspaceDir, 'packages', 'core', 'agent')
    const peerSourceDir = join(workspaceDir, 'packages', 'core', 'scope')
    const appSourceDir = join(workspaceDir, 'apps', 'electron')
    const stagingDir = join(rootDir, 'app')
    const firstLink = join(stagingDir, 'node_modules', 'first', 'schemastery')
    const secondLink = join(stagingDir, 'node_modules', 'second', 'schemastery')
    const selfLink = join(stagingDir, 'node_modules', '.pnpm', 'node_modules', '@deepseek-ai', 'dsh-electron')
    const dependencyLink = join(stagingDir, 'node_modules', '.pnpm', 'node_modules', '@deepseek-ai', 'cosmokit')
    const deployedAgent = join(stagingDir, 'node_modules', '.pnpm', 'node_modules', '@deepseek-ai', 'dsh-agent')
    const localAgentLink = join(workspaceDir, 'node_modules', '.pnpm', 'node_modules', '@deepseek-ai', 'dsh-agent')
    const localPeerLink = join(workspaceDir, 'node_modules', '.pnpm', 'node_modules', '@deepseek-ai', 'dsh-scope')
    try {
      await mkdir(join(sourceDir, 'lib'), { recursive: true })
      await mkdir(join(dependencySourceDir, 'lib'), { recursive: true })
      await mkdir(join(agentSourceDir, 'lib'), { recursive: true })
      await mkdir(join(peerSourceDir, 'lib'), { recursive: true })
      await mkdir(appSourceDir, { recursive: true })
      await mkdir(join(appSourceDir, 'out'), { recursive: true })
      await mkdir(join(sourceDir, 'node_modules', 'ignored'), { recursive: true })
      await mkdir(dirname(firstLink), { recursive: true })
      await mkdir(dirname(secondLink), { recursive: true })
      await mkdir(dirname(selfLink), { recursive: true })
      await writeFile(join(sourceDir, 'package.json'), JSON.stringify({
        name: '@deepseek-ai/schemastery',
        type: 'module',
      }))
      await writeFile(
        join(sourceDir, 'lib', 'index.mjs'),
        "export { value } from '@deepseek-ai/cosmokit'\n",
      )
      await writeFile(join(dependencySourceDir, 'package.json'), JSON.stringify({
        exports: './lib/index.mjs',
        name: '@deepseek-ai/cosmokit',
        type: 'module',
      }))
      await writeFile(join(dependencySourceDir, 'lib', 'index.mjs'), "export const value = 'resolved'\n")
      await writeFile(join(agentSourceDir, 'package.json'), JSON.stringify({
        name: '@deepseek-ai/dsh-agent',
        peerDependencies: { '@deepseek-ai/dsh-scope': 'workspace:^' },
        type: 'module',
      }))
      await writeFile(
        join(agentSourceDir, 'lib', 'index.mjs'),
        "export { scope } from '@deepseek-ai/dsh-scope'\n",
      )
      await writeFile(join(peerSourceDir, 'package.json'), JSON.stringify({
        exports: './lib/index.mjs',
        name: '@deepseek-ai/dsh-scope',
        type: 'module',
      }))
      await writeFile(join(peerSourceDir, 'lib', 'index.mjs'), "export const scope = 'resolved peer'\n")
      await cp(agentSourceDir, deployedAgent, { recursive: true })
      await mkdir(dirname(localAgentLink), { recursive: true })
      await symlink(relative(dirname(localAgentLink), agentSourceDir), localAgentLink, 'dir')
      await symlink(relative(dirname(localPeerLink), peerSourceDir), localPeerLink, 'dir')
      await writeFile(join(appSourceDir, 'package.json'), '{"name":"@deepseek-ai/dsh-electron"}')
      await writeFile(join(appSourceDir, 'out', 'marker'), 'exclude me')
      await writeFile(join(sourceDir, 'node_modules', 'ignored', 'marker'), 'exclude me')
      await writeFile(join(stagingDir, 'package.json'), '{"name":"@deepseek-ai/dsh-electron"}')

      const brokenPrefix = '../../../../../../..'
      const workspacePathWithoutRoot = workspaceDir.replace(/^\/+/, '')
      await symlink(`${brokenPrefix}/${workspacePathWithoutRoot}/vendor/schemastery`, firstLink, 'dir')
      await symlink(`${brokenPrefix}/${workspacePathWithoutRoot}/vendor/schemastery`, secondLink, 'dir')
      await symlink(`${brokenPrefix}/${workspacePathWithoutRoot}/apps/electron`, selfLink, 'dir')
      await symlink(`${brokenPrefix}/${workspacePathWithoutRoot}/vendor/cosmokit`, dependencyLink, 'dir')

      expect(await materializePackagingWorkspaceLinks(stagingDir, workspaceDir, appSourceDir)).toBe(4)

      expect(JSON.parse(await readFile(join(firstLink, 'package.json'), 'utf8'))).toMatchObject({
        name: '@deepseek-ai/schemastery',
      })
      expect(await realpath(firstLink)).toBe(await realpath(secondLink))
      expect(await realpath(join(stagingDir, 'node_modules', '.dsh-workspace-links', 'node_modules')))
        .toBe(await realpath(join(stagingDir, 'node_modules', '.pnpm', 'node_modules')))
      expect((await import(join(firstLink, 'lib', 'index.mjs'))).value).toBe('resolved')
      expect((await import(join(deployedAgent, 'lib', 'index.mjs'))).scope).toBe('resolved peer')
      expect(await realpath(join(stagingDir, 'node_modules', '.pnpm', 'node_modules', '@deepseek-ai', 'dsh-scope')))
        .toBe(await realpath(join(stagingDir, 'node_modules', '.dsh-workspace-links', 'packages', 'core', 'scope')))
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

  it('copies the built directory as Resources/investment-python before system signing', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'dsh-electron-sidecar-copy-test-'))
    const plan = createPackagingPlan(rootDir, 'darwin', 'arm64')
    const buildPath = join(rootDir, `${appIdentity.name}.app`, 'Contents', 'Resources', 'app')
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
      }))
      expect(options.osxSign).toBeUndefined()
      expect(options.extraResource).toBeUndefined()
      expect(options.afterCopy).toHaveLength(1)
      await new Promise<void>((resolvePromise, reject) => {
        options.afterCopy![0]!(buildPath, '43.2.0', 'darwin', 'arm64', (error) => {
          if (error === undefined || error === null) resolvePromise()
          else reject(error)
        })
      })

      const packagedSidecar = join(rootDir, `${appIdentity.name}.app`, 'Contents', 'Resources', 'investment-python')
      expect(await readFile(join(packagedSidecar, 'runtime.json'), 'utf8')).toBe('{"version":1}')
      expect((await stat(join(packagedSidecar, 'runtime', 'bin', 'python'))).mode & 0o777).toBe(0o755)
    } finally {
      await rm(rootDir, { force: true, recursive: true })
    }
  })

  it('ad-hoc signs macOS packages sequentially without the Node signing walker', async () => {
    const calls: Array<{ args: string[]; command: string; cwd: string }> = []
    const refreshed: string[] = []
    const signedHelpers: string[] = []
    const signedSidecars: string[] = []
    const runCommand = async (command: string, args: string[], cwd: string) => {
      calls.push({ args, command, cwd })
    }
    const refreshDescriptor = async (appPath: string) => { refreshed.push(appPath) }
    const signSidecar = async (appPath: string) => { signedSidecars.push(appPath) }
    const signHelpers = async (appPath: string) => { signedHelpers.push(appPath) }
    const firstPackage = `/tmp/out/${appIdentity.name}-darwin-arm64`
    const secondPackage = `/tmp/out/${appIdentity.name}-darwin-x64`
    const firstApp = join(firstPackage, `${appIdentity.name}.app`)
    const secondApp = join(secondPackage, `${appIdentity.name}.app`)

    await signPackagedMacApplications(
      [firstPackage, secondPackage], 'darwin', runCommand, refreshDescriptor, signSidecar, signHelpers,
    )

    expect(calls).toEqual([
      {
        args: ['--force', '--deep', '--sign', '-', firstApp],
        command: 'codesign',
        cwd: dirname(firstApp),
      },
      {
        args: [
          '--force', '--options', 'runtime', '--entitlements',
          expect.stringMatching(/entitlements\.mac\.plist$/u), '--sign', '-', firstApp,
        ],
        command: 'codesign',
        cwd: dirname(firstApp),
      },
      {
        args: ['--force', '--deep', '--sign', '-', secondApp],
        command: 'codesign',
        cwd: dirname(secondApp),
      },
      {
        args: [
          '--force', '--options', 'runtime', '--entitlements',
          expect.stringMatching(/entitlements\.mac\.plist$/u), '--sign', '-', secondApp,
        ],
        command: 'codesign',
        cwd: dirname(secondApp),
      },
    ])
    expect(refreshed).toEqual([firstApp, secondApp])
    expect(signedHelpers).toEqual([firstApp, secondApp])
    expect(signedSidecars).toEqual([firstApp, secondApp])

    await signPackagedMacApplications(
      [firstPackage], 'win32', runCommand, refreshDescriptor, signSidecar, signHelpers,
    )
    expect(calls).toHaveLength(4)
    expect(refreshed).toHaveLength(2)
    expect(signedHelpers).toHaveLength(2)
    expect(signedSidecars).toHaveLength(2)
  })

  it('signs every Electron helper with local library validation disabled', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'dsh-electron-helper-sign-test-'))
    const appPath = join(rootDir, `${appIdentity.name}.app`)
    const frameworksDir = join(appPath, 'Contents', 'Frameworks')
    const calls: Array<{ args: string[]; command: string; cwd: string }> = []
    try {
      await mkdir(join(frameworksDir, `${appIdentity.name} Helper.app`), { recursive: true })
      await mkdir(join(frameworksDir, `${appIdentity.name} Helper (GPU).app`), { recursive: true })
      await mkdir(join(frameworksDir, 'Electron Framework.framework'), { recursive: true })

      await signPackagedElectronHelpers(appPath, async (command, args, cwd) => {
        calls.push({ args, command, cwd })
      })

      expect(calls).toHaveLength(2)
      expect(calls.every(call => call.command === 'codesign')).toBe(true)
      expect(calls.every(call => call.args.includes('runtime'))).toBe(true)
      expect(calls.every(call => call.args.some(arg => arg.endsWith('entitlements.mac.plist')))).toBe(true)
      expect(calls.map(call => call.args.at(-1))).toEqual([
        join(frameworksDir, `${appIdentity.name} Helper (GPU).app`),
        join(frameworksDir, `${appIdentity.name} Helper.app`),
      ])
    } finally {
      await rm(rootDir, { force: true, recursive: true })
    }
  })

  it('signs every packaged sidecar Mach-O file and skips ordinary resources', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'dsh-electron-sidecar-sign-test-'))
    const appPath = join(rootDir, `${appIdentity.name}.app`)
    const sidecarRoot = join(appPath, 'Contents', 'Resources', 'investment-python')
    const calls: Array<{ args: string[]; command: string; cwd: string }> = []
    try {
      const runtime = join(sidecarRoot, 'runtime', 'bin', 'python')
      const extension = join(sidecarRoot, 'site-packages', 'native.so')
      await mkdir(dirname(runtime), { recursive: true })
      await mkdir(dirname(extension), { recursive: true })
      await writeFile(runtime, Buffer.from('cffaedfe00000000', 'hex'))
      await writeFile(extension, Buffer.from('cafebabe00000000', 'hex'))
      await writeFile(join(sidecarRoot, 'runtime.json'), '{}')

      await signPackagedSidecarMachO(appPath, async (command, args, cwd) => {
        calls.push({ args, command, cwd })
      })

      expect(calls).toEqual([extension, runtime].sort().map(file => ({
        args: ['--force', '--sign', '-', file],
        command: 'codesign',
        cwd: dirname(file),
      })))
    } finally {
      await rm(rootDir, { force: true, recursive: true })
    }
  })

  it('refreshes packaged sidecar hashes after recursive macOS signing', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'dsh-electron-signed-sidecar-test-'))
    const appPath = join(rootDir, `${appIdentity.name}.app`)
    const sidecarRoot = join(appPath, 'Contents', 'Resources', 'investment-python')
    try {
      await mkdir(join(sidecarRoot, 'runtime', 'bin'), { recursive: true })
      await writeFile(join(sidecarRoot, 'runtime', 'bin', 'python'), 'signed python')
      await writeFile(join(sidecarRoot, 'site-packages.txt'), 'signed packages')
      await writeFile(join(sidecarRoot, 'runtime.json'), JSON.stringify({
        schemaVersion: 1,
        files: [
          { path: 'runtime/bin/python', sha256: '0'.repeat(64) },
          { path: 'site-packages.txt', sha256: '0'.repeat(64) },
        ],
      }))

      await refreshPackagedSidecarDescriptor(appPath)

      const descriptor = JSON.parse(await readFile(join(sidecarRoot, 'runtime.json'), 'utf8')) as {
        schemaVersion: number
        files: Array<{ path: string; sha256: string }>
      }
      expect(descriptor.schemaVersion).toBe(1)
      expect(descriptor.files.map(file => file.path)).toEqual(['runtime/bin/python', 'site-packages.txt'])
      expect(descriptor.files.every(file => /^[0-9a-f]{64}$/u.test(file.sha256))).toBe(true)
      expect(descriptor.files.every(file => file.sha256 !== '0'.repeat(64))).toBe(true)
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
