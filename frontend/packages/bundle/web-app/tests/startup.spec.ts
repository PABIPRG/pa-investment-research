/**
 * The Web command-line provider over a real Loader tree: its ordinary service
 * releases a consumer whose config reads `ctx.webStartup` directly.
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { internals, provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, WEB_STARTUP_SERVICE, type WebStartupValues } from '../src/startup.ts'

/** What one fixture boot observed. */
interface Observed {
  exits: number[]
  out: string
  readerConfig?: unknown
}

const disposers: (() => Promise<void>)[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  for (const dispose of disposers.splice(0)) await dispose()
  internals.stdout = process.stdout
  internals.stderr = process.stderr
})

/**
 * Mount the real provider and a consumer using injection-ordered config.
 * @param args - the invocation's inner arguments.
 * @returns the service value and observed consumer/process effects.
 */
async function bootProvider(args: string[]): Promise<{
  values: WebStartupValues | undefined
  observed: Observed
}> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-web-startup-'))
  const observed: Observed = { exits: [], out: '' }
  writeFileSync(join(dir, 'reader.mjs'), `
export function apply(_ctx, config) { globalThis.__webStartupObserved.readerConfig = config }
`)
  // Node imports the fixture row outside Vite's source resolver, so delegate
  // to the source-plane plugin already imported by this test.
  writeFileSync(join(dir, 'provider.mjs'), `
export const name = 'web-startup'
export const inject = ['cmdlineArgs']
export const apply = ctx => globalThis.__webStartupApply(ctx)
`)
  writeFileSync(join(dir, 'cordis.yml'), [
    '- id: reader',
    `  name: ${pathToFileURL(join(dir, 'reader.mjs')).href}`,
    `  inject: [${WEB_STARTUP_SERVICE}]`,
    '  config:',
    "    host: !!js ctx.webStartup.host ?? '127.0.0.1'",
    '    port: !!js ctx.webStartup.port ?? 3080',
    '    trustedHosts: !!js ctx.webStartup.trustedHosts',
    '    trustedProxyAddresses: !!js ctx.webStartup.trustedProxyAddresses',
    '    authMode: !!js ctx.webStartup.authMode',
    '    authUsername: !!js ctx.webStartup.authUsername',
    '    authPasswordHashFile: !!js ctx.webStartup.authPasswordHashFile',
    '    secureCookies: !!js ctx.webStartup.secureCookies',
    '- id: provider',
    `  name: ${pathToFileURL(join(dir, 'provider.mjs')).href}`,
    '',
  ].join('\n'))
  const observing = { write: (chunk: string) => { observed.out += chunk; return true } }
  internals.stdout = observing
  internals.stderr = observing
  const globals = globalThis as unknown as {
    __webStartupApply: typeof apply
    __webStartupObserved: Observed
  }
  globals.__webStartupApply = apply
  globals.__webStartupObserved = observed

  const ctx = new Context()
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  provideCmdline(ctx, { args, exit: code => void observed.exits.push(code) })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(join(dir, 'cordis.yml')).href } })
  await ctx.loader.await()
  disposers.push(async () => { await ctx.fiber.dispose() })
  return {
    values: ctx.get(WEB_STARTUP_SERVICE) as WebStartupValues | undefined,
    observed,
  }
}

describe('web command-line provider', () => {
  it('publishes each flag and releases direct service expressions', async () => {
    const { values, observed } = await bootProvider([
      '--host', '127.0.0.1',
      '--port', '8080',
      '--trusted-host', 'lab.internal', 'lab-2.internal',
      '--trusted-host', '10.0.0.9',
      '--trusted-proxy', '127.0.0.1', '10.0.0.10',
    ])
    expect(values).toEqual({
      host: '127.0.0.1',
      port: 8080,
      trustedHosts: ['lab.internal', 'lab-2.internal', '10.0.0.9'],
      trustedProxyAddresses: ['127.0.0.1', '10.0.0.10'],
      authMode: 'disabled',
      secureCookies: true,
    })
    expect(observed.readerConfig).toEqual(values)
    expect(observed.exits).toEqual([])
  })

  it('leaves deployment values to each consumer when flags omit them', async () => {
    const { values, observed } = await bootProvider([])
    expect(values).toEqual({ trustedHosts: [], trustedProxyAddresses: [], authMode: 'disabled', secureCookies: true })
    expect(observed.readerConfig).toEqual({
      host: '127.0.0.1',
      port: 3080,
      trustedHosts: [],
      trustedProxyAddresses: [],
      authMode: 'disabled',
      secureCookies: true,
    })
  })

  it('prints its own help and leaves the consumer pending', async () => {
    const { values, observed } = await bootProvider(['--help'])
    expect(observed.out).toContain('dsh --profile web')
    expect(observed.out).toContain('--trusted-host')
    expect(observed.out).toContain('--trusted-proxy')
    expect(values).toBeUndefined()
    expect(observed.readerConfig).toBeUndefined()
    expect(observed.exits).toEqual([0])
  })

  it('rejects a non-numeric port before the consumer activates', async () => {
    const { values, observed } = await bootProvider(['--port', 'abc'])
    expect(observed.out).toContain('--port must be a number')
    expect(values).toBeUndefined()
    expect(observed.readerConfig).toBeUndefined()
    expect(observed.exits).toEqual([1])
  })

  it('rejects all-interfaces binding until required authentication is configured', async () => {
    const { values, observed } = await bootProvider(['--host', '0.0.0.0'])
    expect(observed.out).toContain('--host 0.0.0.0 requires required authentication, --trusted-host, and --trusted-proxy')
    expect(values).toBeUndefined()
    expect(observed.readerConfig).toBeUndefined()
    expect(observed.exits).toEqual([1])
  })

  it('allows all-interfaces binding only with a closed auth configuration', async () => {
    vi.stubEnv('DSH_WEB_AUTH', 'required')
    vi.stubEnv('DSH_WEB_ADMIN_USERNAME', 'admin')
    vi.stubEnv('DSH_WEB_ADMIN_PASSWORD_HASH_FILE', '/run/secrets/dsh-web-password')
    const { values, observed } = await bootProvider([
      '--host', '0.0.0.0',
      '--trusted-host', 'harness.internal',
      '--trusted-proxy', '127.0.0.1',
    ])
    expect(values).toMatchObject({
      host: '0.0.0.0', authMode: 'required', authUsername: 'admin',
      authPasswordHashFile: '/run/secrets/dsh-web-password', secureCookies: true,
      trustedHosts: ['harness.internal'], trustedProxyAddresses: ['127.0.0.1'],
    })
    expect(observed.exits).toEqual([])
  })
})
