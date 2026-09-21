import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { pruneContainerNodeTests, pruneContainerPythonTests } from './investment-container-test-payloads.ts'

const roots: string[] = []
const nodeFiles = [
  ['node_modules/.pnpm/zod@4.4.3/node_modules/zod/src/v4/mini/tests/string.test.ts', 'efb9ef22f2179e700a2033edd4e1e03a6fe4f6b95fa4bc0bd29223065e1ec0a0'],
  ['node_modules/.pnpm/zod@4.4.3/node_modules/zod/src/v4/classic/tests/string.test.ts', 'a69bdc042c58e8d940e6a5f09ed93646e697af04869a65cf45e9244e950cfb06'],
  ['node_modules/.dsh-workspace-links/packages/session/session-telemetry/tests/redact.spec.ts', 'f3d6c306aa2b61b28db31ee066fb3abac6118ad2ef6c7cafe11d85ad802e795e'],
] as const
const pythonFiles = [
  ['kubernetes/aio/config/kube_config_test.py', '2e98b92ea15cf277de5738ee1430ee29718940c547367680d533fe63a6b9ca48'],
  ['numpy/random/tests/test_generator_mt19937.py', '67b0fc3dc885a1a605fd70ad20d1f37e3a2f5991ea816995389d948ef3645a53'],
] as const
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture(files: typeof nodeFiles | typeof pythonFiles) {
  const root = await mkdtemp(join(tmpdir(), 'container-test-payload-'))
  roots.push(root)
  for (const [path] of files) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), 'inert fixture')
  }
  await writeFile(join(root, 'runtime.py'), 'runtime stays unchanged')
  await writeFile(join(root, 'LICENSE'), 'license stays unchanged')
  return root
}

it('removes only reviewed tests, keeping runtime, licenses and other files', async () => {
  for (const [files, prune] of [[nodeFiles, pruneContainerNodeTests], [pythonFiles, pruneContainerPythonTests]] as const) {
    const root = await fixture(files)
    const allowed = new Map(files.map(([path, hash]) => [join(root, path), hash]))
    await prune(root, async path => allowed.get(path) ?? 'unreviewed')
    for (const [path] of files) await expect(readFile(join(root, path))).rejects.toThrow(/ENOENT/u)
    expect(await readFile(join(root, 'runtime.py'), 'utf8')).toBe('runtime stays unchanged')
    expect(await readFile(join(root, 'LICENSE'), 'utf8')).toBe('license stays unchanged')
  }
})

it('checks every hash before deleting any file, rejecting drift without exposing paths', async () => {
  const root = await fixture(nodeFiles)
  await expect(pruneContainerNodeTests(root, async path => path.endsWith('string.test.ts') ? nodeFiles[0][1] : 'changed'))
    .rejects.toThrow('unreviewed container test payload')
  for (const [path] of nodeFiles) expect(await readFile(join(root, path), 'utf8')).toBe('inert fixture')
  await expect(pruneContainerNodeTests(root)).rejects.toThrow('unreviewed container test payload')
})

it('rejects symlink parents and never follows them into another package', async () => {
  const root = await fixture(pythonFiles)
  await rm(join(root, 'kubernetes/aio'), { recursive: true })
  await symlink(join(root, 'numpy'), join(root, 'kubernetes/aio'), 'junction')
  await expect(pruneContainerPythonTests(root)).rejects.toThrow('unreviewed container test payload')
  expect(await readFile(join(root, pythonFiles[1][0]), 'utf8')).toBe('inert fixture')
})

it('rejects missing tests in an installed package while allowing an absent optional Python package', async () => {
  const root = await fixture(pythonFiles)
  await rm(join(root, pythonFiles[0][0]))
  await expect(pruneContainerPythonTests(root)).rejects.toThrow('unreviewed container test payload')
  await rm(join(root, 'kubernetes'), { recursive: true })
  await rm(join(root, 'numpy'), { recursive: true })
  await expect(pruneContainerPythonTests(root)).resolves.toBeUndefined()
})
