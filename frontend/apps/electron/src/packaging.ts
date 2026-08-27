/** Assemble a production deployment into a native Electron application and optional Forge artifacts. */

import { spawn } from 'node:child_process'
import { chmod, copyFile, cp, lstat, mkdir, mkdtemp, opendir, readFile, readlink, rm, symlink } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { downloadArtifact } from '@electron/get'
import { packager } from '@electron/packager'
import type { Options as PackagerOptions } from '@electron/packager'

const APP_NAME = 'DeepSeek Harness'
const appDir = dirname(dirname(fileURLToPath(import.meta.url)))
const workspaceDir = resolve(appDir, '../..')
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

interface PackagerOptionsInput {
  arch: NonNullable<PackagerOptions['arch']>
  electronVersion: string
  electronZipDir: string
  outDir: string
  platform: NonNullable<PackagerOptions['platform']>
  sidecarDir: string
  stagingDir: string
}

type PackagerOsxSignOptions = Exclude<PackagerOptions['osxSign'], true | undefined> & {
  continueOnError: boolean
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

/** Replace legacy pnpm workspace links with relocatable links inside the staged application. */
export async function materializePackagingWorkspaceLinks(
  stagingDir: string,
  workspaceDir: string,
  appSourceDir: string,
): Promise<number> {
  const links = await collectPackagingWorkspaceLinks(stagingDir, workspaceDir)
  const materializedRoot = join(stagingDir, 'node_modules/.dsh-workspace-links')
  const canonicalTargets = new Map<string, string>()

  for (const { sourceDir } of links) {
    if (canonicalTargets.has(sourceDir)) continue
    const sourceRelativePath = relative(workspaceDir, sourceDir)
    const targetDir = join(materializedRoot, sourceRelativePath)
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
    canonicalTargets.set(sourceDir, targetDir)
  }

  await Promise.all(links.map(async ({ linkPath, sourceDir }) => {
    const targetDir = canonicalTargets.get(sourceDir)
    if (targetDir === undefined) throw new Error(`missing materialized workspace target for ${sourceDir}`)
    await rm(linkPath, { force: true, recursive: true })
    await symlink(relative(dirname(linkPath), targetDir), linkPath, 'dir')
  }))
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
  const osxSign = {
    continueOnError: false,
    identity: '-',
    identityValidation: false,
  } satisfies PackagerOsxSignOptions

  return {
    appBundleId: 'com.deepseek.harness',
    arch: input.arch,
    asar: false,
    dir: input.stagingDir,
    electronVersion: input.electronVersion,
    electronZipDir: input.electronZipDir,
    executableName: 'deepseek-harness',
    afterCopy: [((buildPath, _electronVersion, _platform, _arch, callback) => {
      const destination = join(dirname(buildPath), basename(input.sidecarDir))
      copySidecarTree(input.sidecarDir, destination).then(
        () => { callback() },
        (reason: unknown) => { callback(reason instanceof Error ? reason : new Error(String(reason))) },
      )
    })],
    name: APP_NAME,
    out: input.outDir,
    overwrite: true,
    ...(input.platform === 'darwin' ? {
      osxSign,
    } : {}),
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
    await packager(createPackagerOptions({
      arch: process.arch,
      electronVersion,
      electronZipDir: dirname(electronZip),
      platform: process.platform,
      sidecarDir: plan.sidecarDir,
      stagingDir: plan.stagingDir,
      outDir: join(appDir, 'out'),
    }))
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
