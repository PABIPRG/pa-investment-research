/** Type-check every runnable application through its existing Project Reference graph. */

import { existsSync, globSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { WorkspaceTypertGenerator } from '../packages/typert/generator/src/workspace.ts'
import type { WorkspaceEmitResult } from '../packages/typert/generator/src/workspace.ts'

const require = createRequire(import.meta.url)
const CONTRACT_CACHE = 'node_modules/.cache/dsh/startup-typert.sha256'
const CONTRACT_INPUTS = [
  'tsconfig*.json',
  'apps/*/{package.json,tsconfig*.json,src/**/*.ts,src/**/*.tsx}',
  'packages/*/*/{package.json,tsconfig*.json,src/**/*.ts,src/**/*.tsx}',
  'vendor/*/{package.json,tsconfig*.json,src/**/*.ts,src/**/*.tsx}',
  'scripts/startup-typecheck.ts',
] as const

type ContractGenerator = (packages: readonly string[]) => readonly WorkspaceEmitResult[]

/**
 * Discover all application TypeScript projects.
 *
 * Every workspace under `apps/` is a startup surface. Discovering manifests,
 * rather than maintaining a second allowlist, makes a newly added application
 * part of the gate automatically. Its own Project References provide the
 * Host/Client dependency closure.
 *
 * @param root - Frontend workspace root.
 * @returns Sorted workspace-relative tsconfig paths.
 */
export function startupProjectConfigs(root: string): string[] {
  return globSync('apps/*/package.json', { cwd: root }).sort().map((manifestPath) => {
    const configPath = resolve(root, manifestPath, '..', 'tsconfig.json')
    if (!existsSync(configPath)) throw new Error(`${manifestPath} has no sibling tsconfig.json`)
    return relative(root, configPath).split(sep).join('/')
  })
}

/**
 * Discover packages whose generated Remote declarations are startup inputs.
 * @param root - Frontend workspace root.
 * @returns Package names in stable order.
 */
export function startupContractPackages(root: string): string[] {
  const packages: string[] = []
  for (const manifestPath of globSync('packages/*/*/package.json', { cwd: root })) {
    const manifest = JSON.parse(readFileSync(join(root, manifestPath), 'utf8')) as {
      name?: unknown
      exports?: unknown
    }
    const exportsField = manifest.exports
    if (exportsField === null || typeof exportsField !== 'object' || Array.isArray(exportsField)) continue
    if (!Object.hasOwn(exportsField, './remote')) continue
    if (typeof manifest.name !== 'string' || manifest.name === '') {
      throw new Error(`${manifestPath} exports ./remote without a package name`)
    }
    packages.push(manifest.name)
  }
  return packages.sort()
}

/**
 * Write only declaration artifacts needed by TypeScript package resolution.
 * Runtime JavaScript remains owned by the formal build.
 * @param root - Frontend workspace root.
 * @param artifacts - Generated Host and Host-for-Client contracts.
 */
export function writeStartupTypeContracts(root: string, artifacts: readonly WorkspaceEmitResult[]): void {
  for (const artifact of artifacts) {
    if (artifact.face !== 'host') throw new Error(`startup typecheck received ${artifact.face} contract`)
    if (artifact.remote === undefined) throw new Error(`${artifact.package} exports ./remote but generated no Remote contract`)
    const output = resolve(root, artifact.packageRoot, 'lib')
    mkdirSync(output, { recursive: true })
    writeFileSync(join(output, 'typert.host.d.ts'), artifact.dts)
    writeFileSync(join(output, 'typert.remote-client.d.ts'), artifact.remote.dts)
    writeFileSync(join(output, 'typert.remote-client.d.ts.map'), artifact.remote.dtsMap)
  }
}

/**
 * Generate missing or stale startup declarations, using a content fingerprint
 * so an unchanged pre-push check does not repeat whole-program Typert analysis.
 * @param root - Frontend workspace root.
 * @param generate - Contract generator override used by focused tests.
 */
export function prepareStartupTypeContracts(
  root: string,
  generate: ContractGenerator = packages => new WorkspaceTypertGenerator(root).generate(packages, ['host']),
): void {
  const packages = startupContractPackages(root)
  const fingerprint = startupContractFingerprint(root)
  const cachePath = resolve(root, CONTRACT_CACHE)
  if (existsSync(cachePath)
    && readFileSync(cachePath, 'utf8') === fingerprint
    && startupContractOutputs(root).every(path => existsSync(path))) return

  const artifacts = generate(packages)
  writeStartupTypeContracts(root, artifacts)
  mkdirSync(dirname(cachePath), { recursive: true })
  writeFileSync(cachePath, fingerprint)
}

function startupContractFingerprint(root: string): string {
  const hash = createHash('sha256')
  for (const path of globSync(CONTRACT_INPUTS, { cwd: root }).sort()) {
    hash.update(path)
    hash.update('\0')
    hash.update(readFileSync(resolve(root, path)))
    hash.update('\0')
  }
  return `${hash.digest('hex')}\n`
}

function startupContractOutputs(root: string): string[] {
  const outputs: string[] = []
  for (const manifestPath of globSync('packages/*/*/package.json', { cwd: root })) {
    const manifest = JSON.parse(readFileSync(resolve(root, manifestPath), 'utf8')) as { exports?: unknown }
    const exportsField = manifest.exports
    if (exportsField === null || typeof exportsField !== 'object' || Array.isArray(exportsField)) continue
    if (!Object.hasOwn(exportsField, './remote')) continue
    const output = resolve(root, dirname(manifestPath), 'lib')
    outputs.push(
      join(output, 'typert.host.d.ts'),
      join(output, 'typert.remote-client.d.ts'),
      join(output, 'typert.remote-client.d.ts.map'),
    )
  }
  return outputs
}

function main(): void {
  const root = process.cwd()
  const projects = startupProjectConfigs(root)
  if (projects.length === 0) throw new Error('startup typecheck discovered no app projects')

  prepareStartupTypeContracts(root)
  const tsc = require.resolve('typescript/bin/tsc')
  const result = spawnSync(process.execPath, [tsc, '--build', ...projects, '--pretty', 'false'], {
    cwd: root,
    stdio: 'inherit',
  })
  if (result.error !== undefined) throw result.error
  process.exitCode = result.status ?? 1
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main()
