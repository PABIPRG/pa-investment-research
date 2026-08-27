import { existsSync } from 'node:fs'
import { spawn as nodeSpawn } from 'node:child_process'
import { dirname, posix, resolve, win32 } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export type InvestmentPythonAction = 'init' | 'verify'

interface SpawnChild {
  once(event: 'error', listener: (error: Error) => void): unknown
  once(event: 'exit', listener: (code: number | null) => void): unknown
}
type SpawnFn = (
  command: string,
  args: readonly string[],
  options: { cwd: string; stdio: 'inherit' },
) => SpawnChild

export interface InvestmentPythonDependencies {
  readonly repoRoot?: string
  readonly platform?: NodeJS.Platform
  readonly exists?: (path: string) => boolean
  readonly spawn?: SpawnFn
  readonly writeError?: (message: string) => void
}

interface BackendCommand {
  readonly id: 'dsh-trading-core' | 'market-watch' | 'industry-chain'
  readonly directory: string
  readonly initScript: string
  readonly verifyScript: string
  readonly pythonExecutable: string
}

const BACKENDS = ['dsh-trading-core', 'market-watch', 'industry-chain'] as const

function defaultRepoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
}

function backendCommands(repoRoot: string, platform: NodeJS.Platform): readonly BackendCommand[] {
  const path = platform === 'win32' ? win32 : posix
  return BACKENDS.map((id) => {
    const directory = path.join(repoRoot, 'backend', id)
    const windows = platform === 'win32'
    return {
      id,
      directory,
      initScript: path.join(directory, windows ? 'init.bat' : 'init.sh'),
      verifyScript: path.join(directory, windows ? 'verify.bat' : 'verify.sh'),
      pythonExecutable: path.join(directory, 'env', windows ? 'Scripts/python.exe' : 'bin/python'),
    }
  })
}

async function spawnAndWait(spawn: SpawnFn, command: string, args: readonly string[], cwd: string): Promise<number> {
  return await new Promise<number>((resolveExit, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code) => { resolveExit(code ?? 1) })
  })
}

/** Run the three investment Python setup commands in their fixed dependency order. */
export async function runInvestmentPython(
  action: InvestmentPythonAction,
  dependencies: InvestmentPythonDependencies = {},
): Promise<number> {
  const repoRoot = dependencies.repoRoot ?? defaultRepoRoot()
  const platform = dependencies.platform ?? process.platform
  const exists = dependencies.exists ?? existsSync
  const spawn = dependencies.spawn ?? ((command, args, options) => nodeSpawn(command, [...args], options))
  const writeError = dependencies.writeError ?? ((message) => { process.stderr.write(message) })
  const backends = backendCommands(repoRoot, platform)

  if (action === 'verify') {
    const missing = backends.filter(backend => !exists(backend.pythonExecutable))
    if (missing.length > 0) {
      writeError('投研 Python 环境尚未初始化：\n')
      for (const backend of missing) {
        writeError(`- ${backend.id}: ${backend.directory}\n  初始化：${backend.initScript}\n`)
      }
      return 1
    }
  }

  for (const backend of backends) {
    const script = action === 'init' ? backend.initScript : backend.verifyScript
    const environmentOnly = action === 'verify' && backend.id === 'industry-chain'
      ? ['--environment']
      : []
    const command = platform === 'win32' ? 'cmd.exe' : 'bash'
    const args = platform === 'win32'
      ? ['/d', '/s', '/c', script, ...environmentOnly]
      : [script, ...environmentOnly]
    const exitCode = await spawnAndWait(spawn, command, args, backend.directory)
    if (exitCode !== 0) return exitCode
  }
  return 0
}

function parseAction(value: string | undefined): InvestmentPythonAction {
  if (value === 'init' || value === 'verify') return value
  throw new Error('用法：investment-python.ts <init|verify>')
}

async function main(): Promise<void> {
  try {
    process.exitCode = await runInvestmentPython(parseAction(process.argv[2]))
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main()
}
