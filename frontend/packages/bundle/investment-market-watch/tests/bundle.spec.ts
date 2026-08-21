import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('..', import.meta.url))

describe('investment market watch bundle', () => {
  it('publishes a patch containing only its dependency-backed business row', () => {
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      name?: string
      dependencies?: Record<string, string>
      dsh?: { bundle?: { patch?: string } }
    }

    expect(manifest.name).toBe('@deepseek-ai/dsh-investment-market-watch-bundle')
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(yaml.load(readFileSync(resolve(root, manifest.dsh!.bundle!.patch!), 'utf8'))).toEqual([
      {
        insert: [
          {
            id: 'investment-market-watch',
            name: '@deepseek-ai/dsh-investment-market-watch',
          },
        ],
      },
    ])
    expect(manifest.dependencies).toHaveProperty('@deepseek-ai/dsh-investment-market-watch')
    expect(manifest.dependencies).toHaveProperty('@deepseek-ai/dsh-investment-python-runtime')
  })
})
