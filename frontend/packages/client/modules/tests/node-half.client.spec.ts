/** Node-half composition diagnostics for package metadata and built client bundles. */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import type { WebServer, WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { ClientModuleRegistry } from '../src/index.ts'

let root: string | undefined

afterEach(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true })
  root = undefined
})

/** Create a resolvable package whose client export points at the returned path. */
function writePackage(
  packageName: string,
  metadata: Record<string, unknown> = { dsh: { client: { platform: 'web' } } },
): string {
  root ??= realpathSync(mkdtempSync(join(tmpdir(), 'dsh-client-modules-')))
  const pkgRoot = join(root, 'node_modules', ...packageName.split('/'))
  const clientPath = join(pkgRoot, 'lib', 'client.js')
  mkdirSync(pkgRoot, { recursive: true })
  writeFileSync(join(pkgRoot, 'package.json'), JSON.stringify({
    name: packageName,
    exports: {
      './client': './lib/client.js',
      './package.json': './package.json',
    },
    ...metadata,
  }))
  return clientPath
}

/** Construct the node-half service and capture its plugin-bundle route. */
async function constructWithRoute(
  packageNames: string[],
  additionalPackages: string[] = [],
  options: {
    injectBootManifest?: boolean
    authorize?: (request: IncomingMessage) => { ok: true } | { ok: false; status: number; code: string }
    trustedHosts?: string[]
    trustedProxyAddresses?: string[]
    requireWebAuth?: boolean
  } = {},
): Promise<{ service: ClientModuleRegistry; route: WebRoute; tapped: boolean }> {
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(root!).href + '/'
  ctx.provide('loader', {
    *entries() {
      for (const packageName of packageNames) {
        yield { options: { name: packageName }, fiber: {}, disabled: false }
      }
    },
  })
  let route: WebRoute | undefined
  let tapped = false
  const webServer: Pick<WebServer, 'port' | 'register' | 'tapIndex'> = {
    port: 0,
    register: (candidate) => {
      if (candidate.path === '/plugins') route = candidate
      return () => {}
    },
    tapIndex: () => { tapped = true; return () => {} },
  }
  ctx.provide('webServer', webServer as WebServer)
  if (options.authorize !== undefined) {
    ctx.provide('webAuth', { authorize: options.authorize } as never)
  }
  let service: ClientModuleRegistry | undefined
  const fiber = ctx.plugin({
    apply(pluginCtx) {
      service = new ClientModuleRegistry(pluginCtx, {
        additionalPackages,
        ...(options.injectBootManifest === undefined ? {} : { injectBootManifest: options.injectBootManifest }),
        ...(options.trustedHosts === undefined ? {} : { trustedHosts: options.trustedHosts }),
        ...(options.trustedProxyAddresses === undefined ? {} : { trustedProxyAddresses: options.trustedProxyAddresses }),
        ...(options.requireWebAuth === undefined ? {} : { requireWebAuth: options.requireWebAuth }),
      })
    },
  })
  await fiber.await()
  if (route === undefined) throw new Error('client bundle route was not registered')
  if (service === undefined) throw new Error('client module registry was not constructed')
  return { service, route, tapped }
}

/** Construct the node-half service over the enabled fixture entries. */
async function construct(packageNames: string[]): Promise<ClientModuleRegistry> {
  return (await constructWithRoute(packageNames)).service
}

describe('client bundle activation', () => {
  it('allows sibling dsh roles', async () => {
    const currentName = '@fixture/current-client-field'
    const clientPath = writePackage(currentName, {
      dsh: {
        bundle: { patch: './cordis.patch.yml' },
        client: { platform: 'web' },
        profile: { bundles: [] },
      },
    })
    mkdirSync(dirname(clientPath), { recursive: true })
    writeFileSync(clientPath, 'module.exports = {}\n')
    expect((await construct([currentName])).graph().entries.map(entry => entry.id)).toEqual([currentName])
  })

  it('composes additional client packages without Host Loader entries or a Web server', () => {
    const packageName = '@fixture/electron-carrier'
    const clientPath = writePackage(packageName)
    mkdirSync(dirname(clientPath), { recursive: true })
    writeFileSync(clientPath, 'module.exports = {}\n')
    const ctx = new Context()
    ctx.baseUrl = pathToFileURL(root!).href + '/'
    ctx.provide('loader', { *entries() {} })

    const service = new ClientModuleRegistry(ctx, { additionalPackages: [packageName] })

    expect(service.graph().entries.map(entry => entry.id)).toEqual([packageName])
    expect(service.clientPath(packageName)).toBe(clientPath)
  })

  it('groups missing bundles under one source-build instruction with a package/path list', async () => {
    const firstName = '@fixture/missing-first'
    const secondName = '@fixture/missing-second'
    const firstPath = writePackage(firstName)
    const secondPath = writePackage(secondName)
    await expect(construct([firstName, secondName])).rejects.toThrow([
      'client-modules: 2 client packages failed to compose:',
      '  client bundles not found; run `pnpm run build` before launch:',
      `    - package: ${firstName}`,
      `      path: ${firstPath}`,
      `    - package: ${secondName}`,
      `      path: ${secondPath}`,
    ].join('\n'))
  })

  it('does not report other bundle read failures as missing builds', async () => {
    const packageName = '@fixture/unreadable-client'
    const clientPath = writePackage(packageName)
    mkdirSync(clientPath, { recursive: true })
    let thrown: unknown
    try {
      await construct([packageName])
    } catch (error) {
      thrown = error
    }
    expect(String(thrown)).toContain('client-modules: 1 client package failed to compose:')
    expect(String(thrown)).toContain('  other failures:')
    expect(String(thrown)).toContain('EISDIR')
    expect(String(thrown)).not.toContain('pnpm run build')
  })

  it('does not serve source maps beside registered client bundles', async () => {
    const packageName = '@fixture/source-map'
    const clientPath = writePackage(packageName)
    mkdirSync(dirname(clientPath), { recursive: true })
    writeFileSync(clientPath, 'module.exports = {}\n')
    const map = '{"version":3,"sources":["src/client/index.tsx"]}\n'
    writeFileSync(`${clientPath}.map`, map)
    const { route } = await constructWithRoute([packageName])
    let status = 0
    let headers: Record<string, string> | undefined
    let body = ''
    const response = {
      writeHead(nextStatus: number, nextHeaders?: Record<string, string>) {
        status = nextStatus
        headers = nextHeaders
        return response
      },
      end(chunk?: Uint8Array) {
        body = chunk === undefined ? '' : Buffer.from(chunk).toString('utf8')
        return response
      },
    } as unknown as ServerResponse

    await route.handler({
      method: 'GET',
      url: `/plugins/${packageName}/client.js.map`,
      headers: { host: '127.0.0.1:3080' },
      socket: { remoteAddress: '127.0.0.1' },
    } as IncomingMessage, response)

    expect(status).toBe(404)
    expect(headers).toBeUndefined()
    expect(body).toBe('')
  })

  it('protects plugin bundles before reading them and can keep the boot graph out of public HTML', async () => {
    const packageName = '@fixture/protected-bundle'
    const clientPath = writePackage(packageName)
    mkdirSync(dirname(clientPath), { recursive: true })
    writeFileSync(clientPath, 'PRIVATE_PLUGIN_MARKER\n')
    const { route, tapped } = await constructWithRoute([packageName], [], {
      injectBootManifest: false,
      authorize: () => ({ ok: false, status: 401, code: 'auth-required' }),
    })
    let status = 0
    let body = ''
    const response = {
      writeHead(nextStatus: number) { status = nextStatus; return response },
      end(chunk?: string | Uint8Array) {
        body = chunk === undefined ? '' : Buffer.from(chunk).toString('utf8')
        return response
      },
    } as unknown as ServerResponse

    await route.handler({
      method: 'GET',
      url: `/plugins/${packageName}/client.js`,
      headers: { host: '127.0.0.1:3080' },
      socket: { remoteAddress: '127.0.0.1' },
    } as IncomingMessage, response)

    expect(status).toBe(401)
    expect(body).toContain('auth-required')
    expect(body).not.toContain('PRIVATE_PLUGIN_MARKER')
    expect(tapped).toBe(false)
  })

  it('rejects untrusted bundle requests and fails closed when the Web composition requires a missing authority', async () => {
    const packageName = '@fixture/trust-guarded-bundle'
    const clientPath = writePackage(packageName)
    mkdirSync(dirname(clientPath), { recursive: true })
    writeFileSync(clientPath, 'PRIVATE_PLUGIN_MARKER\n')
    const { route } = await constructWithRoute([packageName], [], {
      trustedHosts: ['harness.internal'],
      trustedProxyAddresses: ['127.0.0.1'],
      requireWebAuth: true,
    })
    const invoke = async (headers: Record<string, string>, remoteAddress = '127.0.0.1') => {
      let status = 0
      let body = ''
      const response = {
        writeHead(nextStatus: number) { status = nextStatus; return response },
        end(chunk?: string | Uint8Array) {
          body = chunk === undefined ? '' : Buffer.from(chunk).toString('utf8')
          return response
        },
      } as unknown as ServerResponse
      await route.handler({
        method: 'GET',
        url: `/plugins/${packageName}/client.js`,
        headers,
        socket: { remoteAddress },
      } as IncomingMessage, response)
      return { status, body }
    }

    expect(await invoke({ host: 'evil.example' })).toMatchObject({ status: 403 })
    expect(await invoke({
      host: 'harness.internal',
      origin: 'https://evil.example',
    })).toMatchObject({ status: 403 })
    expect(await invoke({
      host: 'harness.internal',
      'sec-fetch-site': 'cross-site',
    })).toMatchObject({ status: 403 })
    const unavailable = await invoke({
      host: 'harness.internal',
      origin: 'https://harness.internal',
    })
    expect(unavailable).toMatchObject({ status: 503 })
    expect(unavailable.body).toContain('auth-unavailable')
    expect(unavailable.body).not.toContain('PRIVATE_PLUGIN_MARKER')
  })
})
