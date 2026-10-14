/** Entry diagnostics must survive a dependency failure before application evaluation. */
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, it } from 'vitest'

const homes: string[] = []
afterEach(async () => {
  await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })))
})

it('records an import failure and exits nonzero before the application body runs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'electron-entry-failure-'))
  homes.push(root)
  await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module' }))
  await writeFile(join(root, 'main.ts'), await readFile(new URL('../src/main.ts', import.meta.url)))
  await writeFile(join(root, 'application.ts'), "import './missing-dependency.js'\nthrow new Error('application body must not run')\n")
  await expect(promisify(execFile)(process.execPath, ['--import', import.meta.resolve('tsx/esm'), join(root, 'main.ts')], {
    env: { ...process.env, DSH_DESKTOP_SMOKE: '1', DSH_DESKTOP_SMOKE_ROOT: root, DSH_HOME: join(root, 'dsh-home'), DSH_DESKTOP_SMOKE_ITERATION: '1' },
    timeout: 10_000,
  })).rejects.toMatchObject({ code: 1, killed: false })
  const phases = (await readFile(join(root, 'startup-phases.log'), 'utf8')).trim().split('\n').map(line => (JSON.parse(line) as { stage: string }).stage)
  expect(phases).toEqual(['entry-start', 'application-import-start', 'application-import-failed'])
  const failure = await readFile(join(root, 'entry-failure-1.log'), 'utf8')
  expect(failure).toContain('missing-dependency.js')
  expect(failure).not.toContain('application body must not run')
}, 15_000)
