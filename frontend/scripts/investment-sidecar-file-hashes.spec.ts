import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { hashSidecarFile, mapSidecarFiles } from '../apps/electron/src/sidecar-file-hashes.ts'

function latch() {
  let release = () => {}
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, release }
}

describe('bounded complete sidecar hashing', () => {
  it('limits in-flight files to four and retains descriptor order', async () => {
    const gate = latch()
    const entered = latch()
    let active = 0
    let peak = 0
    const values = Array.from({ length: 19 }, (_, index) => index)
    const pending = mapSidecarFiles(values, async (value) => {
      active++
      peak = Math.max(peak, active)
      if (active === 4) entered.release()
      await gate.promise
      active--
      return value * 2
    })
    await entered.promise
    expect(active).toBe(4)
    gate.release()
    expect(await pending).toEqual(values.map(value => value * 2))
    expect(peak).toBe(4)
  })

  it('drains in-flight reads and stops scheduling new files after failure', async () => {
    const gate = latch()
    const entered = latch()
    const failure = new Error('hash read failed')
    const started: number[] = []
    const finished: number[] = []
    const pending = mapSidecarFiles([0, 1, 2, 3, 4, 5], async (value) => {
      started.push(value)
      if (started.length === 4) entered.release()
      if (value === 0) throw failure
      await gate.promise
      finished.push(value)
      return value
    })
    let settled = false
    const outcome = pending.then(() => { settled = true }, (error: unknown) => { settled = true; return error })
    await entered.promise
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(started).toEqual([0, 1, 2, 3])
    gate.release()
    expect(await outcome).toBe(failure)
    expect(finished).toEqual([1, 2, 3])
    expect(started).toHaveLength(4)
  })

  it('hashes the entire stream identically and propagates missing-file errors', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sidecar-hashes-'))
    try {
      const content = Buffer.alloc(3 * 1024 * 1024 + 7, 0x51)
      const file = join(root, 'native.bin')
      await writeFile(file, content)
      expect(await hashSidecarFile(file)).toBe(createHash('sha256').update(content).digest('hex'))
      await expect(hashSidecarFile(join(root, 'missing'))).rejects.toThrow()
      expect(await mapSidecarFiles([], hashSidecarFile)).toEqual([])
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
