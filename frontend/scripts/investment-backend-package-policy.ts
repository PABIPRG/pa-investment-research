/** Deterministic backend allowlist and precisely reviewed dependency test pruning. */
import { createHash } from 'node:crypto'
import { lstat, readdir, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const MODULES: Readonly<Record<string, readonly string[]>> = {
  'dsh-trading-core': ['adapter', 'tradingagents'],
  'market-watch': ['market_watch'],
  'industry-chain': ['industry_chain'],
}
const EXCLUDED = new Set(['tests', 'docs', '__pycache__', '.git', 'env', 'node_modules', 'logs', 'backups', 'data', 'cache', 'data_cache', 'results', 'eval_results'])

const PY_VAPID_TEST_HASHES: Readonly<Record<string, string>> = {
  'test_vapid.py': '460d5b05d85452117db2046ec1c0dc25dd3018b4df7fb1e6c8e0627c6b413897',
  '.test_vapid.py.swp': '178ec9b7bce4f39fcfbf8eb04207abaa8ec3b891eb1def7d75dd81e93c5c092d',
}

/** Remove only audited py-vapid 1.9.4 test payloads before runtime.json and any image COPY.
 * @param sitePackages Installed dependency root in the private staging directory.
 * @param hashFile File hashing implementation, injectable for inert test fixtures.
 */
export async function prunePythonDependencyTests(
  sitePackages: string,
  hashFile: (path: string) => Promise<string> = async path => createHash('sha256').update(await readFile(path)).digest('hex'),
): Promise<void> {
  const entries = await readdir(sitePackages)
  if (!entries.includes('py_vapid')) return
  const fail = (): never => { throw new Error('dependency test cleanup: unreviewed py-vapid payload') }
  for (const path of ['py_vapid', 'py_vapid/tests', 'py_vapid-1.9.4.dist-info']) {
    const info = await lstat(join(sitePackages, path)).catch(fail)
    if (!info.isDirectory() || info.isSymbolicLink()) fail()
  }
  const metadataPath = join(sitePackages, 'py_vapid-1.9.4.dist-info/METADATA')
  const metadataInfo = await lstat(metadataPath).catch(fail)
  if (!metadataInfo.isFile() || metadataInfo.isSymbolicLink()) fail()
  const metadata = await readFile(metadataPath, 'utf8')
  if (!/^Name: py[-_]vapid\r?$/mu.test(metadata) || !/^Version: 1\.9\.4\r?$/mu.test(metadata)) fail()
  const testRoot = join(sitePackages, 'py_vapid/tests')
  const files = await readdir(testRoot)
  if (files.length !== Object.keys(PY_VAPID_TEST_HASHES).length) fail()
  for (const name of files) {
    const path = join(testRoot, name)
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || PY_VAPID_TEST_HASHES[name] === undefined) fail()
    if (await hashFile(path) !== PY_VAPID_TEST_HASHES[name]) fail()
  }
  await rm(testRoot, { recursive: true })
}

/** Paths are normalized at ingestion, independently of the platform running the gate. */
export function backendPathAllowed(backend: string, path: string, directory: boolean): boolean {
  const modules = MODULES[backend]
  if (modules === undefined) return false
  const segments = path.replaceAll('\\', '/').split('/')
  if (segments.some(segment => segment.startsWith('.') || EXCLUDED.has(segment.toLowerCase()))) return false
  if (!directory && segments.length === 1 && /^(?:LICENSE|NOTICE)(?:\.txt)?$/u.test(path)) return true
  if (!modules.includes(segments[0] ?? '')) return false
  return directory || (segments.length > 1 && /^[A-Za-z_][A-Za-z_0-9]*\.py$/u.test(segments.at(-1) ?? ''))
}

const CONTENT_RULES: readonly [string, RegExp][] = [
  ['personal-home', /(?:\/Users\/|\/home\/|[A-Za-z]:[\\/]+Users[\\/]+)[^\s"'<>/\\]+(?:[\\/]|(?=["'\s]|$))/u],
  ['private-key', /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/u],
  ['credential-token', /\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{30,})\b/u],
  ['credential-literal', /(?:["']?(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)["']?\s*[:=]\s*)["'][^"'\r\n]+["']/iu],
]

/** Scan actual files, not just runtime.json: extra files must also fail before distribution. */
export async function scanPackagedBackends(sidecarRoot: string): Promise<void> {
  const root = join(resolve(sidecarRoot), 'backends')
  for (const backend of await readdir(root)) {
    if (MODULES[backend] === undefined) throw new Error('backend privacy check: unexpected-backend')
    const base = join(root, backend)
    if (!(await lstat(base)).isDirectory()) throw new Error(`backend privacy check: invalid-directory (${backend})`)
    const visit = async (directory: string, prefix: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = prefix + entry.name
        // Never include matched contents or absolute local paths in diagnostics.
        const fail = (rule: string): never => { throw new Error(`backend privacy check: ${rule} (${backend}/${path})`) }
        if (entry.isSymbolicLink()) fail('symbolic-link')
        if (!backendPathAllowed(backend, path, entry.isDirectory())) fail('unexpected-file')
        const absolute = join(directory, entry.name)
        if (entry.isDirectory()) await visit(absolute, path + '/')
        else if (entry.isFile()) {
          const contents = await readFile(absolute, 'utf8')
          for (const [rule, pattern] of CONTENT_RULES) if (pattern.test(contents)) fail(rule)
        } else fail('unsupported-entry')
      }
    }
    await visit(base, '')
  }
  for (const [backend, modules] of Object.entries(MODULES)) {
    const entry = join(root, backend, modules[0]!, 'app.py')
    if (!(await lstat(entry)).isFile()) throw new Error(`backend privacy check: missing-entry (${backend})`)
  }
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== '--root') throw new Error('usage: investment-backend-package-policy --root <sidecar>')
    await scanPackagedBackends(process.argv[3]!)
    process.stdout.write('Backend payload privacy check passed.\n')
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Backend payload privacy check failed'}\n`)
    process.exitCode = 1
  }
}
