import { randomUUID } from 'node:crypto'
import { closeSync, constants, fsyncSync, fstatSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * Atomically replace one private password file; fallible writes precede the rename commit.
 * @param path - instance-owned private password file.
 * @param expected - record loaded by this process, to detect offline replacement.
 * @param next - validated new scrypt record.
 * @returns after the new file has been committed.
 */
export function replaceProtectedPasswordHash(path: string, expected: string, next: string): void {
  const parent = dirname(path)
  const directory = lstatSync(parent)
  if (!directory.isDirectory() || (process.platform !== 'win32' && (directory.mode & 0o077) !== 0)) {
    throw new Error('password directory must be private')
  }
  const current = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const metadata = fstatSync(current)
    if (!metadata.isFile() || metadata.size > 4_096
      || (process.platform !== 'win32' && (metadata.mode & 0o077) !== 0)
      || readFileSync(current, 'utf8').trim() !== expected) throw new Error('password file changed or is unsafe')
  } finally { closeSync(current) }
  const temporary = join(parent, `.password-${randomUUID()}.tmp`)
  let descriptor: number | undefined
  let created = false
  try {
    descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    created = true
    writeFileSync(descriptor, `${next}\n`, 'utf8')
    fsyncSync(descriptor)
    closeSync(descriptor); descriptor = undefined
    renameSync(temporary, path)
    created = false
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
    if (created) unlinkSync(temporary)
  }
}
