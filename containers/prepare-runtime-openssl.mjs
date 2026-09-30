import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// Official Debian sid package index, retrieved 2026-09-30. Both binaries keep the OpenSSL 3 ABI.
export const packages = Object.freeze(JSON.parse(await readFile(new URL('./runtime-openssl-lock.json', import.meta.url), 'utf8')).packages)

export function verifyArchive(bytes, specification) {
  if (createHash('sha256').update(bytes).digest('hex') !== specification.sha256) {
    throw new Error('OpenSSL Debian archive checksum mismatch')
  }
}

export function verifyControl(control, specification) {
  const fields = Object.fromEntries(control.split('\n').filter(line => /^[^\s:]+: /.test(line)).map(line => {
    const index = line.indexOf(': ')
    return [line.slice(0, index), line.slice(index + 2)]
  }))
  if (fields.Package !== specification.name || fields.Version !== specification.version
    || fields.Architecture !== 'amd64' || fields.Source !== 'openssl') {
    throw new Error('OpenSSL Debian package identity mismatch')
  }
}

export async function prepareRuntime(output) {
  const work = await mkdtemp(join(tmpdir(), 'dsh-runtime-openssl-'))
  await mkdir(output) // Never merge a partially prepared or unrelated tree.
  try {
    for (const specification of packages) {
      const filename = `${specification.name}_${specification.version}_amd64.deb`
      const response = await fetch(`https://deb.debian.org/debian/pool/main/o/openssl/${filename}`, {
        signal: AbortSignal.timeout(120_000),
      })
      if (!response.ok) throw new Error(`OpenSSL Debian download failed: HTTP ${response.status}`)
      const bytes = Buffer.from(await response.arrayBuffer())
      verifyArchive(bytes, specification)
      const archive = join(work, filename)
      const controls = join(work, specification.name)
      await writeFile(archive, bytes)
      execFileSync('dpkg-deb', ['--control', archive, controls])
      const control = await readFile(join(controls, 'control'), 'utf8')
      verifyControl(control, specification)
      execFileSync('dpkg-deb', ['--extract', archive, output])
      for (const [path, sha256] of Object.entries(specification.payloads)) {
        verifyArchive(await readFile(join(output, path)), { sha256 })
      }
      // Keep the genuine package record and payload checksums, using Distroless's status.d convention.
      const status = join(output, 'var/lib/dpkg/status.d')
      await mkdir(status, { recursive: true })
      await writeFile(join(status, specification.name), control)
      await writeFile(join(status, `${specification.name}.md5sums`), await readFile(join(controls, 'md5sums')))
    }
  } catch (error) {
    await rm(output, { recursive: true, force: true })
    throw error
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length !== 3) throw new Error('Expected an OpenSSL runtime output directory')
  await prepareRuntime(resolve(process.argv[2]))
}
