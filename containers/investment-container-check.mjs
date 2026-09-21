import { lstat, opendir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const LOCKS = Object.freeze({
  application: 'investment-research/application.lock',
  container: 'investment-research/.container-instance.lock',
})

function isMissing(error) {
  return error instanceof Error && error.code === 'ENOENT'
}

async function exists(path) {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (isMissing(error)) return false
    throw error
  }
}

/** Reject links in copied runtime trees without relying on a shell or following a link target. */
export async function assertNoSymlinks(roots) {
  const pending = roots.map(root => resolve(root))
  while (pending.length > 0) {
    const path = pending.pop()
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink()) throw new Error('runtime tree contains a symbolic link')
    if (!metadata.isDirectory()) continue
    for await (const entry of await opendir(path)) pending.push(join(path, entry.name))
  }
}

export async function lockState(root = '/state') {
  return Object.freeze({
    application: await exists(join(root, LOCKS.application)),
    container: await exists(join(root, LOCKS.container)),
  })
}

async function run(mode) {
  if (mode === 'boundary') {
    await assertNoSymlinks(['/opt/dsh', '/opt/investment-python'])
    return
  }
  const state = await lockState()
  if (mode === 'state') {
    process.stdout.write(`container-lock=${state.container ? 'present' : 'absent'}\n`)
    process.stdout.write(`application-lock=${state.application ? 'present' : 'absent'}\n`)
    return
  }
  if (mode === 'state-clean') {
    if (state.container || state.application) throw new Error('container state lock remains after shutdown')
    return
  }
  throw new Error('container check mode is invalid')
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    await run(process.argv[2])
  } catch (error) {
    process.stderr.write(`container check failed: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
