/** Launch the final ZIP twice with isolated data; reject failed startup, leaks, or changed bytes. */
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, closeSync, createReadStream, openSync, writeFileSync } from 'node:fs'
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
  for await (const chunk of createReadStream(file, { signal: AbortSignal.timeout(120_000) })) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}

/**
 * Run one owned process with live file output and an exit deadline independent of inherited handles.
 * Only the returned child handle is signalled. Failure does not certify descendant cleanup.
 * @param executable - executable to spawn without a shell.
 * @param args - literal executable arguments.
 * @param options - retained log, deadline, environment, working directory and injectable spawn.
 * @returns completion after exit zero, or rejection on spawn failure, timeout or nonzero exit.
 */
export function runSmokeProcess(executable: string, args: string[], options: {
  logPath: string
  timeoutMs: number
  killGraceMs?: number
  cwd?: string
  env?: NodeJS.ProcessEnv
  spawnProcess?: (executable: string, args: string[], options: SpawnOptions) => ChildProcess
}): Promise<void> {
  const record = (message: string) => {
    appendFileSync(options.logPath, `[${new Date().toISOString()}] ${message}\n`, { mode: 0o600 })
  }
  record(`starting process: ${executable}`)
  return new Promise((accept, reject) => {
    // File descriptors remain usable by descendants without keeping a parent pipe open.
    const output = openSync(options.logPath, 'a', 0o600)
    let child: ReturnType<typeof spawn>
    try {
      child = (options.spawnProcess ?? spawn)(executable, args, { cwd: options.cwd, env: options.env, stdio: ['ignore', output, output] })
    } catch (error) {
      record(`failed: ${error instanceof Error ? error.message : String(error)}`)
      throw error
    } finally { closeSync(output) }
    record(`spawned pid ${child.pid ?? 'unavailable'}`)
    let finished = false
    let timedOut = false
    let force: ReturnType<typeof setTimeout> | undefined
    let abandoned: ReturnType<typeof setTimeout> | undefined
    const finish = (error?: Error) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      clearTimeout(force)
      clearTimeout(abandoned)
      if (error === undefined) accept()
      else reject(error)
    }
    const timer = setTimeout(() => {
      timedOut = true
      record(`timed out after ${options.timeoutMs}ms; requesting termination`)
      child.kill('SIGTERM')
      force = setTimeout(() => {
        record('termination grace expired; requesting forced termination')
        child.kill('SIGKILL')
        abandoned = setTimeout(() => {
          record('failed: no exit confirmation; cleanup is incomplete')
          child.unref()
          finish(new Error(`Process timed out; exit unconfirmed. ${options.logPath}`))
        }, 1_000)
      }, options.killGraceMs ?? 15_000)
    }, options.timeoutMs)
    child.once('error', (error) => {
      record(`failed: ${error.message}`)
      finish(error)
    })
    child.once('exit', (code, signal) => {
      record(`exit ${code}; signal ${signal}; timedOut ${timedOut}`)
      if (timedOut) finish(new Error(`Process timed out (exit ${code}, signal ${signal}). ${options.logPath}`))
      else if (code !== 0) finish(new Error(`Process failed (exit ${code}, signal ${signal}). ${options.logPath}`))
      else finish()
    })
  })
}

function processEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of ['PATH', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL']) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  return env
}

function launch(executable: string, root: string, iteration: number): Promise<void> {
  const env = processEnvironment()
  Object.assign(env, {
    HOME: join(root, 'user'), USERPROFILE: join(root, 'user'), APPDATA: join(root, 'user'), LOCALAPPDATA: join(root, 'user'),
    DSH_HOME: join(root, 'dsh-home'), DSH_DESKTOP_SMOKE: '1', DSH_DESKTOP_SMOKE_ROOT: root,
    DSH_DESKTOP_SMOKE_ITERATION: String(iteration),
    MW_SCHEDULE_ENABLED: 'false', BRIEF_SCHEDULE_ENABLED: 'false', SHADOW_SCHEDULE_ENABLED: 'false',
    NOTIFICATION_DELIVERY_ENABLED: 'false', EVENT_GENERATION_ENABLED: 'false',
    NO_PROXY: '127.0.0.1,localhost',
  })
  return runSmokeProcess(executable, [], { cwd: root, env, logPath: join(root, `process-${iteration}.log`), timeoutMs: 120_000 })
}

/**
 * Extract and exercise one final release ZIP without changing it or real user data.
 * @param zipRoot - directory containing exactly one native-target ZIP.
 * @param reportRoot - retained evidence directory; defaults to a fresh temporary directory.
 * @param options - optional extraction budget for bounded native regression fixtures; production defaults stay unchanged.
 * @returns evidence location and digest of the accepted ZIP.
 */
export async function smokeInvestmentDesktop(zipRoot: string, reportRoot?: string, options: {
  extraction?: { timeoutMs: number; killGraceMs: number }
} = {}): Promise<{ root: string; sha256: string }> {
  const root = reportRoot === undefined ? await mkdtemp(join(tmpdir(), 'investment-desktop-smoke-')) : resolve(reportRoot)
  await mkdir(root, { recursive: true })
  let failedStage = false
  const stage = async <T>(name: string, action: () => Promise<T>): Promise<T> => {
    const record = (status: string, error?: string) => {
      if (status === 'failed' && failedStage) return
      if (status === 'failed') failedStage = true
      const entry = { stage: name, status, at: new Date().toISOString(), ...(error === undefined ? {} : { error }) }
      writeFileSync(join(root, 'stage.json'), JSON.stringify(entry, null, 2), { mode: 0o600 })
      appendFileSync(join(root, 'progress.log'), `${JSON.stringify(entry)}\n`, { mode: 0o600 })
      console.log(`[desktop smoke] ${name}: ${status}${error === undefined ? '' : `: ${error}`}`)
      if (status === 'failed') writeFileSync(join(root, 'failure.json'), JSON.stringify(entry, null, 2), { mode: 0o600 })
    }
    record('started')
    try {
      const result = await action()
      record('passed')
      return result
    } catch (error) {
      record('failed', error instanceof Error ? error.message : String(error))
      throw error
    }
  }
  return stage('acceptance', async () => {
    assert(['darwin', 'win32'].includes(process.platform), 'desktop smoke requires a supported native host')
    const zips = (await readdir(zipRoot)).filter(name => name.endsWith(`-${process.platform}-${process.arch}.zip`))
    assert.equal(zips.length, 1, 'expected exactly one staged native-target ZIP')
    const name = zips[0]
    assert(name !== undefined)
    const zip = resolve(zipRoot, name)
    const before = await stage('hash-before', () => digest(zip))
    const extracted = join(root, 'extracted')
    await mkdir(extracted) // Refuse reuse of stale extraction or results.
    await mkdir(join(root, 'user'))
    const run = promisify(execFile)
    const extraction = options.extraction ?? { timeoutMs: 600_000, killGraceMs: 15_000 }
    await stage('extract', () => process.platform === 'darwin'
      ? runSmokeProcess('/usr/bin/ditto', ['-x', '-k', zip, extracted], { logPath: join(root, 'extract.log'), ...extraction })
      : runSmokeProcess(join(process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows', 'System32', 'tar.exe'),
        ['-xf', zip, '-C', extracted], {
          env: processEnvironment(), logPath: join(root, 'extract.log'), ...extraction,
        }))
    const executable = await stage('verify-executable', async () => {
      const entries = await readdir(extracted)
      if (process.platform === 'darwin') {
        const applications = entries.filter(name => name.endsWith('.app'))
        assert.equal(applications.length, 1)
        const applicationName = applications[0]
        assert(applicationName !== undefined)
        const application = join(extracted, applicationName)
        const { stdout } = await run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleExecutable', join(application, 'Contents', 'Info.plist')], { timeout: 60_000, killSignal: 'SIGKILL' })
        await runSmokeProcess('/usr/bin/codesign', ['--verify', '--deep', '--strict', application], { logPath: join(root, 'signature.log'), timeoutMs: 60_000 })
        return join(application, 'Contents', 'MacOS', stdout.trim())
      } else {
        const executables = entries.filter(name => name.endsWith('.exe'))
        assert.equal(executables.length, 1)
        const executableName = executables[0]
        assert(executableName !== undefined)
        return join(extracted, executableName)
      }
    })
    const reports: SmokeReport[] = []
    for (const iteration of [1, 2]) {
      await stage(`launch-${iteration}`, () => launch(executable, root, iteration))
      const report = await stage(`verify-${iteration}`, async () => {
        const report = validateSmokeReport(JSON.parse(await readFile(join(root, `result-${iteration}.json`), 'utf8')))
        for (const backend of report.backends) {
          const deadline = Date.now() + 5_000
          while (processExists(backend.pid) && Date.now() < deadline) await delay(50)
          assert(!processExists(backend.pid), `owned ${backend.id} did not exit`)
        }
        return report
      })
      reports.push(report)
    }
    const [first, second] = reports
    assert(first !== undefined && second !== undefined)
    assert(second.backends.every(backend => !first.backends.some(old => old.runtimeInstance === backend.runtimeInstance)), 'restart reused an old backend')
    const after = await stage('hash-after', () => digest(zip))
    assert.equal(after, before, 'tested ZIP bytes changed')
    await writeFile(join(root, 'acceptance.json'), JSON.stringify({ status: 'passed', asset: basename(zip), sha256: after, launches: 2 }, null, 2))
    return { root, sha256: after }
  })
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const argument = (name: string): string | undefined => {
    const index = process.argv.indexOf(name)
    return index < 0 ? undefined : process.argv[index + 1]
  }
  const root = argument('--report-root') ?? await mkdtemp(join(tmpdir(), 'investment-desktop-smoke-'))
  await mkdir(root, { recursive: true })
  const watchdog = setTimeout(() => {
    writeFileSync(join(root, 'deadline.json'), JSON.stringify({ status: 'failed', error: 'Acceptance exceeded 20 minutes; inspect stage.json and live logs; cleanup unconfirmed' }), { mode: 0o600 })
    console.error(`Desktop acceptance exceeded 20 minutes. Evidence: ${root}`)
    process.exit(1)
  }, 20 * 60_000)
  try {
    console.log(await smokeInvestmentDesktop(resolve(argument('--zip-root') ?? 'release-assets'), root))
  } finally { clearTimeout(watchdog) }
}
