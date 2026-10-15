import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { cp, lstat, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const inputs = [
  'Dockerfile', 'containers/investment-sidecar-cache.mjs',
  'frontend/package.json', 'frontend/pnpm-lock.yaml', 'frontend/pnpm-workspace.yaml', 'frontend/.npmrc',
  'frontend/patches', ':(glob)frontend/**/package.json',
  'frontend/scripts/build-investment-python-sidecar.ts',
  'frontend/scripts/investment-backend-package-policy.ts',
  'frontend/scripts/investment-container-test-payloads.ts',
  'frontend/scripts/install-lefthook.mjs',
  'frontend/packages/subprocess/subprocess-local/scripts/ensure-spawn-helper.mjs',
  'frontend/config/investment-python-runtime-lock.json', 'frontend/config/investment-python-requirements',
  'backend/dsh-trading-core', 'backend/market-watch', 'backend/industry-chain',
]

async function sha256(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

/** Hash tracked and non-ignored input files; frontend UI sources do not enter the key. */
export async function fingerprint(root) {
  const paths = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...inputs], {
    cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  }).split('\0').filter(Boolean)
  const hash = createHash('sha256').update('investment-linux-x64-sidecar-v1\0')
  for (const path of [...new Set(paths)].sort()) {
    const info = await lstat(join(root, path))
    if (!info.isFile()) throw new Error('sidecar input must be a regular file')
    hash.update(JSON.stringify([path, info.mode & 0o111, await sha256(join(root, path))]))
  }
  return hash.digest('hex')
}

async function inventory(root) {
  const files = []
  async function visit(prefix) {
    if (!(await lstat(join(root, prefix))).isDirectory()) throw new Error('invalid sidecar directory')
    for (const name of (await readdir(join(root, prefix))).sort()) {
      const path = prefix ? `${prefix}/${name}` : name
      const info = await lstat(join(root, path))
      if (info.isSymbolicLink()) throw new Error('sidecar cache contains a symlink')
      if (info.isDirectory()) await visit(path)
      else if (info.isFile()) files.push({ path, mode: info.mode & 0o7777, sha256: await sha256(join(root, path)) })
      else throw new Error('sidecar cache contains a special file')
    }
  }
  await visit('')
  return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
}

async function checkedInventory(root) {
  const files = await inventory(root)
  const descriptor = JSON.parse(await readFile(join(root, 'runtime.json'), 'utf8'))
  if (descriptor.schemaVersion !== 1 || descriptor.python?.platform !== 'linux' || descriptor.python?.arch !== 'x64') {
    throw new Error('cache is not a Linux x64 sidecar')
  }
  const executable = files.find(file => file.path === descriptor.python.executable)
  if (!executable || (executable.mode & 0o111) === 0) throw new Error('Python executable is missing or not executable')
  // Match the builder's descriptor convention; the cache inventory still hashes every runtime.json.
  const described = files.filter(file => file.path.split('/').at(-1) !== 'runtime.json')
    .map(({ path, sha256 }) => ({ path, sha256 }))
  if (JSON.stringify(descriptor.files) !== JSON.stringify(described)) throw new Error('sidecar descriptor mismatch')
  return files
}

/** Seal only a sidecar extracted from the image that has passed the workflow security scan. */
export async function seal(root, key) {
  if (!/^[a-f0-9]{64}$/u.test(key)) throw new Error('invalid sidecar input fingerprint')
  const files = await checkedInventory(join(root, 'sidecar'))
  await writeFile(join(root, 'metadata.json'), `${JSON.stringify({ version: 1, key, files })}\n`)
}

/** Validate an exact input key and every output byte and mode; the workflow owns cache provenance. */
export async function validate(root, key) {
  try {
    if (!/^[a-f0-9]{64}$/u.test(key)) return false
    if (!(await lstat(join(root, 'metadata.json'))).isFile()) return false
    const metadata = JSON.parse(await readFile(join(root, 'metadata.json'), 'utf8'))
    if (metadata.version !== 1 || metadata.key !== key) return false
    return JSON.stringify(metadata.files) === JSON.stringify(await checkedInventory(join(root, 'sidecar')))
  } catch {
    // Missing, partial, stale, or malformed caches must fall back to the locked builder.
    return false
  }
}

/** Copy a validated cache without its metadata; return false to request a normal sidecar build. */
export async function restore(root, key, output) {
  if (!await validate(root, key)) return false
  await rm(output, { recursive: true, force: true })
  await cp(join(root, 'sidecar'), output, { recursive: true, preserveTimestamps: true })
  return true
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [command, root, key, output] = process.argv.slice(2)
  if (command === 'key') console.log(await fingerprint(root))
  else if (command === 'seal') await seal(root, key)
  else if (command === 'validate') process.exitCode = await validate(root, key) ? 0 : 1
  else if (command === 'restore') {
    const hit = await restore(root, key, output)
    console.log(`Python sidecar cache: ${hit ? 'verified hit' : 'miss or invalid; rebuilding'}`)
    process.exitCode = hit ? 0 : 1
  } else throw new Error('expected key, seal, validate, or restore')
}
