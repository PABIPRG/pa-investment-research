import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runElectronApplication } from '../src/electron.ts'

let fixtureDir: string | undefined

afterEach(async () => {
  if (fixtureDir !== undefined) await rm(fixtureDir, { recursive: true, force: true })
  fixtureDir = undefined
})

describe('runElectronApplication', () => {
  it('launches the application directory with its Electron executable', async () => {
    fixtureDir = await mkdtemp(join(tmpdir(), 'dsh-electron-launch-'))
    await mkdir(join(fixtureDir, 'lib'), { recursive: true })
    await mkdir(join(fixtureDir, 'renderer'), { recursive: true })
    await mkdir(join(fixtureDir, 'node_modules/electron'), { recursive: true })
    await writeFile(join(fixtureDir, 'package.json'), JSON.stringify({ type: 'module', main: 'lib/main.js' }))
    await writeFile(join(fixtureDir, 'lib/main.js'), 'process.exitCode = 23\n')
    await writeFile(join(fixtureDir, 'lib/preload.cjs'), '\n')
    await writeFile(join(fixtureDir, 'renderer/index.html'), '<!doctype html>\n')
    await writeFile(join(fixtureDir, 'node_modules/electron/package.json'), JSON.stringify({ main: 'index.cjs' }))
    await writeFile(join(fixtureDir, 'node_modules/electron/index.cjs'), 'module.exports = process.execPath\n')

    await expect(runElectronApplication(fixtureDir)).resolves.toBe(23)
  })

  it('reports how to produce missing application artifacts', async () => {
    fixtureDir = await mkdtemp(join(tmpdir(), 'dsh-electron-launch-'))
    await writeFile(join(fixtureDir, 'package.json'), JSON.stringify({ type: 'module', main: 'lib/main.js' }))

    await expect(runElectronApplication(fixtureDir)).rejects.toThrow("run 'pnpm run build'")
  })
})
