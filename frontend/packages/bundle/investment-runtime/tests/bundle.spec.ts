import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('..', import.meta.url))
const loaderSchema = yaml.DEFAULT_SCHEMA.extend([
  new yaml.Type('tag:yaml.org,2002:js', {
    kind: 'scalar',
    construct: expression => expression,
  }),
])

describe('investment runtime bundle', () => {
  it('publishes the Client facade immediately after its dependency-backed Host Runtime row', () => {
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      name?: string
      dependencies?: Record<string, string>
      dsh?: { bundle?: { patch?: string } }
    }

    expect(manifest.name).toBe('@deepseek-ai/dsh-investment-runtime-bundle')
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(yaml.load(readFileSync(resolve(root, manifest.dsh!.bundle!.patch!), 'utf8'))).toEqual([
      {
        insert: [
          {
            id: 'investment-python-runtime',
            name: '@deepseek-ai/dsh-investment-python-runtime',
          },
          {
            id: 'client-investment-research-runtime',
            name: '@deepseek-ai/dsh-client-investment-research-runtime',
          },
        ],
      },
    ])
    expect(manifest.dependencies).toHaveProperty('@deepseek-ai/dsh-investment-python-runtime')
    expect(manifest.dependencies).toHaveProperty('@deepseek-ai/dsh-client-investment-research-runtime')
  })

  it('keeps the investment-only Client facade out of the ordinary web bundle', () => {
    const webPatch = yaml.load(
      readFileSync(resolve(root, '../web-app/cordis.patch.yml'), 'utf8'),
      { schema: loaderSchema },
    )

    expect(JSON.stringify(webPatch)).not.toContain('@deepseek-ai/dsh-client-investment-research-runtime')
  })
})
