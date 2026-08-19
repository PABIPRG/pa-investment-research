/** Process launcher for the repository's Electron desktop application. */

import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { constants } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

/** The sibling Electron application in both source and built CLI layouts. */
const ELECTRON_APP_DIR = fileURLToPath(new URL('../../electron/', import.meta.url))

/** Files the Electron application must build before source launch. */
const REQUIRED_ARTIFACTS = ['lib/main.js', 'lib/preload.cjs', 'renderer/index.html'] as const

/**
 * Launch an Electron application directory through its installed runtime and
 * inherit the current terminal until that process exits.
 * @param appDir - Electron application directory containing its manifest and built artifacts.
 * @returns the child exit code, or the conventional `128 + signal` code when signalled.
 */
export async function runElectronApplication(appDir: string = ELECTRON_APP_DIR): Promise<number> {
  const manifest = join(appDir, 'package.json')
  const missing = [manifest, ...REQUIRED_ARTIFACTS.map(path => join(appDir, path))]
    .filter(path => !existsSync(path))
  if (missing.length > 0) {
    throw new Error(`dsh electron: application artifacts are missing (${missing.join(', ')}); run 'pnpm run build' from the workspace root`)
  }

  let executable: unknown
  try {
    executable = createRequire(manifest)('electron')
  } catch (cause) {
    throw new Error(`dsh electron: Electron runtime is unavailable under ${appDir}; run 'pnpm install' from the workspace root`, { cause })
  }
  if (typeof executable !== 'string' || executable === '') {
    throw new Error(`dsh electron: the Electron package under ${appDir} did not resolve to an executable`)
  }

  return await new Promise<number>((resolve, reject) => {
    const child = spawn(executable, [appDir], { stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code !== null) {
        resolve(code)
        return
      }
      resolve(128 + (signal === null ? 0 : constants.signals[signal]))
    })
  })
}
