import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, posix, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'

const BACKENDS = ['trading-core', 'market-watch', 'industry-chain'] as const

interface RuntimeDescriptor {
  readonly python: { readonly executable: string }
  readonly sitePackages: string
  readonly backends: Readonly<Record<string, { readonly projectDir: string; readonly module: string }>>
  readonly files: readonly { readonly path: string; readonly sha256: string }[]
}

export interface SmokeInvestmentSidecarDependencies {
  readonly runCommand?: (
    command: string,
    args: readonly string[],
    cwd: string,
    env: Readonly<Record<string, string>>,
  ) => Promise<number>
}

function safePath(value: string): string {
  if (value === '' || value.includes('\\') || isAbsolute(value) || posix.isAbsolute(value) || posix.normalize(value) !== value) {
    throw new Error(`invalid sidecar descriptor path: ${value}`)
  }
  if (value.split('/').some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`invalid sidecar descriptor path: ${value}`)
  }
  return value
}

async function defaultRunCommand(
  command: string,
  args: readonly string[],
  cwd: string,
  env: Readonly<Record<string, string>>,
): Promise<number> {
  return await new Promise<number>((resolveExit, reject) => {
    const child = spawn(command, [...args], { cwd, env: { ...process.env, ...env }, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code) => { resolveExit(code ?? 1) })
  })
}

async function sha256(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

async function verifyFiles(root: string, files: RuntimeDescriptor['files']): Promise<void> {
  const actual: string[] = []
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name)
      const relative = absolute.slice(root.length + 1).split('\\').join('/')
      if (entry.isSymbolicLink()) throw new Error(`sidecar contains a symbolic link: ${relative}`)
      if (entry.isDirectory()) await visit(absolute)
      else if (entry.isFile() && relative !== 'runtime.json') actual.push(relative)
      else if (!entry.isFile()) throw new Error(`sidecar contains an unsupported file: ${relative}`)
    }
  }
  await visit(root)
  actual.sort()
  const declared = files.map(file => safePath(file.path))
  if (actual.length !== declared.length || actual.some((path, index) => path !== declared[index])) {
    throw new Error('sidecar descriptor has an incomplete file list')
  }
  for (const file of files) {
    const path = safePath(file.path)
    if (!/^[0-9a-f]{64}$/u.test(file.sha256)) throw new Error(`invalid descriptor hash: ${path}`)
    const absolute = join(root, ...path.split('/'))
    if (!(await stat(absolute)).isFile() || await sha256(absolute) !== file.sha256) {
      throw new Error(`sidecar file hash mismatch: ${path}`)
    }
  }
}

/** Verify the immutable descriptor, backend apps, health routes, and representative native dependencies. */
export async function smokeInvestmentPythonSidecar(
  rootValue: string,
  dependencies: SmokeInvestmentSidecarDependencies = {},
): Promise<void> {
  const root = resolve(rootValue)
  const descriptor = JSON.parse(await readFile(join(root, 'runtime.json'), 'utf8')) as RuntimeDescriptor
  const executable = safePath(descriptor.python.executable)
  const sitePackages = safePath(descriptor.sitePackages)
  const backendIds = Object.keys(descriptor.backends).sort()
  const expectedBackendIds = [...BACKENDS].sort()
  if (backendIds.length !== expectedBackendIds.length
    || backendIds.some((id, index) => id !== expectedBackendIds[index])) {
    throw new Error('sidecar descriptor must contain exactly the three investment backends')
  }
  const modules = BACKENDS.map((id) => {
    const backend = descriptor.backends[id]
    if (backend === undefined) throw new Error(`missing backend descriptor: ${id}`)
    return { projectDir: safePath(backend.projectDir), module: backend.module }
  })
  await verifyFiles(root, descriptor.files)
  const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-investment-sidecar-smoke-'))
  const script = [
    'import importlib, sys',
    `sys.path[:0] = ${JSON.stringify([sitePackages, ...modules.map(entry => entry.projectDir)])}`,
    'for name in ("numpy", "pandas", "uvicorn"): importlib.import_module(name)',
    `modules = ${JSON.stringify(modules.map(entry => entry.module))}`,
    'for spec in modules:',
    '    module_name, app_name = spec.split(":", 1)',
    '    app = getattr(importlib.import_module(module_name), app_name)',
    '    routes = {getattr(route, "path", None): getattr(route, "methods", set()) for route in app.routes}',
    '    assert "GET" in routes.get("/health", set())',
    '    if spec == "industry_chain.app:app":',
    '        assert "GET" in routes.get("/data/status", set())',
    '        assert "POST" in routes.get("/data/bootstrap", set())',
  ].join('\n')
  try {
    const exitCode = await (dependencies.runCommand ?? defaultRunCommand)(
      join(root, ...executable.split('/')),
      ['-B', '-c', script],
      root,
      {
        DSH_INVESTMENT_STATE_DIR: stateRoot,
        PYTHONDONTWRITEBYTECODE: '1',
      },
    )
    if (exitCode !== 0) throw new Error(`investment Python sidecar smoke failed with exit code ${exitCode}`)
    await verifyFiles(root, descriptor.files)
  } finally {
    await rm(stateRoot, { recursive: true, force: true })
  }
}

function parseRoot(argv: readonly string[]): string {
  if (argv.length !== 2 || argv[0] !== '--root' || argv[1] === undefined) {
    throw new Error('usage: smoke-investment-python-sidecar --root <dir>')
  }
  return argv[1]
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    await smokeInvestmentPythonSidecar(parseRoot(process.argv.slice(2)))
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
