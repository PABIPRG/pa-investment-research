import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  coordinateInvestmentInstance,
  INVESTMENT_INSTANCE_CONFLICT_CODE,
  investmentInstanceLockDirectory,
  type InvestmentInstanceLease,
  type InvestmentInstanceOwner,
} from '../src/investment-instance.ts'

const roots = new Set<string>()

async function temporaryRoot(): Promise<string> {
  const root = join(tmpdir(), `dsh-instance-${crypto.randomUUID()}`)
  await mkdir(root, { recursive: true })
  roots.add(root)
  return root
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all([...roots].map(root => rm(root, { recursive: true, force: true })))
  roots.clear()
})

describe('investment application instance coordination', () => {
  it('reports the live owner and never replaces it without confirmation', async () => {
    const dshHome = await temporaryRoot()
    const web = await coordinateInvestmentInstance({ mode: 'web', dshHome })
    let observed: InvestmentInstanceOwner | undefined

    try {
      await expect(coordinateInvestmentInstance({
        mode: 'electron',
        dshHome,
        onConflict(owner) {
          observed = owner
          return 'cancel'
        },
      })).rejects.toMatchObject({ code: INVESTMENT_INSTANCE_CONFLICT_CODE })
      expect(observed).toMatchObject({ mode: 'web', pid: process.pid })
      expect(observed).not.toHaveProperty('controlToken')
      expect(observed).not.toHaveProperty('controlPort')
    } finally {
      await web.release()
    }
  })

  it('asks the live owner to stop, waits for release, and transfers ownership', async () => {
    const dshHome = await temporaryRoot()
    const events: string[] = []
    const web = await coordinateInvestmentInstance({ mode: 'web', dshHome, pollMs: 5 })
    web.onStopRequested(() => {
      events.push('web-stop-requested')
      void web.release().then(() => { events.push('web-released') })
    })

    let electron: InvestmentInstanceLease | undefined
    try {
      electron = await coordinateInvestmentInstance({
        mode: 'electron',
        dshHome,
        pollMs: 5,
        stopTimeoutMs: 2_000,
        onConflict(owner) {
          events.push(`confirm-replace-${owner.mode}`)
          return 'replace'
        },
      })

      expect(electron.owner.mode).toBe('electron')
      expect(events).toEqual(['confirm-replace-web', 'web-stop-requested', 'web-released'])
      const persisted = JSON.parse(await readFile(
        join(investmentInstanceLockDirectory(dshHome), 'owner.json'),
        'utf8',
      )) as { instanceId: string }
      expect(persisted.instanceId).toBe(electron.owner.instanceId)
    } finally {
      await electron?.release()
      await web.release()
    }
  })

  it('recovers an exclusive lease left by a process that is no longer alive', async () => {
    const dshHome = await temporaryRoot()
    const lockDir = investmentInstanceLockDirectory(dshHome)
    await mkdir(lockDir, { recursive: true })
    await writeFile(join(lockDir, 'owner.json'), `${JSON.stringify({
      version: 1,
      instanceId: crypto.randomUUID(),
      mode: 'web',
      pid: 2_147_483_647,
      startedAt: new Date(0).toISOString(),
      projectDir: '/stale',
      controlPort: 65_535,
      controlToken: 'x'.repeat(64),
    })}\n`)

    const lease = await coordinateInvestmentInstance({ mode: 'electron', dshHome, pollMs: 5 })
    try {
      expect(lease.owner.mode).toBe('electron')
    } finally {
      await lease.release()
    }
  })
})
