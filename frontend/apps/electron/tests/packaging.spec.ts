/** Electron packaging keeps the Python sidecar outside the application staging tree. */

import { chmod, cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import forgeConfig from '../forge.config.ts'
import { appIdentity, packagerIconPath } from '../src/app-identity.ts'
import {
  commandRequiresShell,
  copyPortablePackageTree,
  createPackagerOptions,
  createPackagingPlan,
  materializePackagingWorkspaceLinks,
  packagerWithIconWarningGuard,
  packagingDirectoryLinkTarget,
  refreshPackagedSidecarDescriptor,
  removePackagingRoot,
  signPackagedMacApplications,
  signPackagedElectronHelpers,
  signPackagedSidecarMachO,
  validatePackagerIcon,
} from '../src/packaging.ts'

describe('Electron investment sidecar packaging', () => {
  it.each([
    { arch: 'arm64', extension: '.icns', platform: 'darwin', resolver: 'mac.js' },
    { arch: 'x64', extension: '.icns', platform: 'darwin', resolver: 'mac.js' },
    { arch: 'x64', extension: '.ico', platform: 'win32', resolver: 'win32.js' },
  ] as const)(
    'passes an existing $extension icon through the real $platform-$arch Packager resolver',
    async ({ arch, extension, platform, resolver }) => {
      const plan = createPackagingPlan(`/tmp/dsh-electron-${platform}-${arch}-icon-test`, platform, arch)
      const options = createPackagerOptions({
        arch,
        electronVersion: '43.2.0',
        electronZipDir: '/tmp/electron',
        outDir: '/tmp/out',
        platform,
        sidecarDir: plan.sidecarDir,
        stagingDir: plan.stagingDir,
      })

      expect(options.icon).toBe(`${appIdentity.iconPath}${extension}`)
      const require = createRequire(import.meta.url)
      const packagerModule = require(join(dirname(require.resolve('@electron/packager')), resolver)) as {
        App: new (packagerOptions: { icon: string }, templatePath: string) => {
          normalizeIconExtension(targetExtension: string): Promise<string | undefined>
        }
      }
      const platformApp = new packagerModule.App(options as { icon: string }, '')
      await expect(platformApp.normalizeIconExtension(extension)).resolves.toBe(options.icon)
    },
  )

  it('resolves a valid multi-size ICO through the Windows packager instead of skipping the app icon', async () => {
    // Exercise the resolver used by the pinned Packager version on any CI host.
    const require = createRequire(import.meta.url)
    const { WindowsApp } = require(join(dirname(require.resolve('@electron/packager')), 'win32.js')) as {
      WindowsApp: new (options: { icon: string }, templatePath: string) => {
        getIconPath(): Promise<string | undefined>
      }
    }
    const windowsApp = new WindowsApp({ icon: packagerIconPath('win32') }, '')
    const iconPath = await windowsApp.getIconPath()
    expect(iconPath).toBe(packagerIconPath('win32'))
    const ico = await readFile(iconPath!)
    expect(ico.readUInt16LE(0)).toBe(0)
    expect(ico.readUInt16LE(2)).toBe(1)
    const count = ico.readUInt16LE(4)
    expect(count).toBe(7)
    const sizes: number[] = []
    for (let index = 0; index < count; index += 1) {
      const entry = 6 + index * 16
      const size = ico[entry] || 256
      expect(ico[entry + 1] || 256).toBe(size)
      const length = ico.readUInt32LE(entry + 8)
      const offset = ico.readUInt32LE(entry + 12)
      expect(offset).toBeGreaterThanOrEqual(6 + count * 16)
      expect(offset + length).toBeLessThanOrEqual(ico.length)
      const png = ico.subarray(offset, offset + length)
      expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      expect(png.readUInt32BE(16)).toBe(size)
      expect(png.readUInt32BE(20)).toBe(size)
      sizes.push(size)
    }
    expect(sizes).toEqual([16, 24, 32, 48, 64, 128, 256])
  })

  it('rejects a missing target icon before Electron Packager can skip it', async () => {
    const plan = createPackagingPlan('/tmp/dsh-electron-missing-icon-test', 'win32', 'x64')
    const options = createPackagerOptions({
      arch: 'x64',
      electronVersion: '43.2.0',
      electronZipDir: '/tmp/electron',
      outDir: '/tmp/out',
      platform: 'win32',
      sidecarDir: plan.sidecarDir,
      stagingDir: plan.stagingDir,
    })
    options.icon = join(tmpdir(), 'pab22-icon-does-not-exist.ico')

    await expect(validatePackagerIcon(options)).rejects.toThrow('target icon is missing')
  })

  it.each([
    { arch: 'arm64', extension: '.icns', platform: 'darwin' },
    { arch: 'x64', extension: '.ico', platform: 'win32' },
  ] as const)('fails $platform assembly when Packager warns that the required $extension icon was skipped', async ({ arch, extension, platform }) => {
    const plan = createPackagingPlan(`/tmp/dsh-electron-${platform}-icon-warning-test`, platform, arch)
    const options = createPackagerOptions({
      arch,
      electronVersion: '43.2.0',
      electronZipDir: '/tmp/electron',
      outDir: '/tmp/out',
      platform,
      sidecarDir: plan.sidecarDir,
      stagingDir: plan.stagingDir,
    })

    await expect(packagerWithIconWarningGuard(options, async () => {
      console.warn(`WARNING: Could not find icon "app-icon${extension}", with extension "${extension}", skipping this app icon format`)
      return []
    })).rejects.toThrow('Packager rejected the target icon')
  })

  it('ignores only Packager 18\'s optional Apple icon-composer probe for a validated ICNS', async () => {
    const plan = createPackagingPlan('/tmp/dsh-electron-icon-probe-test', 'darwin', 'arm64')
    const options = createPackagerOptions({
      arch: 'arm64',
      electronVersion: '43.2.0',
      electronZipDir: '/tmp/electron',
      outDir: '/tmp/out',
      platform: 'darwin',
      sidecarDir: plan.sidecarDir,
      stagingDir: plan.stagingDir,
    })

    await expect(packagerWithIconWarningGuard(options, async () => {
      console.warn(`WARNING: Could not find icon "${String(options.icon)}" with extension ".icon", skipping this app icon format`)
      return ['/tmp/packaged']
    })).resolves.toEqual(['/tmp/packaged'])
  })

  it('preserves downloads outside disposable roots and separates targets', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'packaging-cache-'))
    try {
      const cache = join(fixture, 'downloads')
      const first = createPackagingPlan(join(fixture, 'first'), 'darwin', 'arm64', cache)
      const second = createPackagingPlan(join(fixture, 'second'), 'darwin', 'arm64', cache)
      const intel = createPackagingPlan(join(fixture, 'third'), 'darwin', 'x64', cache)
      await mkdir(first.sidecarCacheDir, { recursive: true })
      await writeFile(join(first.sidecarCacheDir, 'archive'), 'cached download')
      await mkdir(first.rootDir)
      await removePackagingRoot(first.rootDir)
      expect(await readFile(join(second.sidecarCacheDir, 'archive'), 'utf8')).toBe('cached download')
      expect(intel.sidecarCacheDir).not.toBe(first.sidecarCacheDir)
    } finally { await rm(fixture, { recursive: true, force: true }) }
  })

  it('uses the Windows command shell only for batch entrypoints', () => {
    expect(commandRequiresShell('pnpm.cmd', 'win32')).toBe(true)
    expect(commandRequiresShell('electron-forge.bat', 'win32')).toBe(true)
    expect(commandRequiresShell('pnpm', 'win32')).toBe(false)
    expect(commandRequiresShell('pnpm.cmd', 'darwin')).toBe(false)
  })

  it('uses absolute junction targets on Windows and relocatable links elsewhere', () => {
    const linkPath = join(tmpdir(), 'package', 'app', 'node_modules', 'example')
    const targetDir = join(tmpdir(), 'package', 'app', 'node_modules', '.portable', 'example')

    expect(packagingDirectoryLinkTarget(linkPath, targetDir, 'win32')).toBe(resolve(targetDir))
    expect(packagingDirectoryLinkTarget(linkPath, targetDir, 'darwin')).toBe(relative(dirname(linkPath), targetDir))
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
    expect(relative(plan.stagingDir, plan.portableStagingDir)).toMatch(/^\.\./)
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

  it('recursively materializes runtime dependencies of workspace links outside the virtual root', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'dsh-electron-root-link-test-'))
    const workspaceDir = join(rootDir, 'workspace')
    const baseSourceDir = join(workspaceDir, 'packages', 'bundle', 'base')
    const pluginSourceDir = join(workspaceDir, 'packages', 'plugin', 'example')
    const appSourceDir = join(workspaceDir, 'apps', 'electron')
    const stagingDir = join(rootDir, 'app')
    const stagedBase = join(stagingDir, 'node_modules', '@deepseek-ai', 'dsh-base')
    const workspacePlugin = join(
      workspaceDir,
      'node_modules',
      '.pnpm',
      'node_modules',
      '@deepseek-ai',
      'dsh-example',
    )
    try {
      await mkdir(join(baseSourceDir, 'lib'), { recursive: true })
      await mkdir(join(pluginSourceDir, 'lib'), { recursive: true })
      await mkdir(appSourceDir, { recursive: true })
      await mkdir(dirname(stagedBase), { recursive: true })
      await mkdir(dirname(workspacePlugin), { recursive: true })
      await writeFile(join(baseSourceDir, 'package.json'), JSON.stringify({
        dependencies: { '@deepseek-ai/dsh-example': 'workspace:^' },
        exports: './lib/index.mjs',
        name: '@deepseek-ai/dsh-base',
        type: 'module',
      }))
      await writeFile(join(baseSourceDir, 'lib', 'index.mjs'), "export { value } from '@deepseek-ai/dsh-example'\n")
      await writeFile(join(pluginSourceDir, 'package.json'), JSON.stringify({
        exports: './lib/index.mjs',
        name: '@deepseek-ai/dsh-example',
        type: 'module',
      }))
      await writeFile(join(pluginSourceDir, 'lib', 'index.mjs'), "export const value = 'recursive dependency'\n")
      await writeFile(join(appSourceDir, 'package.json'), '{"name":"@deepseek-ai/dsh-electron"}')
      await writeFile(join(stagingDir, 'package.json'), '{"name":"@deepseek-ai/dsh-electron"}')
      await symlink(baseSourceDir, stagedBase, 'dir')
      await symlink(relative(dirname(workspacePlugin), pluginSourceDir), workspacePlugin, 'dir')

      expect(await materializePackagingWorkspaceLinks(stagingDir, workspaceDir, appSourceDir)).toBe(1)

      const baseRequire = createRequire(join(await realpath(stagedBase), 'package.json'))
      const pluginEntry = baseRequire.resolve('@deepseek-ai/dsh-example')
      const loadedBase = await import(join(stagedBase, 'lib', 'index.mjs')) as { value: string }
      expect(loadedBase.value).toBe('recursive dependency')
      const pluginRelative = relative(await realpath(stagingDir), await realpath(pluginEntry))
      expect(pluginRelative).not.toBe('..')
      expect(pluginRelative.startsWith(`..${sep}`)).toBe(false)
      expect(isAbsolute(pluginRelative)).toBe(false)
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
        derefSymlinks: false,
        dir: plan.stagingDir,
      }))
      expect(options.icon).toBe(packagerIconPath('darwin'))
      expect(options.icon).toMatch(/app-icon\.icns$/)
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

  it('copies a portable package tree without retaining deploy-time links', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'dsh-electron-portable-links-test-'))
    const stagingDir = join(rootDir, 'app')
    const packageSource = join(rootDir, 'workspace-package')
    const packageLink = join(stagingDir, 'node_modules', '@deepseek-ai', 'example')
    const portableDir = join(rootDir, 'portable')
    try {
      await mkdir(join(packageSource, 'lib'), { recursive: true })
      await mkdir(join(packageSource, 'node_modules', 'excluded'), { recursive: true })
      await mkdir(dirname(packageLink), { recursive: true })
      await writeFile(join(packageSource, 'package.json'), '{"name":"@deepseek-ai/example"}')
      await writeFile(join(packageSource, 'lib', 'index.js'), 'export const value = 1\n')
      await writeFile(join(packageSource, 'node_modules', 'excluded', 'marker'), 'exclude me')
      await symlink(packageSource, packageLink, 'dir')

      await copyPortablePackageTree(stagingDir, portableDir)

      const portablePackage = join(portableDir, 'node_modules', '@deepseek-ai', 'example')
      expect((await lstat(portablePackage)).isSymbolicLink()).toBe(false)
      expect(await readFile(join(portablePackage, 'lib', 'index.js'), 'utf8')).toBe('export const value = 1\n')
      expect(await readFile(join(portablePackage, 'node_modules', 'excluded', 'marker'), 'utf8')).toBe('exclude me')
    } finally {
      await rm(rootDir, { force: true, recursive: true })
    }
  })

  it('keeps Electron Packager from recursively dereferencing Windows package trees', () => {
    const plan = createPackagingPlan('/tmp/dsh-electron-win32-test', 'win32', 'x64')

    const options = createPackagerOptions({
      arch: 'x64',
      electronVersion: '43.2.0',
      electronZipDir: '/tmp/electron',
      outDir: '/tmp/out',
      platform: 'win32',
      sidecarDir: plan.sidecarDir,
      stagingDir: plan.stagingDir,
    })

    expect(options.derefSymlinks).toBe(false)
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
