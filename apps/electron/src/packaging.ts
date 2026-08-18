/** Assemble a production deployment into a native Electron application and optional Forge artifacts. */

import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { downloadArtifact } from '@electron/get'
import { packager } from '@electron/packager'

const APP_NAME = 'DeepSeek Harness'
const appDir = dirname(dirname(fileURLToPath(import.meta.url)))
const workspaceDir = resolve(appDir, '../..')
const require = createRequire(import.meta.url)
const electronPackagePath = require.resolve('electron/package.json')

async function run(command: string, args: string[], cwd: string): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
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
  const stagingDir = await mkdtemp(join(tmpdir(), 'dsh-electron-'))
  try {
    await run('pnpm', [
      '--filter',
      '@deepseek-ai/dsh-electron',
      'deploy',
      '--prod',
      '--legacy',
      stagingDir,
    ], workspaceDir)
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
    await packager({
      appBundleId: 'com.deepseek.harness',
      arch: process.arch,
      asar: false,
      dir: stagingDir,
      electronVersion,
      electronZipDir: dirname(electronZip),
      executableName: 'deepseek-harness',
      name: APP_NAME,
      out: join(appDir, 'out'),
      overwrite: true,
      platform: process.platform,
      prune: false,
    })
  } finally {
    await rm(stagingDir, { force: true, recursive: true })
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

await main()
