/** Assemble a production deployment into a native Electron application and optional Forge artifacts. */

import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
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
  deploy: CommandSpec
  rootDir: string
  sidecar: CommandSpec
  sidecarCacheDir: string
  sidecarDir: string
  stagingDir: string
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
  }
}

/**
 * Create packager options that install the sidecar directory under Electron Resources.
 * @param input - Resolved Electron artifact and temporary package paths.
 * @returns Options for the existing Electron packager and signing pipeline.
 */
export function createPackagerOptions(input: PackagerOptionsInput): PackagerOptions {
  return {
    appBundleId: 'com.deepseek.harness',
    arch: input.arch,
    asar: false,
    dir: input.stagingDir,
    electronVersion: input.electronVersion,
    electronZipDir: input.electronZipDir,
    executableName: 'deepseek-harness',
    extraResource: [input.sidecarDir],
    name: APP_NAME,
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

async function packageApplication(): Promise<void> {
  const rootDir = await mkdtemp(join(tmpdir(), 'dsh-electron-'))
  const plan = createPackagingPlan(rootDir, process.platform, process.arch)
  try {
    await run(plan.deploy.command, plan.deploy.args, plan.deploy.cwd)
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
    await rm(plan.rootDir, { force: true, recursive: true })
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
