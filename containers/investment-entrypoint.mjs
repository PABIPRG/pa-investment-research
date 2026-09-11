#!/usr/bin/env node

import { randomUUID } from 'node:crypto'
import { chmod, copyFile, lstat, mkdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'

const LOCK_NAME = '.container-instance.lock'
const OWNER_NAME = 'owner.json'
const STARTING_GRACE_MS = 10_000
const LEASE_TIMEOUT_MS = 10_000
const HEARTBEAT_MS = 2_000

function required(environment, name) {
  const value = environment[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

function list(environment, name) {
  const values = required(environment, name).split(',').map(value => value.trim()).filter(Boolean)
  if (values.length === 0) throw new Error(`${name} must contain at least one value`)
  return values
}

/** Validate the fail-closed remote Web and single-instance container configuration. */
export function validateConfiguration(environment) {
  const dshHome = required(environment, 'DSH_HOME')
  if (!isAbsolute(dshHome)) throw new Error('DSH_HOME must be an absolute path')
  if (required(environment, 'DSH_WEB_AUTH') !== 'required') throw new Error('DSH_WEB_AUTH must be required')
  if (environment.DSH_WEB_INSECURE_COOKIES === '1') throw new Error('DSH_WEB_INSECURE_COOKIES must not disable secure cookies')
  const portText = required(environment, 'PORT')
  if (!/^\d+$/u.test(portText)) throw new Error('PORT must be an integer')
  const port = Number(portText)
  if (port < 1 || port > 65_535) throw new Error('PORT must be between 1 and 65535')
  const timezone = required(environment, 'TZ')
  if (required(environment, 'TIMEZONE') !== timezone) throw new Error('TZ and TIMEZONE must match')
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone }).format()
  } catch {
    throw new Error('TZ and TIMEZONE must name a valid IANA timezone')
  }
  const passwordHashSourceFile = required(environment, 'DSH_WEB_ADMIN_PASSWORD_HASH_SOURCE_FILE')
  if (!isAbsolute(passwordHashSourceFile)) throw new Error('DSH_WEB_ADMIN_PASSWORD_HASH_SOURCE_FILE must be absolute')
  return Object.freeze({
    dshHome,
    passwordHashSourceFile,
    port,
    timezone,
    username: required(environment, 'DSH_WEB_ADMIN_USERNAME'),
    trustedHosts: list(environment, 'DSH_WEB_TRUSTED_HOSTS'),
    trustedProxies: list(environment, 'DSH_WEB_TRUSTED_PROXIES'),
  })
}

function isNodeError(error, code) {
  return error instanceof Error && error.code === code
}

async function currentOwner(lockDir) {
  try {
    const value = JSON.parse(await readFile(join(lockDir, OWNER_NAME), 'utf8'))
    if (value?.version !== 1 || typeof value.token !== 'string' || value.token.length < 16) return undefined
    return value
  } catch (error) {
    if (isNodeError(error, 'ENOENT') || error instanceof SyntaxError) return undefined
    throw error
  }
}

async function quarantine(lockDir) {
  const stale = `${lockDir}.stale-${randomUUID()}`
  try {
    await rename(lockDir, stale)
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return false
    throw error
  }
  await rm(stale, { force: true, recursive: true })
  return true
}

/** Acquire a volume-visible lease whose liveness works across container PID namespaces. */
export async function acquireInstanceLock(instanceRoot) {
  await mkdir(instanceRoot, { mode: 0o700, recursive: true })
  const lockDir = join(instanceRoot, LOCK_NAME)
  const token = randomUUID()

  for (;;) {
    try {
      await mkdir(lockDir, { mode: 0o700 })
    } catch (error) {
      if (!isNodeError(error, 'EEXIST')) throw error
      const owner = await currentOwner(lockDir)
      const age = Date.now() - (await stat(owner ? join(lockDir, OWNER_NAME) : lockDir)).mtimeMs
      if (owner && age < LEASE_TIMEOUT_MS) {
        throw new Error(`another container already owns ${instanceRoot}`)
      }
      if (!owner && age < STARTING_GRACE_MS) {
        throw new Error(`another container is starting for ${instanceRoot}`)
      }
      if (!await quarantine(lockDir)) continue
      continue
    }

    try {
      await writeFile(join(lockDir, OWNER_NAME), `${JSON.stringify({
        version: 1,
        token,
        pid: process.pid,
        startedAt: new Date().toISOString(),
      })}\n`, { encoding: 'utf8', mode: 0o600 })
    } catch (error) {
      await quarantine(lockDir)
      throw error
    }

    const ownerPath = join(lockDir, OWNER_NAME)
    let heartbeatWrite = Promise.resolve()
    const heartbeat = setInterval(() => {
      heartbeatWrite = heartbeatWrite.then(async () => {
        const now = new Date()
        const owner = await currentOwner(lockDir)
        if (owner?.token !== token) throw new Error('container instance lease ownership changed')
        await utimes(ownerPath, now, now)
      }).catch(error => {
        clearInterval(heartbeat)
        process.stderr.write(`container lease heartbeat failed: ${error instanceof Error ? error.message : String(error)}\n`)
        process.kill(process.pid, 'SIGTERM')
      })
    }, HEARTBEAT_MS)
    heartbeat.unref()

    let released
    return Object.freeze({
      ownerFile: ownerPath,
      release() {
        released ??= (async () => {
          clearInterval(heartbeat)
          await heartbeatWrite
          const owner = await currentOwner(lockDir)
          if (owner?.token !== token) throw new Error('container instance lock ownership changed before release')
          const releasedDir = `${lockDir}.released-${token}`
          await rename(lockDir, releasedDir)
          await rm(releasedDir, { force: true, recursive: true })
        })()
        return released
      },
    })
  }
}

async function preparePasswordHash(source, destination) {
  const sourceMetadata = await lstat(source)
  if (!sourceMetadata.isFile()) throw new Error('password hash secret must be a regular file')
  const value = await readFile(source, 'utf8')
  if (!value.trim() || value.length > 8_192) throw new Error('password hash secret is empty or too large')
  await mkdir(resolve(destination, '..'), { mode: 0o700, recursive: true })
  await copyFile(source, destination)
  await chmod(destination, 0o600)
}

async function run() {
  const configuration = validateConfiguration(process.env)
  const lease = await acquireInstanceLock(join(configuration.dshHome, 'investment-research'))
  const passwordHashFile = '/run/dsh/web-admin-password.hash'
  try {
    await preparePasswordHash(configuration.passwordHashSourceFile, passwordHashFile)
    const args = [
      '/opt/dsh/lib/bin.js', '--profile', 'investment-research',
      '--host', '0.0.0.0', '--port', String(configuration.port),
      ...configuration.trustedHosts.flatMap(value => ['--trusted-host', value]),
      ...configuration.trustedProxies.flatMap(value => ['--trusted-proxy', value]),
    ]
    const child = spawn(process.execPath, args, {
      env: {
        ...process.env,
        DSH_CONTAINER_INSTANCE_LEASE_FILE: lease.ownerFile,
        DSH_WEB_ADMIN_PASSWORD_HASH_FILE: passwordHashFile,
      },
      stdio: 'inherit',
    })
    let stopping = false
    let hardStop
    const forward = signal => {
      if (stopping || child.exitCode !== null || child.signalCode !== null) return
      stopping = true
      child.kill(signal)
      hardStop = setTimeout(() => {
        process.stderr.write('graceful shutdown timed out; forcing child termination\n')
        child.kill('SIGKILL')
      }, 25_000)
      hardStop.unref()
    }
    for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.once(signal, () => forward(signal))
    const result = await new Promise((resolveExit, reject) => {
      child.once('error', reject)
      child.once('exit', (code, signal) => resolveExit({ code, signal }))
    })
    if (hardStop) clearTimeout(hardStop)
    process.exitCode = result.code ?? ({ SIGHUP: 129, SIGINT: 130, SIGTERM: 143, SIGKILL: 137 }[result.signal] ?? 1)
  } finally {
    await lease.release()
    await rm(passwordHashFile, { force: true })
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    await run()
  } catch (error) {
    process.stderr.write(`container startup failed: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
