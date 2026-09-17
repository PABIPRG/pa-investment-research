/** Assemble a production deployment into a native Electron application and optional Forge artifacts. */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, copyFile, cp, lstat, mkdir, mkdtemp, open, opendir, readFile, readdir, readlink, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { downloadArtifact } from '@electron/get'
import { packager } from '@electron/packager'
import type { Options as PackagerOptions } from '@electron/packager'
import { appIdentity, electronAppDir, packagerIconPath } from './app-identity.ts'

const appDir = electronAppDir
const workspaceDir = resolve(appDir, '../..')
const macEntitlementsPath = join(appDir, 'entitlements.mac.plist')
const require = createRequire(import.meta.url)
const electronPackagePath = require.resolve('electron/package.json')

interface CommandSpec {
  args: string[]
  command: string
  cwd: string
}

interface PackagingPlan {
  appSourceDir: string
  deploy: CommandSpec
  packagerSeedDir: string
  rootDir: string
  sidecar: CommandSpec
  sidecarCacheDir: string
  sidecarDir: string
  stagingDir: string
  workspaceDir: string
}

interface PackagingWorkspaceLink {
  linkPath: string
  sourceDir: string
}

interface WorkspacePackage {
  manifest: {
    dependencies?: Record<string, string>
    name: string
    peerDependencies?: Record<string, string>
  }
  sourceDir: string
}

interface PackagerOptionsInput {
  arch: NonNullable<PackagerOptions['arch']>
  electronVersion: string
  electronZipDir: string
  outDir: string
  packagerSeedDir: string
  platform: NonNullable<PackagerOptions['platform']>
  sidecarDir: string
  stagingDir: string
}

interface DescriptorRetryOptions {
  maxRetries?: number
  onRetry?: (error: NodeJS.ErrnoException, attempt: number, delay: number) => void
  retryDelay?: number
  wait?: (delay: number) => Promise<void>
}

const descriptorErrorCodes = new Set(['EMFILE', 'ENFILE'])
const defaultDescriptorMaxRetries = 50
const defaultDescriptorRetryDelay = 50

/** Retry only transient file-descriptor exhaustion with bounded linear backoff. */
export async function retryDescriptorOperation<T>(
  operation: () => Promise<T>,
  options: DescriptorRetryOptions = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? defaultDescriptorMaxRetries
  const retryDelay = options.retryDelay ?? defaultDescriptorRetryDelay
  const wait = options.wait ?? (async (delay) => {
    await new Promise<void>((resolvePromise) => { setTimeout(resolvePromise, delay) })
  })
  let retries = 0
  while (true) {
    try {
      return await operation()
    } catch (error) {
      const descriptorError = error instanceof Error ? error as NodeJS.ErrnoException : undefined
      if (descriptorError?.code === undefined
        || !descriptorErrorCodes.has(descriptorError.code)
        || retries >= maxRetries) {
        throw error
      }
      retries += 1
      const delay = retryDelay * retries
      options.onRetry?.(descriptorError, retries, delay)
      await wait(delay)
    }
  }
}

async function retryPackagingFileOperation<T>(description: string, operation: () => Promise<T>): Promise<T> {
  return await retryDescriptorOperation(operation, {
    onRetry: (error, attempt, delay) => {
      console.warn(
        `Electron packaging: ${error.code} while ${description}; retry ${attempt}/${defaultDescriptorMaxRetries} in ${delay}ms`,
      )
    },
  })
}

/**
 * Report whether Node must invoke a command through the Windows command shell.
 * @param command - Executable or command-script path.
 * @param platform - Host platform running the packaging command.
 * @returns Whether the command is a Windows batch script.
 */
export function commandRequiresShell(command: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' && /\.(?:bat|cmd)$/iu.test(command)
}

/**
 * Describe the isolated deploy and sidecar build performed for one package invocation.
 * @param rootDir - Temporary root removed after packaging succeeds or fails.
 * @param platform - Electron target platform.
 * @param arch - Electron target architecture.
 * @param downloadCacheRoot - Optional persistent download directory outside staging.
 * @returns Ordered command inputs and sibling staging paths.
 */
export function createPackagingPlan(rootDir: string, platform: NodeJS.Platform, arch: string, downloadCacheRoot?: string): PackagingPlan {
  const stagingDir = join(rootDir, 'app')
  const packagerSeedDir = join(rootDir, 'packager-seed')
  const sidecarDir = join(rootDir, 'investment-python')
  const sidecarCacheDir = downloadCacheRoot
    ? resolve(downloadCacheRoot, `${platform}-${arch}`)
    : join(rootDir, 'sidecar-cache')
  const pnpmCommand = platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
  return {
    appSourceDir: appDir,
    deploy: {
      args: [
        '--filter',
        '@deepseek-ai/dsh-electron',
        'deploy',
        '--prod',
        '--legacy',
        stagingDir,
      ],
      command: pnpmCommand,
      cwd: workspaceDir,
    },
    packagerSeedDir,
    rootDir,
    sidecar: {
      args: [
        '--workspace-root',
        'run',
        'investment:sidecar:build',
        '--target',
        `${platform}-${arch}`,
        '--output',
        sidecarDir,
        '--cache',
        sidecarCacheDir,
      ],
      command: pnpmCommand,
      cwd: workspaceDir,
    },
    sidecarCacheDir,
    sidecarDir,
    stagingDir,
    workspaceDir,
  }
}

function workspaceSourceFromLinkTarget(linkTarget: string, workspaceDir: string): string | undefined {
  const normalizedWorkspaceDir = workspaceDir.split(sep).join('/').replace(/^\/+/, '')
  const normalizedLinkTarget = linkTarget.split(sep).join('/')
  const workspaceIndex = normalizedLinkTarget.indexOf(normalizedWorkspaceDir)
  if (workspaceIndex === -1) return undefined

  const sourceDir = resolve('/', normalizedLinkTarget.slice(workspaceIndex))
  const sourceRelativePath = relative(workspaceDir, sourceDir)
  if (sourceRelativePath === '' || sourceRelativePath === '..'
    || sourceRelativePath.startsWith(`..${sep}`) || isAbsolute(sourceRelativePath)) {
    return undefined
  }
  return sourceDir
}

async function collectPackagingWorkspaceLinks(
  rootDir: string,
  workspaceDir: string,
): Promise<PackagingWorkspaceLink[]> {
  const links: PackagingWorkspaceLink[] = []
  const pendingDirectories = [rootDir]
  while (pendingDirectories.length > 0) {
    const directoryPath = pendingDirectories.pop()
    if (directoryPath === undefined) break
    const directory = await opendir(directoryPath)
    for await (const entry of directory) {
      const entryPath = join(directoryPath, entry.name)
      if (entry.isDirectory()) {
        pendingDirectories.push(entryPath)
        continue
      }
      if (!entry.isSymbolicLink()) continue
      const sourceDir = workspaceSourceFromLinkTarget(await readlink(entryPath), workspaceDir)
      if (sourceDir !== undefined) links.push({ linkPath: entryPath, sourceDir })
    }
  }
  return links
}

async function collectWorkspacePackages(workspaceDir: string): Promise<Map<string, WorkspacePackage>> {
  const packages = new Map<string, WorkspacePackage>()
  const canonicalWorkspaceDir = await realpath(workspaceDir)
  const virtualRoot = join(workspaceDir, 'node_modules/.pnpm/node_modules')
  const packagePaths: string[] = []
  const root = await opendir(virtualRoot)
  for await (const entry of root) {
    const entryPath = join(virtualRoot, entry.name)
    if (!entry.name.startsWith('@') || !entry.isDirectory()) {
      packagePaths.push(entryPath)
      continue
    }
    const scope = await opendir(entryPath)
    for await (const scopedEntry of scope) packagePaths.push(join(entryPath, scopedEntry.name))
  }

  for (const packagePath of packagePaths) {
    let sourceDir: string
    let canonicalSourceDir: string
    try {
      const packageStat = await lstat(packagePath)
      sourceDir = packageStat.isSymbolicLink()
        ? resolve(dirname(packagePath), await readlink(packagePath))
        : await realpath(packagePath)
      canonicalSourceDir = await realpath(packagePath)
    } catch {
      continue
    }
    const sourceRelativePath = relative(canonicalWorkspaceDir, canonicalSourceDir)
    if (sourceRelativePath === '' || sourceRelativePath === '..'
      || sourceRelativePath.startsWith(`..${sep}`) || isAbsolute(sourceRelativePath)
      || sourceRelativePath === 'node_modules' || sourceRelativePath.startsWith(`node_modules${sep}`)) {
      continue
    }
    try {
      const manifest = JSON.parse(await readFile(join(sourceDir, 'package.json'), 'utf8')) as WorkspacePackage['manifest']
      if (typeof manifest.name === 'string' && manifest.name !== '') {
        packages.set(manifest.name, { manifest, sourceDir })
      }
    } catch {
      // Ignore virtual-store entries that are not package roots.
    }
  }
  return packages
}

async function pathResolves(path: string): Promise<boolean> {
  try {
    await realpath(path)
    return true
  } catch {
    return false
  }
}

function runtimeWorkspaceDependencies(
  workspacePackage: WorkspacePackage,
  workspacePackages: ReadonlyMap<string, WorkspacePackage>,
): string[] {
  const names = new Set<string>()
  for (const dependencies of [
    workspacePackage.manifest.dependencies,
    workspacePackage.manifest.peerDependencies,
  ]) {
    for (const [name, specifier] of Object.entries(dependencies ?? {})) {
      if (workspacePackages.has(name)) {
        names.add(name)
      } else if (specifier.startsWith('workspace:')) {
        throw new Error(`workspace runtime dependency is missing from the packaging map: ${workspacePackage.manifest.name} -> ${name}`)
      }
    }
  }
  return [...names].sort()
}

async function copyWorkspacePackage(
  sourceDir: string,
  targetDir: string,
  appSourceDir: string,
): Promise<void> {
  const excludedTopLevelEntries = sourceDir === appSourceDir
    ? new Set(['node_modules', 'out'])
    : new Set(['node_modules'])
  await rm(targetDir, { force: true, recursive: true })
  await cp(sourceDir, targetDir, {
    filter: (candidatePath) => {
      const candidateRelativePath = relative(sourceDir, candidatePath)
      const [topLevelEntry] = candidateRelativePath.split(sep)
      return topLevelEntry === undefined || !excludedTopLevelEntries.has(topLevelEntry)
    },
    recursive: true,
  })
}

/** Resolve a relocatable directory-link target for POSIX or an allowed junction target for Windows. */
export function packagingDirectoryLinkTarget(
  linkPath: string,
  targetDir: string,
  platform: NodeJS.Platform,
): string {
  return platform === 'win32' ? resolve(targetDir) : relative(dirname(linkPath), targetDir)
}

async function createPackagingDirectoryLink(
  targetDir: string,
  linkPath: string,
  platform: NodeJS.Platform,
): Promise<void> {
  await symlink(
    packagingDirectoryLinkTarget(linkPath, targetDir, platform),
    linkPath,
    platform === 'win32' ? 'junction' : 'dir',
  )
}

/** Replace legacy pnpm workspace links with relocatable links inside the staged application. */
export async function materializePackagingWorkspaceLinks(
  stagingDir: string,
  workspaceDir: string,
  appSourceDir: string,
  platform: NodeJS.Platform = process.platform,
): Promise<number> {
  const links = await collectPackagingWorkspaceLinks(stagingDir, workspaceDir)
  const materializedRoot = join(stagingDir, 'node_modules/.dsh-workspace-links')
  const deployedModules = join(stagingDir, 'node_modules/.pnpm/node_modules')
  const canonicalTargets = new Map<string, string>()

  for (const { sourceDir } of links) {
    if (canonicalTargets.has(sourceDir)) continue
    const sourceRelativePath = relative(workspaceDir, sourceDir)
    const targetDir = join(materializedRoot, sourceRelativePath)
    await copyWorkspacePackage(sourceDir, targetDir, appSourceDir)
    canonicalTargets.set(sourceDir, targetDir)
  }

  const sharedModules = join(materializedRoot, 'node_modules')
  await rm(sharedModules, { force: true, recursive: true })
  await createPackagingDirectoryLink(deployedModules, sharedModules, platform)

  await Promise.all(links.map(async ({ linkPath, sourceDir }) => {
    const targetDir = canonicalTargets.get(sourceDir)
    if (targetDir === undefined) throw new Error(`missing materialized workspace target for ${sourceDir}`)
    await rm(linkPath, { force: true, recursive: true })
    await createPackagingDirectoryLink(targetDir, linkPath, platform)
  }))

  const workspacePackages = await collectWorkspacePackages(workspaceDir)
  const pending: string[] = []
  for (const { sourceDir } of links) {
    try {
      const manifest = JSON.parse(await readFile(join(sourceDir, 'package.json'), 'utf8')) as WorkspacePackage['manifest']
      if (typeof manifest.name !== 'string' || manifest.name === '') continue
      workspacePackages.set(manifest.name, { manifest, sourceDir })
      pending.push(manifest.name)
    } catch {
      // collectPackagingWorkspaceLinks may encounter non-package directory links.
    }
  }
  for (const name of workspacePackages.keys()) {
    if (await pathResolves(join(deployedModules, ...name.split('/')))) pending.push(name)
  }
  const visited = new Set<string>()
  while (pending.length > 0) {
    const name = pending.pop()
    if (name === undefined || visited.has(name)) continue
    visited.add(name)
    const workspacePackage = workspacePackages.get(name)
    if (workspacePackage === undefined) continue
    for (const dependencyName of runtimeWorkspaceDependencies(workspacePackage, workspacePackages)) {
      const dependency = workspacePackages.get(dependencyName)
      if (dependency === undefined) continue
      const deployedDependency = join(deployedModules, ...dependencyName.split('/'))
      if (!await pathResolves(deployedDependency)) {
        let targetDir = canonicalTargets.get(dependency.sourceDir)
        if (targetDir === undefined) {
          targetDir = join(materializedRoot, relative(workspaceDir, dependency.sourceDir))
          await copyWorkspacePackage(dependency.sourceDir, targetDir, appSourceDir)
          canonicalTargets.set(dependency.sourceDir, targetDir)
        }
        await mkdir(dirname(deployedDependency), { recursive: true })
        await rm(deployedDependency, { force: true, recursive: true })
        await createPackagingDirectoryLink(targetDir, deployedDependency, platform)
      }
      pending.push(dependencyName)
    }
  }

  for (const name of visited) {
    const workspacePackage = workspacePackages.get(name)
    if (workspacePackage === undefined) continue
    const packageDir = canonicalTargets.get(workspacePackage.sourceDir)
      ?? join(deployedModules, ...name.split('/'))
    const packageRequire = createRequire(join(packageDir, 'package.json'))
    for (const dependencyName of runtimeWorkspaceDependencies(workspacePackage, workspacePackages)) {
      const searchPaths = packageRequire.resolve.paths(dependencyName) ?? []
      let resolves = false
      for (const searchPath of searchPaths) {
        if (await pathResolves(join(searchPath, ...dependencyName.split('/'), 'package.json'))) {
          resolves = true
          break
        }
      }
      if (!resolves) {
        throw new Error(`materialized workspace dependency cannot be resolved: ${name} -> ${dependencyName}`)
      }
    }
  }
  return links.length
}

async function copyPortablePackageEntry(
  sourcePath: string,
  destinationPath: string,
  ancestorDirectories: ReadonlySet<string>,
): Promise<void> {
  const sourceMetadata = await retryPackagingFileOperation(
    `reading metadata for ${sourcePath}`,
    () => lstat(sourcePath),
  )
  const resolvedSource = sourceMetadata.isSymbolicLink()
    ? await retryPackagingFileOperation(`resolving ${sourcePath}`, () => realpath(sourcePath))
    : sourcePath
  const resolvedMetadata = sourceMetadata.isSymbolicLink()
    ? await retryPackagingFileOperation(`reading metadata for ${resolvedSource}`, () => lstat(resolvedSource))
    : sourceMetadata
  if (resolvedMetadata.isFile()) {
    await retryPackagingFileOperation(
      `creating ${dirname(destinationPath)}`,
      () => mkdir(dirname(destinationPath), { recursive: true }),
    )
    await retryPackagingFileOperation(
      `copying ${resolvedSource} to ${destinationPath}`,
      () => copyFile(resolvedSource, destinationPath),
    )
    await retryPackagingFileOperation(
      `applying mode to ${destinationPath}`,
      () => chmod(destinationPath, resolvedMetadata.mode),
    )
    return
  }
  if (!resolvedMetadata.isDirectory()) {
    throw new TypeError(`deployed package contains an unsupported entry: ${sourcePath}`)
  }

  const canonicalDirectory = await retryPackagingFileOperation(
    `resolving ${resolvedSource}`,
    () => realpath(resolvedSource),
  )
  if (ancestorDirectories.has(canonicalDirectory)) {
    throw new TypeError(`deployed package contains a directory-link cycle: ${sourcePath}`)
  }
  const nestedAncestors = new Set(ancestorDirectories)
  nestedAncestors.add(canonicalDirectory)
  await retryPackagingFileOperation(
    `creating ${destinationPath}`,
    () => mkdir(destinationPath, { mode: resolvedMetadata.mode, recursive: true }),
  )
  const entries = await retryPackagingFileOperation(
    `reading directory ${resolvedSource}`,
    () => readdir(resolvedSource, { withFileTypes: true }),
  )
  for (const entry of entries) {
    await copyPortablePackageEntry(
      join(resolvedSource, entry.name),
      join(destinationPath, entry.name),
      nestedAncestors,
    )
  }
  await retryPackagingFileOperation(
    `applying mode to ${destinationPath}`,
    () => chmod(destinationPath, resolvedMetadata.mode),
  )
}

/** Dereference a deployed application sequentially so Windows packaging memory stays bounded. */
export async function copyPortablePackageTree(sourceDir: string, destinationDir: string): Promise<void> {
  await rm(destinationDir, { force: true, recursive: true })
  await copyPortablePackageEntry(sourceDir, destinationDir, new Set())
}

/** Give Electron Packager only the manifest it needs before the bounded afterCopy install. */
export async function createPackagerSeed(sourceDir: string, seedDir: string): Promise<void> {
  await rm(seedDir, { force: true, recursive: true })
  await mkdir(seedDir, { recursive: true })
  const sourceManifest = join(sourceDir, 'package.json')
  const destinationManifest = join(seedDir, 'package.json')
  await retryPackagingFileOperation(
    `copying ${sourceManifest} to ${destinationManifest}`,
    () => copyFile(sourceManifest, destinationManifest),
  )
}

/** Remove the temporary package tree with Node's built-in descriptor exhaustion retries. */
export async function removePackagingRoot(
  rootDir: string,
  remove: typeof rm = rm,
): Promise<void> {
  await remove(rootDir, {
    force: true,
    maxRetries: 50,
    recursive: true,
    retryDelay: 50,
  })
}

/** Copy one immutable sidecar tree sequentially so large Python runtimes cannot exhaust file descriptors. */
async function copySidecarTree(source: string, destination: string): Promise<void> {
  const sourceStat = await retryPackagingFileOperation(
    `reading metadata for ${source}`,
    () => lstat(source),
  )
  if (sourceStat.isFile()) {
    await retryPackagingFileOperation(
      `copying ${source} to ${destination}`,
      () => copyFile(source, destination),
    )
    await retryPackagingFileOperation(
      `applying mode to ${destination}`,
      () => chmod(destination, sourceStat.mode),
    )
    return
  }
  if (!sourceStat.isDirectory()) {
    throw new TypeError(`investment sidecar contains an unsupported entry: ${source}`)
  }
  await retryPackagingFileOperation(
    `creating ${destination}`,
    () => mkdir(destination, { mode: sourceStat.mode, recursive: true }),
  )
  const entries = await retryPackagingFileOperation(
    `reading directory ${source}`,
    () => readdir(source, { withFileTypes: true }),
  )
  for (const entry of entries) {
    await copySidecarTree(join(source, entry.name), join(destination, entry.name))
  }
  await retryPackagingFileOperation(
    `applying mode to ${destination}`,
    () => chmod(destination, sourceStat.mode),
  )
}

/**
 * Create packager options that install the sidecar directory under Electron Resources.
 * @param input - Resolved Electron artifact and temporary package paths.
 * @returns Options for the existing Electron packager and signing pipeline.
 */
export function createPackagerOptions(input: PackagerOptionsInput): PackagerOptions {
  const boundedWindowsCopy = input.platform === 'win32'
  return {
    appBundleId: appIdentity.appBundleId,
    arch: input.arch,
    asar: false,
    // Windows gives Packager only a minimal seed. The afterCopy hook installs
    // the full pnpm tree sequentially so fs-extra cannot exhaust descriptors.
    derefSymlinks: false,
    dir: boundedWindowsCopy ? input.packagerSeedDir : input.stagingDir,
    electronVersion: input.electronVersion,
    electronZipDir: input.electronZipDir,
    executableName: appIdentity.executableName,
    // macOS 上读取券商持仓要跨应用控制同花顺 Mac 版。TCC 要求发起方在
    // Info.plist 里声明用途，否则第一个 Apple Event 就会直接终止进程；
    // 文案会原样出现在系统的自动化授权弹窗里。
    extendInfo: {
      NSAppleEventsUsageDescription:
        '「投研智能体」需要控制同花顺，以读取你账户中的真实持仓。数据只在本机使用，不会上传。',
    },
    icon: packagerIconPath(input.platform),
    afterCopy: [((buildPath, _electronVersion, _platform, _arch, callback) => {
      const destination = join(dirname(buildPath), basename(input.sidecarDir))
      const installResources = async () => {
        if (boundedWindowsCopy) {
          await copyPortablePackageTree(input.stagingDir, buildPath)
        }
        await copySidecarTree(input.sidecarDir, destination)
      }
      installResources().then(
        () => { callback() },
        (reason: unknown) => { callback(reason instanceof Error ? reason : new Error(String(reason))) },
      )
    })],
    name: appIdentity.name,
    out: input.outDir,
    overwrite: true,
    platform: input.platform,
    prune: false,
    // GitHub's Windows runner checks out on D: while os.tmpdir() is on C:.
    // Build directly under outDir so Packager does not copy the full app tree
    // again when its final cross-volume move cannot use an atomic rename.
    ...(boundedWindowsCopy ? { tmpdir: false } : {}),
  }
}

const packagerIconWarning = /Could not find icon|skipping this app icon format/iu

/** Reject a missing concrete icon before starting the expensive application assembly. */
export async function validatePackagerIcon(options: PackagerOptions): Promise<string> {
  if (typeof options.icon !== 'string') {
    throw new TypeError('Electron Packager requires one concrete icon path for this target')
  }
  const icon = await stat(options.icon).catch(() => undefined)
  if (icon?.isFile() !== true) {
    throw new Error(`Electron Packager target icon is missing: ${options.icon}`)
  }
  return options.icon
}

/**
 * Run Electron Packager while turning required-format icon warnings into failures.
 * Packager 18 probes Apple's optional `.icon` format before copying a valid
 * `.icns`; suppress only that probe so a real `.icns`/`.ico` miss still fails.
 */
export async function packagerWithIconWarningGuard(
  options: PackagerOptions,
  assemble: (packagerOptions: PackagerOptions) => Promise<string[]> = packager,
): Promise<string[]> {
  const originalWarn = console.warn
  let requiredIconWarning: string | undefined
  console.warn = (...args: unknown[]) => {
    const message = args.map(String).join(' ')
    const optionalIconComposerProbe = options.platform === 'darwin'
      && typeof options.icon === 'string'
      && options.icon.endsWith('.icns')
      && message.includes('extension ".icon"')
    if (optionalIconComposerProbe) return
    if (packagerIconWarning.test(message)) {
      requiredIconWarning ??= message
      return
    }
    originalWarn(...args)
  }
  try {
    const appPaths = await assemble(options)
    if (requiredIconWarning !== undefined) {
      throw new Error(`Electron Packager rejected the target icon: ${requiredIconWarning}`)
    }
    return appPaths
  } finally {
    console.warn = originalWarn
  }
}

async function run(command: string, args: string[], cwd: string): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      shell: commandRequiresShell(command),
      stdio: 'inherit',
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolvePromise()
        return
      }
      reject(new Error(`${command} exited with ${signal ?? code}`))
    })
  })
}

type RunCommand = (command: string, args: string[], cwd: string) => Promise<void>
type RefreshDescriptor = (appPath: string) => Promise<void>
type SealSidecar = (appPath: string) => Promise<void>
type SignHelpers = (appPath: string, runCommand: RunCommand, identity?: string) => Promise<void>
type SignSidecar = (appPath: string, runCommand: RunCommand, identity?: string) => Promise<void>

/** Use a stable macOS signing identity when release credentials are available. */
export function resolveMacCodesignIdentity(environment: NodeJS.ProcessEnv = process.env): string {
  return environment.DSH_MAC_CODESIGN_IDENTITY?.trim()
    || environment.CSC_NAME?.trim()
    || '-'
}

const MACH_O_MAGICS = new Set([
  'cafebabe', 'cafebabf', 'cefaedfe', 'cffaedfe',
  'bebafeca', 'bfbafeca', 'feedface', 'feedfacf',
])

interface PackagedSidecarDescriptor {
  readonly files: readonly { readonly path: string; readonly sha256: string }[]
  readonly [key: string]: unknown
}

/** Refresh sidecar hashes after macOS recursively signs its nested Mach-O files. */
export async function refreshPackagedSidecarDescriptor(appPath: string): Promise<void> {
  const sidecarRoot = join(resolve(appPath), 'Contents', 'Resources', 'investment-python')
  const descriptorPath = join(sidecarRoot, 'runtime.json')
  const descriptor = JSON.parse(await readFile(descriptorPath, 'utf8')) as PackagedSidecarDescriptor
  if (!Array.isArray(descriptor.files)) throw new TypeError('packaged sidecar descriptor has no files array')

  const files = []
  for (const file of descriptor.files) {
    if (typeof file?.path !== 'string' || file.path === '' || file.path.includes('\\')) {
      throw new TypeError('packaged sidecar descriptor contains an invalid file path')
    }
    const absolute = resolve(sidecarRoot, ...file.path.split('/'))
    const relativePath = relative(sidecarRoot, absolute)
    if (relativePath === '' || relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
      throw new TypeError(`packaged sidecar descriptor path escapes its root: ${file.path}`)
    }
    const fileStat = await lstat(absolute)
    if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
      throw new TypeError(`packaged sidecar descriptor path is not a file: ${file.path}`)
    }
    files.push({
      path: file.path,
      sha256: createHash('sha256').update(await readFile(absolute)).digest('hex'),
    })
  }
  await writeFile(descriptorPath, `${JSON.stringify({ ...descriptor, files }, undefined, 2)}\n`, 'utf8')
}

/**
 * Remove write bits from the packaged Python Runtime after signing and hash refresh.
 * The sidecar is immutable application code; sealing it prevents Python caches or
 * ad-hoc diagnostics from silently invalidating its closed runtime descriptor.
 */
export async function sealPackagedSidecarReadOnly(appPath: string): Promise<void> {
  const sidecarRoot = join(resolve(appPath), 'Contents', 'Resources', 'investment-python')
  const seal = async (candidate: string): Promise<void> => {
    const metadata = await lstat(candidate)
    if (metadata.isSymbolicLink()) throw new TypeError(`packaged sidecar contains a symbolic link: ${candidate}`)
    if (metadata.isDirectory()) {
      const entries = await readdir(candidate, { withFileTypes: true })
      for (const entry of entries) await seal(join(candidate, entry.name))
      await chmod(candidate, 0o555)
      return
    }
    if (!metadata.isFile()) throw new TypeError(`packaged sidecar contains an unsupported entry: ${candidate}`)
    await chmod(candidate, 0o444 | (metadata.mode & 0o111))
  }
  await seal(sidecarRoot)
}

async function isMachOFile(path: string): Promise<boolean> {
  const handle = await open(path, 'r')
  try {
    const magic = Buffer.allocUnsafe(4)
    const { bytesRead } = await handle.read(magic, 0, magic.length, 0)
    return bytesRead === magic.length && MACH_O_MAGICS.has(magic.toString('hex'))
  } finally {
    await handle.close()
  }
}

/** Sign every native Python runtime or extension module with one identity. */
export async function signPackagedSidecarMachO(
  appPath: string,
  runCommand: RunCommand = run,
  identity: string = resolveMacCodesignIdentity(),
): Promise<void> {
  const sidecarRoot = join(resolve(appPath), 'Contents', 'Resources', 'investment-python')
  const files: string[] = []
  const pending = [sidecarRoot]
  while (pending.length > 0) {
    const directoryPath = pending.pop()
    if (directoryPath === undefined) break
    const directory = await opendir(directoryPath)
    for await (const entry of directory) {
      const entryPath = join(directoryPath, entry.name)
      if (entry.isSymbolicLink()) throw new TypeError(`packaged sidecar contains a symbolic link: ${entryPath}`)
      if (entry.isDirectory()) pending.push(entryPath)
      else if (entry.isFile() && await isMachOFile(entryPath)) files.push(entryPath)
    }
  }
  files.sort()
  for (const file of files) {
    await runCommand('codesign', ['--force', '--sign', identity, file], dirname(file))
  }
}

/** Sign Electron helper processes with local-development library loading enabled. */
export async function signPackagedElectronHelpers(
  appPath: string,
  runCommand: RunCommand = run,
  identity: string = resolveMacCodesignIdentity(),
): Promise<void> {
  const frameworksDir = join(resolve(appPath), 'Contents', 'Frameworks')
  const helpers: string[] = []
  const frameworks = await opendir(frameworksDir)
  for await (const entry of frameworks) {
    if (entry.isDirectory() && entry.name.endsWith('.app')) helpers.push(join(frameworksDir, entry.name))
  }
  helpers.sort()
  for (const helper of helpers) {
    await runCommand('codesign', [
      '--force', '--options', 'runtime', '--entitlements', macEntitlementsPath, '--sign', identity, helper,
    ], dirname(helper))
  }
}

/**
 * Sign packaged macOS applications without recursively opening the app's
 * entire pnpm tree in Node. The system codesign traversal keeps descriptor use bounded.
 */
export async function signPackagedMacApplications(
  packagePaths: readonly string[],
  platform: NodeJS.Platform,
  runCommand: RunCommand = run,
  refreshDescriptor: RefreshDescriptor = refreshPackagedSidecarDescriptor,
  signSidecar: SignSidecar = signPackagedSidecarMachO,
  signHelpers: SignHelpers = signPackagedElectronHelpers,
  sealSidecar: SealSidecar = sealPackagedSidecarReadOnly,
  identity: string = resolveMacCodesignIdentity(),
): Promise<void> {
  if (platform !== 'darwin') return
  for (const packagePath of packagePaths) {
    const appPath = resolve(packagePath, `${appIdentity.name}.app`)
    await runCommand('codesign', ['--force', '--deep', '--sign', identity, appPath], dirname(appPath))
    await signHelpers(appPath, runCommand, identity)
    await signSidecar(appPath, runCommand, identity)
    await refreshDescriptor(appPath)
    await sealSidecar(appPath)
    await runCommand('codesign', [
      '--force', '--options', 'runtime', '--entitlements', macEntitlementsPath, '--sign', identity, appPath,
    ], dirname(appPath))
  }
}

async function timed<T>(phase: string, action: () => Promise<T>): Promise<T> {
  const started = Date.now()
  console.log(`Electron packaging: ${phase} started`)
  try {
    const result = await action()
    console.log(`Electron packaging: ${phase} succeeded after ${Date.now() - started}ms`)
    return result
  } catch (error) {
    console.error(`Electron packaging: ${phase} failed after ${Date.now() - started}ms`)
    throw error
  }
}

async function packageApplication(): Promise<void> {
  const rootDir = await mkdtemp(join(tmpdir(), 'dsh-electron-'))
  const plan = createPackagingPlan(rootDir, process.platform, process.arch, process.env.INVESTMENT_PYTHON_DOWNLOAD_CACHE)
  try {
    // Build the sidecar while workspace development tools are still present.
    // pnpm deploy --prod records a production-only workspace state; invoking
    // the tsx-backed sidecar script afterwards can otherwise purge tsx before
    // the script starts.
    await timed('Python sidecar', () => run(plan.sidecar.command, plan.sidecar.args, plan.sidecar.cwd))
    await timed('production deploy', () => run(plan.deploy.command, plan.deploy.args, plan.deploy.cwd))
    if (process.platform === 'darwin' || process.platform === 'win32') {
      const startedAt = Date.now()
      const materializedLinks = await materializePackagingWorkspaceLinks(
        plan.stagingDir,
        plan.workspaceDir,
        plan.appSourceDir,
        process.platform,
      )
      console.log(`Electron packaging: materialized ${materializedLinks} workspace links in ${Date.now() - startedAt}ms`)
    }
    if (process.platform === 'win32') {
      const startedAt = Date.now()
      console.log('Electron packaging: creating minimal Windows Packager seed')
      await createPackagerSeed(plan.stagingDir, plan.packagerSeedDir)
      console.log(`Electron packaging: Windows Packager seed completed in ${Date.now() - startedAt}ms`)
    }
    const electronPackage: unknown = JSON.parse(await readFile(electronPackagePath, 'utf8'))
    if (typeof electronPackage !== 'object' || electronPackage === null
      || typeof (electronPackage as { version?: unknown }).version !== 'string') {
      throw new Error('Electron package manifest has no version')
    }
    const electronVersion = (electronPackage as { version: string }).version
    const checksums = JSON.parse(await readFile(join(dirname(electronPackagePath), 'checksums.json'), 'utf8')) as Record<string, string>
    const electronZip = await timed('Electron download', () => downloadArtifact({
      arch: process.arch,
      artifactName: 'electron',
      checksums,
      platform: process.platform,
      version: electronVersion,
      ...(process.env.ELECTRON_CACHE ? { cacheRoot: process.env.ELECTRON_CACHE } : {}),
    }))
    const packagerOptions = createPackagerOptions({
      arch: process.arch,
      electronVersion,
      electronZipDir: dirname(electronZip),
      platform: process.platform,
      packagerSeedDir: plan.packagerSeedDir,
      sidecarDir: plan.sidecarDir,
      stagingDir: plan.stagingDir,
      outDir: join(appDir, 'out'),
    })
    await validatePackagerIcon(packagerOptions)
    const appPaths = await timed('application assembly', () => packagerWithIconWarningGuard(packagerOptions))
    for (const packagePath of appPaths) {
      const resources = process.platform === 'darwin'
        ? join(packagePath, `${appIdentity.name}.app`, 'Contents', 'Resources')
        : join(packagePath, 'resources')
      await run(process.execPath, [
        join(workspaceDir, 'scripts', 'investment-backend-package-policy.ts'),
        '--root', join(resources, 'investment-python'),
      ], workspaceDir)
    }
    await timed('macOS signing', () => signPackagedMacApplications(appPaths, process.platform))
    for (const packagePath of appPaths) {
      const resources = process.platform === 'darwin'
        ? join(packagePath, `${appIdentity.name}.app`, 'Contents', 'Resources')
        : join(packagePath, 'resources')
      await timed('packaged sidecar verification', () => run(process.execPath, [
        join(workspaceDir, 'scripts', 'smoke-investment-python-sidecar.ts'),
        '--root', join(resources, 'investment-python'),
      ], workspaceDir))
    }
  } finally {
    await removePackagingRoot(plan.rootDir)
  }
}

async function main(): Promise<void> {
  const mode = process.argv[2]
  if (mode !== 'package' && mode !== 'make') {
    throw new Error('Expected package or make')
  }
  await packageApplication()
  if (mode === 'make') {
    const forgeBinary = join(appDir, 'node_modules', '.bin', process.platform === 'win32' ? 'electron-forge.cmd' : 'electron-forge')
    await timed('ZIP compression', () => run(forgeBinary, ['make', '--skip-package'], appDir))
  }
}

const entryPath = process.argv[1]
if (entryPath !== undefined && resolve(entryPath) === fileURLToPath(import.meta.url)) {
  await main()
}
