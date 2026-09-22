import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  pruneContainerPythonPayloads,
  pruneContainerPythonRuntime,
  sanitizeContainerNodePayloads,
} from './investment-container-test-payloads.ts'

const roots: string[] = []
const nodeFiles = [
  ['node_modules/.pnpm/zod@4.4.3/node_modules/zod/src/v4/mini/tests/string.test.ts', 'efb9ef22f2179e700a2033edd4e1e03a6fe4f6b95fa4bc0bd29223065e1ec0a0'],
  ['node_modules/.pnpm/zod@4.4.3/node_modules/zod/src/v4/classic/tests/string.test.ts', 'a69bdc042c58e8d940e6a5f09ed93646e697af04869a65cf45e9244e950cfb06'],
  ['node_modules/.dsh-workspace-links/packages/session/session-telemetry/tests/redact.spec.ts', 'f3d6c306aa2b61b28db31ee066fb3abac6118ad2ef6c7cafe11d85ad802e795e'],
  ['node_modules/.pnpm/@types+node@22.20.0/node_modules/@types/node/https.d.ts', 'a10f0e1854f3316d7ee437b79649e5a6ae3ae14ffe6322b02d4987071a95362e'],
  ['node_modules/.pnpm/@aws-sdk+nested-clients@3.997.20/node_modules/@aws-sdk/nested-clients/dist-types/submodules/cognito-identity/auth/httpAuthSchemeProvider.d.ts', '6683aa39c4889a4d393506a2a532143139980b3596aa630983d7a86c74d53f0e'],
  ['node_modules/.pnpm/@aws-sdk+nested-clients@3.997.20/node_modules/@aws-sdk/nested-clients/dist-types/submodules/signin/auth/httpAuthSchemeProvider.d.ts', '8bb6d0ae72770119eb01f888cb16a01ae8271fcddfab45467b0a9ee59318491d'],
  ['node_modules/.pnpm/@aws-sdk+nested-clients@3.997.20/node_modules/@aws-sdk/nested-clients/dist-types/submodules/sso/auth/httpAuthSchemeProvider.d.ts', 'fb3db2574c90844888ac36a986a0218f56dcbec908c5db7fb3615bfd633fd6ba'],
  ['node_modules/.pnpm/@aws-sdk+nested-clients@3.997.20/node_modules/@aws-sdk/nested-clients/dist-types/submodules/sso-oidc/auth/httpAuthSchemeProvider.d.ts', '2207a64465b21d1dac5620bc74fcb5d00756221866f9de3cdda133c243daba10'],
  ['node_modules/.pnpm/@aws-sdk+nested-clients@3.997.20/node_modules/@aws-sdk/nested-clients/dist-types/submodules/sso-oidc/commands/CreateTokenCommand.d.ts', '3ad424e44a64663b5e74e2a9184cabffbae4b267dfc10b64b45408a3558d3e4c'],
  ['node_modules/.pnpm/@aws-sdk+nested-clients@3.997.20/node_modules/@aws-sdk/nested-clients/dist-types/submodules/sts/auth/httpAuthSchemeProvider.d.ts', '7ff06ab6c7ce16eb4be74ebb36e59027cdec5aff4e687a739101ed01eb5781b8'],
] as const
const nodeManifest = [
  'node_modules/.pnpm/@earendil-works+pi-ai@0.82.1_@modelcontextprotocol+sdk@1.29.0_zod@4.4.3__ws@8.21.0_zod@4.4.3/node_modules/@earendil-works/pi-ai/dist/providers/data/.manifest.json',
  'c2d89b03ccb2c095c59ead0437592b21e9676d049ad8e92ea90a466adf10b24d',
] as const
const pythonFiles = [
  ['kubernetes/aio/config/kube_config_test.py', '2e98b92ea15cf277de5738ee1430ee29718940c547367680d533fe63a6b9ca48'],
  ['numpy/random/tests/test_generator_mt19937.py', '67b0fc3dc885a1a605fd70ad20d1f37e3a2f5991ea816995389d948ef3645a53'],
  ['pywebpush/tests/test_webpush.py', 'e0b6f8a8bb5e830d67a2337693b1f93558a48797c6881798a645c97357d2ac23'],
  ['websocket/tests/test_websocket.py', '3513609599e545922bc911b16107695064cf934022e37eb01e80353b0e580b99'],
  ['cryptography/hazmat/bindings/_rust/openssl/hpke.pyi', 'a7f8462e7e981fe11aac91755796d4b14b638a9be2100a5c4793b4b141c92ed7'],
] as const
const pythonRuntimeFiles = [
  ['lib/python3.10/distutils/msvccompiler.py', '658b27520202e2d653d969096d39135325520807369c533d0d5288b887cf054d'],
] as const
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture(files: readonly (readonly [string, string])[]) {
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

it('removes reviewed Node payloads and retains only the runtime manifest timestamp', async () => {
  const root = await fixture(nodeFiles)
  await mkdir(dirname(join(root, nodeManifest[0])), { recursive: true })
  await writeFile(join(root, nodeManifest[0]), JSON.stringify({
    schemaVersion: 1,
    generatedAt: '2026-09-21T00:00:00.000Z',
    structureHash: 'fixture',
    files: { 'provider.json': 'fixture' },
  }))
  const allowed = new Map([...nodeFiles, nodeManifest].map(([path, hash]) => [join(root, path), hash]))

  await sanitizeContainerNodePayloads(root, async path => allowed.get(path) ?? 'unreviewed')

  for (const [path] of nodeFiles) await expect(readFile(join(root, path))).rejects.toThrow(/ENOENT/u)
  expect(await readFile(join(root, nodeManifest[0]), 'utf8'))
    .toBe('{"generatedAt":"2026-09-21T00:00:00.000Z"}\n')
  expect(await readFile(join(root, 'runtime.py'), 'utf8')).toBe('runtime stays unchanged')
  expect(await readFile(join(root, 'LICENSE'), 'utf8')).toBe('license stays unchanged')
})

it('removes only reviewed Python payloads, keeping runtime, licenses and other files', async () => {
  for (const [files, prune] of [
    [pythonFiles, pruneContainerPythonPayloads],
    [pythonRuntimeFiles, pruneContainerPythonRuntime],
  ] as const) {
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
  await mkdir(dirname(join(root, nodeManifest[0])), { recursive: true })
  await writeFile(join(root, nodeManifest[0]), '{"generatedAt":"2026-09-21T00:00:00.000Z"}')
  await expect(sanitizeContainerNodePayloads(root, async path => path.endsWith('string.test.ts') ? nodeFiles[0][1] : 'changed'))
    .rejects.toThrow('unreviewed container test payload')
  for (const [path] of nodeFiles) expect(await readFile(join(root, path), 'utf8')).toBe('inert fixture')
  await expect(sanitizeContainerNodePayloads(root)).rejects.toThrow('unreviewed container test payload')
})

it('rejects symlink parents and never follows them into another package', async () => {
  const root = await fixture(pythonFiles)
  await rm(join(root, 'kubernetes/aio'), { recursive: true })
  await symlink(join(root, 'numpy'), join(root, 'kubernetes/aio'), 'junction')
  await expect(pruneContainerPythonPayloads(root)).rejects.toThrow('unreviewed container test payload')
  expect(await readFile(join(root, pythonFiles[1][0]), 'utf8')).toBe('inert fixture')
})

it('rejects missing tests in an installed package while allowing an absent optional Python package', async () => {
  const root = await fixture(pythonFiles)
  await rm(join(root, pythonFiles[0][0]))
  await expect(pruneContainerPythonPayloads(root)).rejects.toThrow('unreviewed container test payload')
  for (const [path] of pythonFiles.slice(0, 4)) await rm(join(root, path.split('/')[0]!), { recursive: true })
  await expect(pruneContainerPythonPayloads(root, async path => path.endsWith('hpke.pyi') ? pythonFiles[4][1] : 'changed'))
    .resolves.toBeUndefined()
  await expect(readFile(join(root, pythonFiles[4][0]))).rejects.toThrow(/ENOENT/u)
})
