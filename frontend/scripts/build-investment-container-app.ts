import { spawn } from 'node:child_process'
import { lstat, mkdir, mkdtemp, opendir, readlink, realpath, rename, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { materializePackagingWorkspaceLinks } from '../apps/electron/src/packaging.ts'

interface BuildContainerAppOptions {
  readonly output: string
}

export interface ContainerAppPlan {
  readonly appSourceDir: string
  readonly command: string
  readonly args: readonly string[]
  readonly output: string
  readonly stagingDir: string
  readonly workspaceDir: string
}

function workspaceDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..')
}

/** Describe the isolated production deploy used by the runtime image. */
export function createContainerAppPlan(rootDir: string, output: string): ContainerAppPlan {
  const workspace = workspaceDir()
  const stagingDir = join(rootDir, 'deploy')
  return Object.freeze({
    appSourceDir: join(workspace, 'apps', 'cli'),
    command: process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    args: ['--filter', '@deepseek-ai/dsh', 'deploy', '--prod', '--legacy', stagingDir],
    output: resolve(output),
    stagingDir,
    workspaceDir: workspace,
  })
}

async function run(command: string, args: readonly string[], cwd: string): Promise<void> {
  const exitCode = await new Promise<number>((resolveExit, reject) => {
    const child = spawn(command, [...args], { cwd, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code) => { resolveExit(code ?? 1) })
  })
  if (exitCode !== 0) throw new Error(`container application deploy failed with exit code ${exitCode}`)
}

async function assertRelocatable(root: string): Promise<void> {
  const canonicalRoot = await realpath(root)
  const pending = [root]
  while (pending.length > 0) {
    const directory = pending.pop()
    if (!directory) break
    const entries = await opendir(directory)
    for await (const entry of entries) {
      const path = join(directory, entry.name)
      const metadata = await lstat(path)
      if (metadata.isSymbolicLink()) {
        const target = await readlink(path)
        if (isAbsolute(target)) throw new Error(`container application contains an absolute symbolic link: ${path}`)
        const canonicalTarget = await realpath(path)
        const targetRelative = relative(canonicalRoot, canonicalTarget)
        if (targetRelative === '..' || targetRelative.startsWith(`..${sep}`) || isAbsolute(targetRelative)) {
          throw new Error(`container application link escapes its deployment root: ${path}`)
        }
      }
      if (metadata.isDirectory()) pending.push(path)
    }
  }
}

/** Assemble a relocatable, production-only CLI dependency tree. */
export async function buildContainerApp(options: BuildContainerAppOptions): Promise<void> {
  const output = resolve(options.output)
  await mkdir(dirname(output), { recursive: true })
  const rootDir = await mkdtemp(join(tmpdir(), 'dsh-container-app-'))
  const plan = createContainerAppPlan(rootDir, output)
  try {
    await run(plan.command, plan.args, plan.workspaceDir)
    await materializePackagingWorkspaceLinks(plan.stagingDir, plan.workspaceDir, plan.appSourceDir, 'linux')
    await assertRelocatable(plan.stagingDir)
    await rm(output, { force: true, recursive: true })
    await rename(plan.stagingDir, output)
  } finally {
    await rm(rootDir, { force: true, recursive: true })
  }
}

function parseCli(argv: readonly string[]): BuildContainerAppOptions {
  if (argv.length !== 2 || argv[0] !== '--output' || !argv[1]) {
    throw new Error('usage: build-investment-container-app --output <dir>')
  }
  return { output: argv[1] }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    await buildContainerApp(parseCli(process.argv.slice(2)))
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
