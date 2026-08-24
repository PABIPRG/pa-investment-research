import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
    await writeFile(join(fixtureDir, 'lib/main.js'), [
      "import { writeFileSync } from 'node:fs'",
      "import { fileURLToPath } from 'node:url'",
      "writeFileSync(fileURLToPath(new URL('../argv.json', import.meta.url)), JSON.stringify(process.argv.slice(2)))",
      'process.exitCode = 23',
      '',
    ].join('\n'))
    await writeFile(join(fixtureDir, 'lib/preload.cjs'), '\n')
    await writeFile(join(fixtureDir, 'renderer/index.html'), '<!doctype html>\n')
    await writeFile(join(fixtureDir, 'node_modules/electron/package.json'), JSON.stringify({ main: 'index.cjs' }))
    await writeFile(join(fixtureDir, 'node_modules/electron/index.cjs'), 'module.exports = process.execPath\n')

    await expect(runElectronApplication({
      appDir: fixtureDir,
      profile: 'investment-research',
    })).resolves.toBe(23)
    expect(JSON.parse(await readFile(join(fixtureDir, 'argv.json'), 'utf8'))).toEqual([
      '--profile',
      'investment-research',
    ])
  })

  it('reports how to produce missing application artifacts', async () => {
    fixtureDir = await mkdtemp(join(tmpdir(), 'dsh-electron-launch-'))
    await writeFile(join(fixtureDir, 'package.json'), JSON.stringify({ type: 'module', main: 'lib/main.js' }))

    await expect(runElectronApplication({ appDir: fixtureDir })).rejects.toThrow("run 'pnpm run build'")
  })
})
