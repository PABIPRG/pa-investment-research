import { createHash } from 'node:crypto'
import { lstat, opendir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

type HashFile = (path: string) => Promise<string>
interface ReviewedTest {
  readonly path: string
  readonly sha256: string
  readonly optionalPackage?: string
}

const NODE_PAYLOADS: readonly ReviewedTest[] = [
  { path: 'node_modules/.pnpm/zod@4.4.3/node_modules/zod/src/v4/mini/tests/string.test.ts', sha256: 'efb9ef22f2179e700a2033edd4e1e03a6fe4f6b95fa4bc0bd29223065e1ec0a0' },
  { path: 'node_modules/.pnpm/zod@4.4.3/node_modules/zod/src/v4/classic/tests/string.test.ts', sha256: 'a69bdc042c58e8d940e6a5f09ed93646e697af04869a65cf45e9244e950cfb06' },
  { path: 'node_modules/.dsh-workspace-links/packages/session/session-telemetry/tests/redact.spec.ts', sha256: 'f3d6c306aa2b61b28db31ee066fb3abac6118ad2ef6c7cafe11d85ad802e795e' },
  { path: 'node_modules/.pnpm/@types+node@22.20.0/node_modules/@types/node/https.d.ts', sha256: 'a10f0e1854f3316d7ee437b79649e5a6ae3ae14ffe6322b02d4987071a95362e' },
  { path: 'node_modules/.pnpm/@aws-sdk+nested-clients@3.997.20/node_modules/@aws-sdk/nested-clients/dist-types/submodules/cognito-identity/auth/httpAuthSchemeProvider.d.ts', sha256: '6683aa39c4889a4d393506a2a532143139980b3596aa630983d7a86c74d53f0e' },
  { path: 'node_modules/.pnpm/@aws-sdk+nested-clients@3.997.20/node_modules/@aws-sdk/nested-clients/dist-types/submodules/signin/auth/httpAuthSchemeProvider.d.ts', sha256: '8bb6d0ae72770119eb01f888cb16a01ae8271fcddfab45467b0a9ee59318491d' },
  { path: 'node_modules/.pnpm/@aws-sdk+nested-clients@3.997.20/node_modules/@aws-sdk/nested-clients/dist-types/submodules/sso/auth/httpAuthSchemeProvider.d.ts', sha256: 'fb3db2574c90844888ac36a986a0218f56dcbec908c5db7fb3615bfd633fd6ba' },
  { path: 'node_modules/.pnpm/@aws-sdk+nested-clients@3.997.20/node_modules/@aws-sdk/nested-clients/dist-types/submodules/sso-oidc/auth/httpAuthSchemeProvider.d.ts', sha256: '2207a64465b21d1dac5620bc74fcb5d00756221866f9de3cdda133c243daba10' },
  { path: 'node_modules/.pnpm/@aws-sdk+nested-clients@3.997.20/node_modules/@aws-sdk/nested-clients/dist-types/submodules/sso-oidc/commands/CreateTokenCommand.d.ts', sha256: '3ad424e44a64663b5e74e2a9184cabffbae4b267dfc10b64b45408a3558d3e4c' },
  { path: 'node_modules/.pnpm/@aws-sdk+nested-clients@3.997.20/node_modules/@aws-sdk/nested-clients/dist-types/submodules/sts/auth/httpAuthSchemeProvider.d.ts', sha256: '7ff06ab6c7ce16eb4be74ebb36e59027cdec5aff4e687a739101ed01eb5781b8' },
]
const NODE_MODEL_MANIFEST_SHA256 = 'c2d89b03ccb2c095c59ead0437592b21e9676d049ad8e92ea90a466adf10b24d'
// Official pinned wheel contents, independently checksum-verified; sources are recorded in the PAB-29 audit.
const PYTHON_PAYLOADS: readonly ReviewedTest[] = [
  { path: 'kubernetes/aio/config/kube_config_test.py', sha256: '2e98b92ea15cf277de5738ee1430ee29718940c547367680d533fe63a6b9ca48', optionalPackage: 'kubernetes' },
  { path: 'numpy/random/tests/test_generator_mt19937.py', sha256: '67b0fc3dc885a1a605fd70ad20d1f37e3a2f5991ea816995389d948ef3645a53', optionalPackage: 'numpy' },
  { path: 'pywebpush/tests/test_webpush.py', sha256: 'e0b6f8a8bb5e830d67a2337693b1f93558a48797c6881798a645c97357d2ac23', optionalPackage: 'pywebpush' },
  { path: 'websocket/tests/test_websocket.py', sha256: '3513609599e545922bc911b16107695064cf934022e37eb01e80353b0e580b99', optionalPackage: 'websocket' },
  { path: 'cryptography/hazmat/bindings/_rust/openssl/hpke.pyi', sha256: 'a7f8462e7e981fe11aac91755796d4b14b638a9be2100a5c4793b4b141c92ed7' },
]
const PYTHON_RUNTIME_PAYLOADS: readonly ReviewedTest[] = [
  { path: 'lib/python3.10/distutils/msvccompiler.py', sha256: '658b27520202e2d653d969096d39135325520807369c533d0d5288b887cf054d' },
]
const hashFile: HashFile = async path => createHash('sha256').update(await readFile(path)).digest('hex')

async function reviewedPaths(root: string, payloads: readonly ReviewedTest[], hash: HashFile): Promise<string[]> {
  const fail = (): never => { throw new Error('unreviewed container test payload') }
  const base = resolve(root)
  const rootInfo = await lstat(base).catch(fail)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) fail()
  const verified: string[] = []
  for (const payload of payloads) {
    const segments = payload.path.split('/')
    let path = base
    let absent = false
    for (const [index, segment] of segments.entries()) {
      path = join(path, segment)
      const info = await lstat(path).catch((error: unknown) => {
        if (index === 0 && segment === payload.optionalPackage
          && error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
        return fail()
      })
      if (info === undefined) { absent = true; break }
      if (info.isSymbolicLink() || (index < segments.length - 1 ? !info.isDirectory() : !info.isFile())) fail()
    }
    if (absent) continue
    if (await hash(path) !== payload.sha256) fail()
    verified.push(path)
  }
  return verified
}

async function prune(root: string, payloads: readonly ReviewedTest[], hash: HashFile): Promise<void> {
  const verified = await reviewedPaths(root, payloads, hash)
  // Validate the entire set before changing staging. Never delete an unreviewed sibling or directory.
  for (const path of verified) await rm(path)
}

async function findReviewedFile(root: string, name: string, sha256: string, hash: HashFile): Promise<string> {
  const base = resolve(root)
  const baseInfo = await lstat(base).catch(() => undefined)
  if (!baseInfo?.isDirectory() || baseInfo.isSymbolicLink()) throw new Error('unreviewed container test payload')
  const matches: string[] = []
  const pending = [base]
  while (pending.length > 0) {
    const directory = pending.pop()
    if (directory === undefined) break
    for await (const entry of await opendir(directory)) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) pending.push(path)
      else if (entry.isFile() && entry.name === name && await hash(path) === sha256) matches.push(path)
    }
  }
  const [match] = matches
  if (matches.length !== 1 || match === undefined) throw new Error('unreviewed container test payload')
  return match
}

/** Strip checksum-reviewed inert files and shrink a runtime manifest to the only consumed field. */
export async function sanitizeContainerNodePayloads(root: string, hash: HashFile = hashFile): Promise<void> {
  const manifestPath = await findReviewedFile(root, '.manifest.json', NODE_MODEL_MANIFEST_SHA256, hash)
  let manifest: unknown
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  } catch {
    throw new Error('unreviewed container test payload')
  }
  if (typeof manifest !== 'object' || manifest === null || !('generatedAt' in manifest)
    || typeof manifest.generatedAt !== 'string' || !Number.isFinite(Date.parse(manifest.generatedAt))) {
    throw new Error('unreviewed container test payload')
  }
  const verified = await reviewedPaths(root, NODE_PAYLOADS, hash)
  for (const path of verified) await rm(path)
  await writeFile(manifestPath, `${JSON.stringify({ generatedAt: manifest.generatedAt })}\n`)
}

/** Strip checksum-reviewed Linux dependency tests and type-only files before collection. */
export async function pruneContainerPythonPayloads(root: string, hash: HashFile = hashFile): Promise<void> {
  await prune(root, PYTHON_PAYLOADS, hash)
}

/** Strip checksum-reviewed Windows-only stdlib payloads from the Linux runtime. */
export async function pruneContainerPythonRuntime(root: string, hash: HashFile = hashFile): Promise<void> {
  await prune(root, PYTHON_RUNTIME_PAYLOADS, hash)
}
