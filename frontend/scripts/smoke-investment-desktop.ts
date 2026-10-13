/** Launch the final ZIP twice with isolated data; reject failed startup, leaks, or changed bytes. */
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

interface SmokeReport {
  status: 'passed'
  backends: { id: string; pid: number; baseUrl: string; runtimeInstance: string; projectDir: string }[]
}

/**
 * Validate facts from the application process before trusting a smoke result.
 * @param value - untrusted JSON emitted by the packaged executable.
 * @returns report containing three owned, isolated backend identities.
 */
export function validateSmokeReport(value: unknown): SmokeReport {
  assert(value !== null && typeof value === 'object')
  const report = value as SmokeReport
  assert.equal(report.status, 'passed')
  assert(Array.isArray(report.backends))
  assert.deepEqual(report.backends.map(backend => backend.id).sort(), ['industry-chain', 'market-watch', 'trading-core'])
  for (const backend of report.backends) {
    assert(Number.isSafeInteger(backend.pid) && backend.pid > 0)
    assert.equal(typeof backend.runtimeInstance, 'string')
    assert(backend.runtimeInstance.length > 0)
    const url = new URL(backend.baseUrl)
    assert.equal(url.protocol, 'http:')
    assert.equal(url.hostname, '127.0.0.1')
    assert(url.port && !['8000', '8100', '8200'].includes(url.port))
    assert(backend.projectDir.includes('investment-python'), 'backend did not come from the ZIP')
  }
  assert.equal(new Set(report.backends.map(backend => backend.baseUrl)).size, 3)
  return report
}

async function digest(file: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}

function launch(executable: string, root: string, iteration: number): Promise<void> {
  const env: NodeJS.ProcessEnv = {}
  for (const key of ['PATH', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL']) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  Object.assign(env, {
    HOME: join(root, 'user'), USERPROFILE: join(root, 'user'), APPDATA: join(root, 'user'), LOCALAPPDATA: join(root, 'user'),
    DSH_HOME: join(root, 'dsh-home'), DSH_DESKTOP_SMOKE: '1', DSH_DESKTOP_SMOKE_ROOT: root,
    DSH_DESKTOP_SMOKE_ITERATION: String(iteration),
    MW_SCHEDULE_ENABLED: 'false', BRIEF_SCHEDULE_ENABLED: 'false', SHADOW_SCHEDULE_ENABLED: 'false',
    NOTIFICATION_DELIVERY_ENABLED: 'false', EVENT_GENERATION_ENABLED: 'false',
    NO_PROXY: '127.0.0.1,localhost',
  })
  return new Promise((accept, reject) => {
    const child = spawn(executable, [], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', (chunk) => { output = (output + String(chunk)).slice(-65_536) })
    child.stderr.on('data', (chunk) => { output = (output + String(chunk)).slice(-65_536) })
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM') }, 120_000)
    const force = setTimeout(() => { child.kill('SIGKILL') }, 135_000)
    child.once('error', (error) => { clearTimeout(timer); clearTimeout(force); reject(error) })
    child.once('close', (code) => {
      clearTimeout(timer)
      clearTimeout(force)
      void writeFile(join(root, `process-${iteration}.log`), output).then(() => {
        if (code !== 0 || timedOut) reject(new Error(`Desktop launch ${iteration} failed (exit ${code}, timeout ${timedOut}). ${root}\n${output}`))
        else accept()
      }, reject)
    })
  })
}

/**
 * Extract and exercise one final release ZIP without changing it or real user data.
 * @param zipRoot - directory containing exactly one native-target ZIP.
 * @param reportRoot - retained evidence directory; defaults to a fresh temporary directory.
 * @returns evidence location and digest of the accepted ZIP.
 */
export async function smokeInvestmentDesktop(zipRoot: string, reportRoot?: string): Promise<{ root: string; sha256: string }> {
  assert(['darwin', 'win32'].includes(process.platform), 'desktop smoke requires a supported native host')
  const zips = (await readdir(zipRoot)).filter(name => name.endsWith(`-${process.platform}-${process.arch}.zip`))
  assert.equal(zips.length, 1, 'expected exactly one staged native-target ZIP')
  const name = zips[0]
  assert(name !== undefined)
  const zip = resolve(zipRoot, name)
  const before = await digest(zip)
  const root = reportRoot === undefined ? await mkdtemp(join(tmpdir(), 'investment-desktop-smoke-')) : resolve(reportRoot)
  await mkdir(root, { recursive: true })
  const extracted = join(root, 'extracted')
  await mkdir(extracted) // Refuse reuse of stale extraction or results.
  await mkdir(join(root, 'user'))
  const run = promisify(execFile)
  if (process.platform === 'darwin') {
    await run('/usr/bin/ditto', ['-x', '-k', zip, extracted])
  } else {
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Expand-Archive -LiteralPath $env:SMOKE_ZIP -DestinationPath $env:SMOKE_EXTRACTED'], {
      env: { ...process.env, SMOKE_ZIP: zip, SMOKE_EXTRACTED: extracted },
    })
  }
  const entries = await readdir(extracted)
  let executable: string
  if (process.platform === 'darwin') {
    const applications = entries.filter(name => name.endsWith('.app'))
    assert.equal(applications.length, 1)
    const applicationName = applications[0]
    assert(applicationName !== undefined)
    const application = join(extracted, applicationName)
    const { stdout } = await run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleExecutable', join(application, 'Contents', 'Info.plist')])
    executable = join(application, 'Contents', 'MacOS', stdout.trim())
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', application])
  } else {
    const executables = entries.filter(name => name.endsWith('.exe'))
    assert.equal(executables.length, 1)
    const executableName = executables[0]
    assert(executableName !== undefined)
    executable = join(extracted, executableName)
  }
  const reports: SmokeReport[] = []
  for (const iteration of [1, 2]) {
    await launch(executable, root, iteration)
    const report = validateSmokeReport(JSON.parse(await readFile(join(root, `result-${iteration}.json`), 'utf8')))
    for (const backend of report.backends) {
      const deadline = Date.now() + 5_000
      while (processExists(backend.pid) && Date.now() < deadline) await delay(50)
      assert(!processExists(backend.pid), `owned ${backend.id} did not exit`)
    }
    reports.push(report)
  }
  const [first, second] = reports
  assert(first !== undefined && second !== undefined)
  assert(second.backends.every(backend => !first.backends.some(old => old.runtimeInstance === backend.runtimeInstance)), 'restart reused an old backend')
  const after = await digest(zip)
  assert.equal(after, before, 'tested ZIP bytes changed')
  await writeFile(join(root, 'acceptance.json'), JSON.stringify({ status: 'passed', asset: basename(zip), sha256: after, launches: 2 }, null, 2))
  return { root, sha256: after }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const argument = (name: string): string | undefined => {
    const index = process.argv.indexOf(name)
    return index < 0 ? undefined : process.argv[index + 1]
  }
  console.log(await smokeInvestmentDesktop(resolve(argument('--zip-root') ?? 'release-assets'), argument('--report-root')))
}
