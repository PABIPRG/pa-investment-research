import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, globSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// Only platform-independent compiler output crosses runners. Native dependencies,
// Python payloads and signing remain owned by each target's packaging job.
const outputGlobs = ['vendor/*/lib', 'packages/*/*/lib', 'apps/cli/lib', 'apps/electron/lib',
  'apps/web/dist', 'apps/electron/renderer', 'native/landlock-run/packages/entry/lib']
const outputRootPatterns = [
  /^(vendor\/[^/]+\/lib)\//,
  /^(packages\/[^/]+\/[^/]+\/lib)\//,
  /^(apps\/(?:cli|electron)\/lib|apps\/web\/dist|apps\/electron\/renderer)\//,
  /^(native\/landlock-run\/packages\/entry\/lib)\//,
]
const requiredEntries = ['apps/cli/lib/bin.js', 'apps/electron/lib/index.js', 'apps/electron/lib/main.js',
  'apps/electron/lib/preload.cjs', 'apps/web/dist/index.html', 'apps/electron/renderer/index.html',
  'native/landlock-run/packages/entry/lib/index.js', 'packages/client/ui-theme/lib/styles/base.css']
interface BuildFile { path: string; sha256: string; mode: number }
interface BuildManifest { version: 1; revision: string; files: BuildFile[] }

function assertRevision(revision: string) {
  if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error('Expected a full checkout revision')
}
function outputRoot(path: string): string {
  if (path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..'
    || part === 'node_modules' || /[:\x00-\x1f]/.test(part) || /[. ]$/.test(part))) {
    throw new Error(`Invalid output path: ${path}`)
  }
  const root = outputRootPatterns.map(pattern => pattern.exec(path)?.[1]).find(Boolean)
  if (!root || !/\.(?:[cm]?js|ts|map|css|html|webmanifest|svg|png|ico|ttf|woff2?)$/.test(path)) {
    throw new Error(`Unsupported portable output: ${path}`)
  }
  return root
}
function assertNoLinks(root: string, path = '') {
  let current = resolve(root)
  for (const part of ['', ...path.split('/').filter(Boolean)]) {
    current = resolve(current, part)
    if (lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`Symbolic link: ${current}`)
  }
}
function walk(root: string, prefix = ''): string[] {
  assertNoLinks(root, prefix)
  return readdirSync(resolve(root, prefix), { withFileTypes: true }).flatMap((entry) => {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isSymbolicLink()) throw new Error(`Symbolic link: ${path}`)
    if (entry.isDirectory()) return walk(root, path)
    if (!entry.isFile()) throw new Error(`Non-regular output: ${path}`)
    return [path]
  }).sort()
}
function digest(root: string, path: string): string {
  const bytes = readFileSync(resolve(root, path))
  const magic = bytes.subarray(0, 4).toString('hex')
  if (bytes.subarray(0, 2).toString() === 'MZ'
    || ['7f454c46', 'feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca'].includes(magic)) {
    throw new Error(`Native executable in portable output: ${path}`)
  }
  return createHash('sha256').update(bytes).digest('hex')
}
function checkEntries(files: BuildFile[]) {
  const paths = new Set<string>()
  for (const file of files) {
    outputRoot(file.path)
    const key = file.path.toLowerCase()
    if (paths.has(key)) throw new Error(`Duplicate output: ${file.path}`)
    paths.add(key)
  }
  for (const entry of requiredEntries) {
    if (!files.some(file => file.path === entry)) throw new Error(`Missing runtime entry: ${entry}`)
  }
}
function readManifest(artifact: string, revision: string): BuildManifest {
  assertRevision(revision)
  assertNoLinks(artifact, 'manifest.json')
  const data: unknown = JSON.parse(readFileSync(resolve(artifact, 'manifest.json'), 'utf8'))
  if (!data || typeof data !== 'object') throw new Error('Invalid build manifest')
  const manifest = data as Record<string, unknown>
  if (manifest.version !== 1 || manifest.revision !== revision || !Array.isArray(manifest.files)) {
    throw new Error('Build manifest revision or format mismatch')
  }
  const files = (manifest.files as unknown[]).map((item): BuildFile => {
    if (!item || typeof item !== 'object') throw new Error('Invalid build file metadata')
    const file = item as Record<string, unknown>
    if (typeof file.path !== 'string' || typeof file.sha256 !== 'string'
      || !/^[0-9a-f]{64}$/.test(file.sha256) || (file.mode !== 0o644 && file.mode !== 0o755)) {
      throw new Error('Invalid build file metadata')
    }
    return { path: file.path, sha256: file.sha256, mode: file.mode }
  })
  checkEntries(files)
  return { version: 1, revision, files }
}

export function captureDesktopBuild(frontend: string, artifact: string, revision: string): void {
  assertRevision(revision)
  if (existsSync(artifact)) throw new Error('Build artifact destination must be new')
  const paths = globSync(outputGlobs, { cwd: frontend }).flatMap(root => walk(frontend, root.replaceAll('\\', '/')))
    .filter(path => !path.endsWith('.tsbuildinfo')).sort()
  const files = paths.map((path) => {
    outputRoot(path)
    return { path, sha256: digest(frontend, path), mode: (lstatSync(resolve(frontend, path)).mode & 0o111) ? 0o755 : 0o644 }
  })
  checkEntries(files)
  for (const file of files) {
    const target = resolve(artifact, 'payload', file.path)
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(resolve(frontend, file.path), target)
  }
  writeFileSync(resolve(artifact, 'manifest.json'), JSON.stringify({ version: 1, revision, files } satisfies BuildManifest))
  console.info(`Portable desktop build: captured ${files.length} files for ${revision}`)
}

export function restoreDesktopBuild(frontend: string, artifact: string, revision: string): void {
  const manifest = readManifest(artifact, revision)
  const payload = resolve(artifact, 'payload')
  const paths = walk(artifact)
  const expected = ['manifest.json', ...manifest.files.map(file => `payload/${file.path}`)].sort()
  if (JSON.stringify(paths) !== JSON.stringify(expected)) throw new Error('Build artifact file inventory mismatch')
  // Validate the complete transfer and destination before replacing any output.
  for (const file of manifest.files) {
    if (digest(payload, file.path) !== file.sha256) throw new Error(`Build hash mismatch: ${file.path}`)
    assertNoLinks(frontend, file.path)
  }
  const roots = new Set(manifest.files.map(file => outputRoot(file.path)))
  for (const root of roots) rmSync(resolve(frontend, root), { recursive: true, force: true })
  for (const file of manifest.files) {
    const target = resolve(frontend, file.path)
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(resolve(payload, file.path), target)
    chmodSync(target, file.mode)
  }
  console.info(`Portable desktop build: verified restore of ${manifest.files.length} files for ${revision}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, artifact, revision] = process.argv.slice(2)
  if (!artifact || !revision || !['capture', 'restore'].includes(command ?? '')) {
    throw new Error('Usage: investment-desktop-build-artifact.ts <capture|restore> <artifact-directory> <checkout-sha>')
  }
  const operation = command === 'capture' ? captureDesktopBuild : restoreDesktopBuild
  operation(process.cwd(), resolve(artifact), revision)
}
