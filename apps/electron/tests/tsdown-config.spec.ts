/** Electron bundle configuration keeps the runtime-provided API external. */

import { describe, expect, it } from 'vitest'

describe('Electron bundle configuration', () => {
  it('leaves the Electron runtime external to main and preload bundles', async () => {
    const configModule: unknown = await import(new URL('../tsdown.config.ts', import.meta.url).href)

    expect(configModule).toEqual(expect.objectContaining({
      default: [
        expect.objectContaining({ deps: { neverBundle: ['electron'] } }),
        expect.objectContaining({ deps: { neverBundle: ['electron'] } }),
      ],
    }))
  })
})
