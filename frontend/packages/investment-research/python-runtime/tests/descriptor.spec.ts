import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { verifyInvestmentRuntimeDescriptor } from '../src/descriptor.ts'

const roots: string[] = []

interface MutableDescriptor {
  schemaVersion: number
  python: { version: string; platform: string; arch: string; executable: string }
  sitePackages: string
  backends: Record<'trading-core' | 'market-watch' | 'industry-chain', { projectDir: string; module: string }>
  files: Array<{ path: string; sha256: string }>
  extra?: boolean
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

async function fixture(): Promise<{
  root: string
  descriptorPath: string
  descriptor: MutableDescriptor
}> {
  const root = await mkdtemp(join(tmpdir(), 'dsh bundled runtime '))
  roots.push(root)
  const files = {
    'backends/dsh-trading-core/adapter/app.py': 'trading',
    'backends/market-watch/market_watch/app.py': 'market',
    'backends/industry-chain/industry_chain/app.py': 'industry',
    'runtime/bin/python3': 'python',
    'site-packages/native.so': 'native',
  }
  for (const [relative, value] of Object.entries(files)) {
    const absolute = join(root, ...relative.split('/'))
    await mkdir(join(absolute, '..'), { recursive: true })
    await writeFile(absolute, value)
  }
  const descriptor: MutableDescriptor = {
    schemaVersion: 1,
    python: {
      version: '3.10.18',
      platform: process.platform,
      arch: process.arch,
      executable: 'runtime/bin/python3',
    },
    sitePackages: 'site-packages',
    backends: {
      'trading-core': { projectDir: 'backends/dsh-trading-core', module: 'adapter.app:app' },
      'market-watch': { projectDir: 'backends/market-watch', module: 'market_watch.app:app' },
      'industry-chain': { projectDir: 'backends/industry-chain', module: 'industry_chain.app:app' },
    },
    files: Object.entries(files).sort(([left], [right]) => left.localeCompare(right)).map(([path, value]) => ({
      path,
      sha256: sha256(value),
    })),
  }
  const descriptorPath = join(root, 'runtime.json')
  await writeFile(descriptorPath, JSON.stringify(descriptor))
  return { root, descriptorPath, descriptor }
}

describe('investment packaged Runtime descriptor', () => {
  it('accepts one closed matching descriptor and verifies every listed file', async () => {
    const { root, descriptorPath } = await fixture()
    const verified = verifyInvestmentRuntimeDescriptor(descriptorPath)

    expect(verified).toMatchObject({
      root,
      pythonExecutable: join(root, 'runtime', 'bin', 'python3'),
      sitePackages: join(root, 'site-packages'),
      projectDirs: {
        'trading-core': join(root, 'backends', 'dsh-trading-core'),
        'market-watch': join(root, 'backends', 'market-watch'),
        'industry-chain': join(root, 'backends', 'industry-chain'),
      },
    })
  })

  it.each([
    ['unknown schema', (value: MutableDescriptor) => { value.schemaVersion = 2 }],
    ['unknown field', (value: MutableDescriptor) => { value.extra = true }],
    ['wrong Python minor', (value: MutableDescriptor) => { value.python.version = '3.11.9' }],
    ['wrong platform', (value: MutableDescriptor) => { value.python.platform = process.platform === 'darwin' ? 'win32' : 'darwin' }],
    ['wrong architecture', (value: MutableDescriptor) => { value.python.arch = `${process.arch}-other` }],
    ['wrong module', (value: MutableDescriptor) => { value.backends['trading-core'].module = 'other.app:app' }],
    ['traversal', (value: MutableDescriptor) => { value.sitePackages = '../site-packages' }],
    ['backslash traversal', (value: MutableDescriptor) => { value.sitePackages = '..\\site-packages' }],
    ['absolute path', (value: MutableDescriptor) => { value.sitePackages = '/site-packages' }],
    ['unhashed executable', (value: MutableDescriptor) => { value.files = value.files.filter(entry => entry.path !== value.python.executable) }],
    ['duplicate file', (value: MutableDescriptor) => { value.files = [value.files[0]!, ...value.files] }],
  ])('rejects %s before returning any bundled path', async (_name, mutate) => {
    const { descriptorPath, descriptor } = await fixture()
    mutate(descriptor)
    await writeFile(descriptorPath, JSON.stringify(descriptor))

    expect(() => verifyInvestmentRuntimeDescriptor(descriptorPath)).toThrow(/invalid.*reinstall/i)
  })

  it('rejects a missing or hash-mismatched listed file', async () => {
    const { root, descriptorPath } = await fixture()
    await writeFile(join(root, 'runtime', 'bin', 'python3'), 'tampered')
    expect(() => verifyInvestmentRuntimeDescriptor(descriptorPath)).toThrow(/hash mismatch.*reinstall/i)

    await rm(join(root, 'runtime', 'bin', 'python3'))
    expect(() => verifyInvestmentRuntimeDescriptor(descriptorPath)).toThrow(/missing.*reinstall/i)
  })

  it('rejects an unlisted file instead of treating a partial digest list as complete', async () => {
    const { root, descriptorPath } = await fixture()
    await writeFile(join(root, 'site-packages', 'unlisted.py'), 'unexpected')
    expect(() => verifyInvestmentRuntimeDescriptor(descriptorPath)).toThrow(/incomplete file list.*reinstall/i)
  })
})
