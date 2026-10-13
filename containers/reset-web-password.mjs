#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { acquireInstanceLock } from './investment-entrypoint.mjs'

/** Replace only this volume's password while holding the same lease as the application. */
export async function resetPasswordRecord(dshHome, encoded) {
  if (!isAbsolute(dshHome)) throw new Error('DSH_HOME must be absolute')
  if (typeof encoded !== 'string' || !/^dsh-scrypt-v2\$16384\$8\$1\$\d+\$[\w-]{22}\$[\w-]{43}$/u.test(encoded.trim())) {
    throw new Error('invalid password record')
  }
  const lease = await acquireInstanceLock(join(dshHome, 'investment-research'))
  const directory = join(dshHome, 'web-auth')
  const temporary = join(directory, `.reset-password-${randomUUID()}.tmp`)
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const parent = await lstat(directory)
    if (!parent.isDirectory() || (parent.mode & 0o077) !== 0) throw new Error('password directory must be private')
    let handle
    try {
      handle = await open(temporary, 'wx', 0o600)
      await handle.writeFile(`${encoded.trim()}\n`, 'utf8')
      await handle.sync()
      await handle.close(); handle = undefined
      await rename(temporary, join(directory, 'password.hash'))
    } finally {
      await handle?.close()
      await rm(temporary, { force: true })
    }
  } finally { await lease.release() }
}

async function run() {
  const home = process.env.DSH_HOME
  if (!home || !isAbsolute(home)) throw new Error('DSH_HOME must be absolute')
  if (process.stdin.isTTY) throw new Error('provide the new password through standard input')
  // The published CLI owns strength validation and bounded stdin; do not duplicate the KDF.
  const child = spawn(process.execPath, ['/opt/dsh/lib/bin.js', 'web-password-hash'], { stdio: ['pipe', 'pipe', 'pipe'] })
  process.stdin.pipe(child.stdin)
  child.stdin.on('error', () => { /* A rejected bounded input closes the child pipe early. */ })
  let record = ''; let diagnostic = ''
  child.stdout.on('data', chunk => { record += String(chunk) })
  child.stderr.on('data', chunk => { diagnostic += String(chunk) })
  const code = await new Promise((resolveExit, reject) => { child.once('error', reject); child.once('exit', resolveExit) })
  if (code !== 0) throw new Error(diagnostic.trim() || 'password validation failed')
  await resetPasswordRecord(home, record)
  process.stdout.write('密码已重置。请启动对应实例并使用新密码登录。\n')
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { await run() }
  catch (error) { process.stderr.write(`密码重置失败：${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1 }
}
