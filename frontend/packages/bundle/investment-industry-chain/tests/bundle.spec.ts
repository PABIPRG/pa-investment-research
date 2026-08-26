import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as yaml from 'js-yaml'
import { describe, expect, it, vi } from 'vitest'
import * as BundleInvariant from '../src/invariant.ts'

const root = fileURLToPath(new URL('..', import.meta.url))

describe('investment industry-chain bundle', () => {
  it('publishes only its dependency-backed Host plugin row', () => {
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      name?: string
      dependencies?: Record<string, string>
      dsh?: { bundle?: { patch?: string } }
    }

    expect(manifest.name).toBe('@deepseek-ai/dsh-investment-industry-chain-bundle')
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    const patchPath = manifest.dsh?.bundle?.patch
    if (patchPath === undefined) throw new Error('investment industry-chain bundle patch is missing')
    expect(yaml.load(readFileSync(resolve(root, patchPath), 'utf8'))).toEqual([
      {
        insert: [
          {
            id: 'investment-industry-chain',
            name: '@deepseek-ai/dsh-investment-industry-chain',
          },
        ],
      },
    ])
    expect(manifest.dependencies).toHaveProperty('@deepseek-ai/dsh-investment-industry-chain')
    expect(manifest.dependencies).toHaveProperty('@deepseek-ai/dsh-investment-python-runtime')
  })

  it('registers the patch carrier invariant companion', async () => {
    const register = vi.fn(() => () => {})

    const dispose = await BundleInvariant.apply({ invariants: { register } } as never)

    expect(BundleInvariant.name).toBe('investment-industry-chain-bundle-invariant')
    expect(BundleInvariant.inject).toEqual(['invariants'])
    expect(register).toHaveBeenCalledWith(
      '@deepseek-ai/dsh-investment-industry-chain-bundle',
      expect.any(Function),
    )
    dispose()
  })
})
