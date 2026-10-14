import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { load } from 'js-yaml'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { extractZipWithNode, runSmokeProcess, smokeInvestmentDesktop, validateSmokeReport } from './smoke-investment-desktop.ts'

// Python zipfile fixture: deflated binary data and an empty file, without an application.
const fixtureZip = () => Buffer.from(
  'UEsDBBQAAAgIAAAAIVxN5ebaCgAAAGQAAAAgAAAAcmVzb3VyY2VzL+S4reaWhyDmoLfmnKwvZGF0YS5iaW5jYKxv+M9AWwIAUEsDBBQAAAAIAAAAIVwAAAAAAgAAAAAAAAATAAAAcmVzb3VyY2VzL2VtcHR5LnR4dAMAUEsBAhQDFAAACAgAAAAhXE3l5toKAAAAZAAAACAAAAAAAAAAAAAAAIABAAAAAHJlc291cmNlcy/kuK3mlocg5qC35pysL2RhdGEuYmluUEsBAhQDFAAAAAgAAAAhXAAAAAACAAAAAAAAABMAAAAAAAAAAAAAAIABSAAAAHJlc291cmNlcy9lbXB0eS50eHRQSwUGAAAAAAIAAgCPAAAAewAAAAAA',
  'base64',
)

const temporary: string[] = []
const logFile = () => {
  const directory = mkdtempSync(join(tmpdir(), 'desktop-smoke-process-'))
  temporary.push(directory)
  return join(directory, 'process.log')
}
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('Node ZIP extraction used on Windows', () => {
  it.each(['valid', 'invalid'])('extracts Unicode paths or rejects a %s archive without a shell', async (kind) => {
    const parent = process.env.DSH_DESKTOP_SMOKE_TEST_ROOT ?? tmpdir()
    mkdirSync(parent, { recursive: true })
    const root = mkdtempSync(join(parent, "desktop-node-中文 ' &-"))
    const archive = join(root, '中文 archive.zip')
    const destination = join(root, '中文 output')
    mkdirSync(destination)
    const bytes = kind === 'valid' ? fixtureZip() : Buffer.from('not a ZIP')
    writeFileSync(archive, bytes)
    const logPath = join(root, 'extract.log')
    let verified = false
    try {
      const extraction = extractZipWithNode(archive, destination, { logPath, timeoutMs: 30_000, killGraceMs: 2_000 })
      if (kind === 'valid') {
        await extraction
        expect(readFileSync(join(destination, 'resources', '中文 样本', 'data.bin'))).toEqual(Buffer.from(Array.from({ length: 20 }, () => [0, 1, 127, 128, 255]).flat()))
        expect(readFileSync(join(destination, 'resources', 'empty.txt'))).toHaveLength(0)
        expect(readFileSync(logPath, 'utf8')).toContain('exit 0; signal null; timedOut false')
      } else {
        await expect(extraction).rejects.toThrow(/^Process failed \(exit [1-9]\d*, signal null\)/)
        expect(readFileSync(logPath, 'utf8')).toContain('end of central directory record signature not found')
        expect(readFileSync(logPath, 'utf8')).toContain('timedOut false')
      }
      expect(readFileSync(archive)).toEqual(bytes)
      verified = true
    } finally {
      if (verified) temporary.push(root)
      else console.error(`Node extraction evidence retained at ${root}`)
    }
  }, 45_000)
})

describe('bounded smoke processes', () => {
  it('persists output while the child is still running', async () => {
    const logPath = logFile()
    let finished = false
    const running = runSmokeProcess(process.execPath, ['-e', 'console.log("live-evidence"); setTimeout(() => {}, 800)'], {
      logPath, timeoutMs: 5_000,
    }).then(() => { finished = true })
    await expect.poll(() => readFileSync(logPath, 'utf8')).toContain('live-evidence')
    expect(finished).toBe(false)
    await running
  })

  it('does not wait for inherited output handles after the direct child exits', async () => {
    const logPath = logFile()
    const script = 'const {spawn}=require("node:child_process"); spawn(process.execPath,["-e","setTimeout(()=>{},3000)"],{stdio:["ignore",1,2]}); process.exit(0)'
    try {
      await runSmokeProcess(process.execPath, ['-e', script], { logPath, timeoutMs: 2_000 })
    } finally {
      // The fixture descendant self-exits; keep its file available on Windows until then.
      await delay(3_100)
    }
  })

  it('reports a deadline even if the child handles termination and exits zero', async () => {
    const logPath = logFile()
    await expect(runSmokeProcess(process.execPath, ['-e', 'process.on("SIGTERM",()=>process.exit(0)); setInterval(()=>{},100)'], {
      logPath, timeoutMs: 500, killGraceMs: 200,
    })).rejects.toThrow(/timed out/)
    expect(readFileSync(logPath, 'utf8')).toContain('timed out')
  })

  it('rejects nonzero exits and leaves diagnostic output', async () => {
    const logPath = logFile()
    await expect(runSmokeProcess(process.execPath, ['-e', 'console.error("fixture-failure"); process.exit(3)'], {
      logPath, timeoutMs: 5_000,
    })).rejects.toThrow(/exit 3/)
    expect(readFileSync(logPath, 'utf8')).toContain('fixture-failure')
  })

  it('records a missing executable failure', async () => {
    const logPath = logFile()
    await expect(runSmokeProcess(join(logPath, 'missing'), [], { logPath, timeoutMs: 5_000 })).rejects.toThrow()
    expect(readFileSync(logPath, 'utf8')).toContain('failed')
  })

  it('rejects after the hard deadline even when termination never confirms exit', async () => {
    vi.useFakeTimers()
    const logPath = logFile()
    const child = Object.assign(new EventEmitter(), { kill: vi.fn(() => false), unref: vi.fn() })
    const rejected = expect(runSmokeProcess('fixture', [], {
      logPath, timeoutMs: 100, killGraceMs: 200, spawnProcess: () => child as unknown as ChildProcess,
    })).rejects.toThrow(/exit unconfirmed/)
    await vi.advanceTimersByTimeAsync(1_300)
    await rejected
    expect(child.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']])
    expect(child.unref).toHaveBeenCalledOnce()
    expect(readFileSync(logPath, 'utf8')).toContain('cleanup is incomplete')
  })

  it('retains a failure report even before an executable can be launched', async () => {
    const root = mkdtempSync(join(tmpdir(), 'desktop-smoke-stage-'))
    temporary.push(root)
    await expect(smokeInvestmentDesktop(join(root, 'missing-zips'), root)).rejects.toThrow()
    expect(JSON.parse(readFileSync(join(root, 'failure.json'), 'utf8'))).toMatchObject({ stage: 'acceptance', status: 'failed' })
    expect(readFileSync(join(root, 'progress.log'), 'utf8')).toContain('"status":"started"')
  })

  it.skipIf(!['darwin', 'win32'].includes(process.platform))('extracts deflated ZIP bytes and Unicode paths before inspecting the executable', async () => {
    const parent = process.env.DSH_DESKTOP_SMOKE_TEST_ROOT ?? tmpdir()
    mkdirSync(parent, { recursive: true })
    const root = mkdtempSync(join(parent, "desktop-smoke-中文 ' &-"))
    const zip = fixtureZip()
    const zipPath = join(root, `valid-${process.platform}-${process.arch}.zip`)
    writeFileSync(zipPath, zip)
    const evidence = join(root, 'evidence')
    let verified = false
    try {
      await expect(smokeInvestmentDesktop(root, evidence, {
        extraction: { timeoutMs: 30_000, killGraceMs: 2_000 },
      })).rejects.toThrow()
      expect(JSON.parse(readFileSync(join(evidence, 'failure.json'), 'utf8'))).toMatchObject({ stage: 'verify-executable', status: 'failed' })
      const extracted = join(evidence, 'extracted', 'resources')
      expect(readFileSync(join(extracted, '中文 样本', 'data.bin'))).toEqual(Buffer.from(Array.from({ length: 20 }, () => [0, 1, 127, 128, 255]).flat()))
      expect(readFileSync(join(extracted, 'empty.txt'))).toHaveLength(0)
      expect(readFileSync(zipPath)).toEqual(zip)
      expect(readFileSync(join(evidence, 'extract.log'), 'utf8')).toContain('exit 0; signal null; timedOut false')
      verified = true
    } finally {
      if (verified) temporary.push(root)
      else console.error(`Extraction regression evidence retained at ${root}`)
    }
  }, 45_000)

  it.skipIf(!['darwin', 'win32'].includes(process.platform))('retains the extraction failure stage and live extractor output', async () => {
    const parent = process.env.DSH_DESKTOP_SMOKE_TEST_ROOT ?? tmpdir()
    mkdirSync(parent, { recursive: true })
    const root = mkdtempSync(join(parent, 'desktop-smoke-bad-zip-'))
    writeFileSync(join(root, `invalid-${process.platform}-${process.arch}.zip`), 'not a ZIP')
    const evidence = join(root, 'evidence')
    let verified = false
    try {
      await expect(smokeInvestmentDesktop(root, evidence, {
        extraction: { timeoutMs: 30_000, killGraceMs: 2_000 },
      })).rejects.toThrow(/^Process failed \(exit [1-9]\d*, signal null\)/)
      expect(JSON.parse(readFileSync(join(evidence, 'failure.json'), 'utf8'))).toMatchObject({ stage: 'extract', status: 'failed' })
      expect(readFileSync(join(evidence, 'extract.log'), 'utf8')).toContain('timedOut false')
      verified = true
    } finally {
      // Do not delete failed evidence or race cleanup against a still-running extractor.
      if (verified) temporary.push(root)
      else console.error(`Extraction regression evidence retained at ${root}`)
    }
  }, 45_000)
})

const report = () => ({
  status: 'passed',
  backends: ['trading-core', 'market-watch', 'industry-chain'].map((id, index) => ({
    id, pid: index + 101, baseUrl: `http://127.0.0.1:${51000 + index}`,
    runtimeInstance: `instance-${index}`, projectDir: `/test/investment-python/backends/${id}`,
  })),
})

describe('final desktop artifact acceptance', () => {
  it('requires all three packaged children and rejects failure, fixed ports, and missing evidence', () => {
    expect(validateSmokeReport(report()).backends).toHaveLength(3)
    expect(() => validateSmokeReport({ ...report(), status: 'failed' })).toThrow()
    expect(() => validateSmokeReport({ ...report(), backends: [] })).toThrow()
    const old = report()
    old.backends[0]!.baseUrl = 'http://127.0.0.1:8000'
    expect(() => validateSmokeReport(old)).toThrow()
    const source = report()
    source.backends[0]!.projectDir = '/repo/backend'
    expect(() => validateSmokeReport(source)).toThrow()
  })

  it.each(['investment-release.yml', 'investment-sidecar.yml'])('%s gates uploaded ZIPs on real startup after staging', (filename) => {
    const workflow = load(readFileSync(resolve(import.meta.dirname, '../../.github/workflows', filename), 'utf8')) as {
      jobs: Record<string, { steps: { name?: string; run?: string; if?: string; env?: Record<string, string>; with?: Record<string, unknown>; 'continue-on-error'?: boolean; 'timeout-minutes'?: number }[] }>
    }
    const steps = Object.values(workflow.jobs).find(job => job.steps.some(step => step.name === 'Smoke final desktop ZIP'))!.steps
    expect(Object.values(workflow.jobs).some(job => job.steps.some(step => step.run?.includes('scripts/smoke-investment-desktop.spec.ts')))).toBe(true)
    const testSteps = Object.values(workflow.jobs).find(job => job.steps.some(step => step.run?.includes('scripts/smoke-investment-desktop.spec.ts')))!.steps
    const testIndex = testSteps.findIndex(step => step.run?.includes('scripts/smoke-investment-desktop.spec.ts'))
    expect(testSteps[testIndex]?.env?.DSH_DESKTOP_SMOKE_TEST_ROOT).toContain('desktop-smoke-tests')
    expect(testSteps[testIndex + 1]).toMatchObject({
      name: 'Upload desktop acceptance test failures', if: 'failure()',
      with: { path: '${{ runner.temp }}/desktop-smoke-tests/' },
    })
    const smokeIndex = steps.findIndex(step => step.name === 'Smoke final desktop ZIP')
    expect(steps[smokeIndex]?.run).toContain('node scripts/smoke-investment-desktop.ts')
    expect(steps[smokeIndex]?.run).toContain('--zip-root release-assets')
    expect(steps[smokeIndex]?.if).toBeUndefined()
    expect(steps[smokeIndex]?.['continue-on-error']).toBeUndefined()
    expect(steps[smokeIndex]?.['timeout-minutes']).toBe(25)
    expect(steps.slice(0, smokeIndex).some(step => step.run?.includes('investment-release.ts stage'))).toBe(true)
    expect(steps.slice(smokeIndex + 1).some(step => /Upload (release candidate|downloadable test package)/.test(step.name ?? ''))).toBe(true)
  })
})
