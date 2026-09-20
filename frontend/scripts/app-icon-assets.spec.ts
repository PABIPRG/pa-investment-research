import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { buildAppIconAssets } from './generate-app-icon-assets.ts'

it('reproduces every committed non-Apple application icon derivative', async () => {
  const generated = await buildAppIconAssets()
  expect(generated.size).toBe(10)
  for (const [path, expected] of generated) {
    await expect(readFile(path)).resolves.toEqual(expected)
  }
})
