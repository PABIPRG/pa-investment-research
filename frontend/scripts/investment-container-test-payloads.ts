import { createHash } from 'node:crypto'
import { lstat, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'

type HashFile = (path: string) => Promise<string>
interface ReviewedTest {
  readonly path: string
  readonly sha256: string
  readonly optionalPackage?: string
}

const NODE_TESTS: readonly ReviewedTest[] = [
  { path: 'node_modules/.pnpm/zod@4.4.3/node_modules/zod/src/v4/mini/tests/string.test.ts', sha256: 'efb9ef22f2179e700a2033edd4e1e03a6fe4f6b95fa4bc0bd29223065e1ec0a0' },
  { path: 'node_modules/.pnpm/zod@4.4.3/node_modules/zod/src/v4/classic/tests/string.test.ts', sha256: 'a69bdc042c58e8d940e6a5f09ed93646e697af04869a65cf45e9244e950cfb06' },
  { path: 'node_modules/.dsh-workspace-links/packages/session/session-telemetry/tests/redact.spec.ts', sha256: 'f3d6c306aa2b61b28db31ee066fb3abac6118ad2ef6c7cafe11d85ad802e795e' },
]
// Official kubernetes 36.0.3 and numpy 2.2.6 wheel contents, independently checksum-verified.
const PYTHON_TESTS: readonly ReviewedTest[] = [
  { path: 'kubernetes/aio/config/kube_config_test.py', sha256: '2e98b92ea15cf277de5738ee1430ee29718940c547367680d533fe63a6b9ca48', optionalPackage: 'kubernetes' },
  { path: 'numpy/random/tests/test_generator_mt19937.py', sha256: '67b0fc3dc885a1a605fd70ad20d1f37e3a2f5991ea816995389d948ef3645a53', optionalPackage: 'numpy' },
]
const hashFile: HashFile = async path => createHash('sha256').update(await readFile(path)).digest('hex')

async function prune(root: string, tests: readonly ReviewedTest[], hash: HashFile): Promise<void> {
  const fail = (): never => { throw new Error('unreviewed container test payload') }
  const base = resolve(root)
  const rootInfo = await lstat(base).catch(fail)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) fail()
  const verified: string[] = []
  for (const test of tests) {
    const segments = test.path.split('/')
    let path = base
    let absent = false
    for (const [index, segment] of segments.entries()) {
      path = join(path, segment)
      const info = await lstat(path).catch((error: unknown) => {
        if (index === 0 && segment === test.optionalPackage
          && error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
        return fail()
      })
      if (info === undefined) { absent = true; break }
      if (info.isSymbolicLink() || (index < segments.length - 1 ? !info.isDirectory() : !info.isFile())) fail()
    }
    if (absent) continue
    if (await hash(path) !== test.sha256) fail()
    verified.push(path)
  }
  // Validate the entire set before changing staging. Never delete an unreviewed sibling or directory.
  for (const path of verified) await rm(path)
}

/** Strip three checksum-reviewed tests after workspace links are materialized, before image COPY. */
export async function pruneContainerNodeTests(root: string, hash: HashFile = hashFile): Promise<void> {
  await prune(root, NODE_TESTS, hash)
}

/** Strip two checksum-reviewed Linux dependency tests before the sidecar file manifest is collected. */
export async function pruneContainerPythonTests(root: string, hash: HashFile = hashFile): Promise<void> {
  await prune(root, PYTHON_TESTS, hash)
}
