/** Type-check every runnable application through its existing Project Reference graph. */

import { existsSync, globSync } from 'node:fs'
import { createRequire } from 'node:module'
import { relative, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)

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

function main(): void {
  const root = process.cwd()
  const projects = startupProjectConfigs(root)
  if (projects.length === 0) throw new Error('startup typecheck discovered no app projects')

  const tsc = require.resolve('typescript/bin/tsc')
  const result = spawnSync(process.execPath, [tsc, '--build', ...projects, '--pretty', 'false'], {
    cwd: root,
    stdio: 'inherit',
  })
  if (result.error !== undefined) throw result.error
  process.exitCode = result.status ?? 1
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main()
