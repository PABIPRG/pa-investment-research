import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'
import { validateSmokeReport } from './smoke-investment-desktop.ts'

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
      jobs: Record<string, { steps: { name?: string; run?: string; if?: string; 'continue-on-error'?: boolean }[] }>
    }
    const steps = Object.values(workflow.jobs).find(job => job.steps.some(step => step.name === 'Smoke final desktop ZIP'))!.steps
    const smokeIndex = steps.findIndex(step => step.name === 'Smoke final desktop ZIP')
    expect(steps[smokeIndex]?.run).toContain('node scripts/smoke-investment-desktop.ts')
    expect(steps[smokeIndex]?.run).toContain('--zip-root release-assets')
    expect(steps[smokeIndex]?.if).toBeUndefined()
    expect(steps[smokeIndex]?.['continue-on-error']).toBeUndefined()
    expect(steps.slice(0, smokeIndex).some(step => step.run?.includes('investment-release.ts stage'))).toBe(true)
    expect(steps.slice(smokeIndex + 1).some(step => /Upload (release candidate|downloadable test package)/.test(step.name ?? ''))).toBe(true)
  })
})
