/** Assemble a production deployment into a native Electron application and optional Forge artifacts. */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, copyFile, cp, lstat, mkdir, mkdtemp, open, opendir, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { downloadArtifact } from '@electron/get'
import { packager } from '@electron/packager'
import type { Options as PackagerOptions } from '@electron/packager'
import { appIdentity, electronAppDir } from './app-identity.ts'

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
  platform: NonNullable<PackagerOptions['platform']>
  sidecarDir: string
  stagingDir: string
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
 * @returns Ordered command inputs and sibling staging paths.
 */
export function createPackagingPlan(rootDir: string, platform: NodeJS.Platform, arch: string): PackagingPlan {
  const stagingDir = join(rootDir, 'app')
  const sidecarDir = join(rootDir, 'investment-python')
  const sidecarCacheDir = join(rootDir, 'sidecar-cache')
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
    for (const name of Object.keys(dependencies ?? {})) {
      if (workspacePackages.has(name)) names.add(name)
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

/** Replace legacy pnpm workspace links with relocatable links inside the staged application. */
export async function materializePackagingWorkspaceLinks(
  stagingDir: string,
  workspaceDir: string,
  appSourceDir: string,
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
  await symlink(relative(materializedRoot, deployedModules), sharedModules, 'dir')

  await Promise.all(links.map(async ({ linkPath, sourceDir }) => {
    const targetDir = canonicalTargets.get(sourceDir)
    if (targetDir === undefined) throw new Error(`missing materialized workspace target for ${sourceDir}`)
    await rm(linkPath, { force: true, recursive: true })
    await symlink(relative(dirname(linkPath), targetDir), linkPath, 'dir')
  }))

  const workspacePackages = await collectWorkspacePackages(workspaceDir)
  const pending: string[] = []
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
        await symlink(relative(dirname(deployedDependency), targetDir), deployedDependency, 'dir')
      }
      pending.push(dependencyName)
    }
  }
  return links.length
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
  const sourceStat = await lstat(source)
  if (sourceStat.isFile()) {
    await copyFile(source, destination)
    await chmod(destination, sourceStat.mode)
    return
  }
  if (!sourceStat.isDirectory()) {
    throw new TypeError(`investment sidecar contains an unsupported entry: ${source}`)
  }
  await mkdir(destination, { mode: sourceStat.mode, recursive: true })
  const directory = await opendir(source)
  for await (const entry of directory) {
    await copySidecarTree(join(source, entry.name), join(destination, entry.name))
  }
  await chmod(destination, sourceStat.mode)
}

/**
 * Create packager options that install the sidecar directory under Electron Resources.
 * @param input - Resolved Electron artifact and temporary package paths.
 * @returns Options for the existing Electron packager and signing pipeline.
 */
export function createPackagerOptions(input: PackagerOptionsInput): PackagerOptions {
  return {
    appBundleId: appIdentity.appBundleId,
    arch: input.arch,
    asar: false,
    dir: input.stagingDir,
    electronVersion: input.electronVersion,
    electronZipDir: input.electronZipDir,
    executableName: appIdentity.executableName,
    icon: appIdentity.iconPath,
    afterCopy: [((buildPath, _electronVersion, _platform, _arch, callback) => {
      const destination = join(dirname(buildPath), basename(input.sidecarDir))
      copySidecarTree(input.sidecarDir, destination).then(
        () => { callback() },
        (reason: unknown) => { callback(reason instanceof Error ? reason : new Error(String(reason))) },
      )
    })],
    name: appIdentity.name,
    out: input.outDir,
    overwrite: true,
    platform: input.platform,
    prune: false,
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
type SignHelpers = (appPath: string, runCommand: RunCommand) => Promise<void>
type SignSidecar = (appPath: string, runCommand: RunCommand) => Promise<void>

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

/** Ad-hoc sign every native Python runtime or extension module with one identity. */
export async function signPackagedSidecarMachO(appPath: string, runCommand: RunCommand = run): Promise<void> {
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
    await runCommand('codesign', ['--force', '--sign', '-', file], dirname(file))
  }
}

/** Sign Electron helper processes with local-development library loading enabled. */
export async function signPackagedElectronHelpers(appPath: string, runCommand: RunCommand = run): Promise<void> {
  const frameworksDir = join(resolve(appPath), 'Contents', 'Frameworks')
  const helpers: string[] = []
  const frameworks = await opendir(frameworksDir)
  for await (const entry of frameworks) {
    if (entry.isDirectory() && entry.name.endsWith('.app')) helpers.push(join(frameworksDir, entry.name))
  }
  helpers.sort()
  for (const helper of helpers) {
    await runCommand('codesign', [
      '--force', '--options', 'runtime', '--entitlements', macEntitlementsPath, '--sign', '-', helper,
    ], dirname(helper))
  }
}

/**
 * Ad-hoc sign packaged macOS applications without recursively opening the app's
 * entire pnpm tree in Node. The system codesign traversal keeps descriptor use bounded.
 */
export async function signPackagedMacApplications(
  packagePaths: readonly string[],
  platform: NodeJS.Platform,
  runCommand: RunCommand = run,
  refreshDescriptor: RefreshDescriptor = refreshPackagedSidecarDescriptor,
  signSidecar: SignSidecar = signPackagedSidecarMachO,
  signHelpers: SignHelpers = signPackagedElectronHelpers,
): Promise<void> {
  if (platform !== 'darwin') return
  for (const packagePath of packagePaths) {
    const appPath = resolve(packagePath, `${appIdentity.name}.app`)
    await runCommand('codesign', ['--force', '--deep', '--sign', '-', appPath], dirname(appPath))
    await signHelpers(appPath, runCommand)
    await signSidecar(appPath, runCommand)
    await refreshDescriptor(appPath)
    await runCommand('codesign', [
      '--force', '--options', 'runtime', '--entitlements', macEntitlementsPath, '--sign', '-', appPath,
    ], dirname(appPath))
  }
}

async function packageApplication(): Promise<void> {
  const rootDir = await mkdtemp(join(tmpdir(), 'dsh-electron-'))
  const plan = createPackagingPlan(rootDir, process.platform, process.arch)
  try {
    await run(plan.deploy.command, plan.deploy.args, plan.deploy.cwd)
    if (process.platform === 'darwin') {
      await materializePackagingWorkspaceLinks(plan.stagingDir, plan.workspaceDir, plan.appSourceDir)
    }
    await run(plan.sidecar.command, plan.sidecar.args, plan.sidecar.cwd)
    const electronPackage: unknown = JSON.parse(await readFile(electronPackagePath, 'utf8'))
    if (typeof electronPackage !== 'object' || electronPackage === null
      || typeof (electronPackage as { version?: unknown }).version !== 'string') {
      throw new Error('Electron package manifest has no version')
    }
    const electronVersion = (electronPackage as { version: string }).version
    const checksums = JSON.parse(await readFile(join(dirname(electronPackagePath), 'checksums.json'), 'utf8')) as Record<string, string>
    const electronZip = await downloadArtifact({
      arch: process.arch,
      artifactName: 'electron',
      checksums,
      platform: process.platform,
      version: electronVersion,
    })
    const appPaths = await packager(createPackagerOptions({
      arch: process.arch,
      electronVersion,
      electronZipDir: dirname(electronZip),
      platform: process.platform,
      sidecarDir: plan.sidecarDir,
      stagingDir: plan.stagingDir,
      outDir: join(appDir, 'out'),
    }))
    await signPackagedMacApplications(appPaths, process.platform)
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
    await run(forgeBinary, ['make', '--skip-package'], appDir)
  }
}

const entryPath = process.argv[1]
if (entryPath !== undefined && resolve(entryPath) === fileURLToPath(import.meta.url)) {
  await main()
}
