/**
 * The application scheme routes one origin to the Host, the injected index
 * document, the client bundles, and the renderer's own assets — and refuses a
 * path that leaves the renderer directory.
 */

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebBootGraph } from '@deepseek-ai/dsh-client-modules'
import { APP_INDEX_URL, createAppProtocolHandler, type AppProtocolSources } from '../src/protocol.ts'

const GRAPH: WebBootGraph = {
  rev: 'rev-1',
  entries: [{ id: '@deepseek-ai/dsh-client-connection', url: '/plugins/@deepseek-ai/dsh-client-connection/client.js?rev=b1', rev: 'b1' }],
}

let rendererDir: string
let bundlePath: string

/** Read a local file the way Electron's `net.fetch` does for the production handler. */
const fetchFile = vi.fn(async (fileUrl: string) => {
  try {
    return new Response(await readFile(fileURLToPath(fileUrl)))
  } catch {
    // Absent asset: the scheme answers 404 rather than surfacing a read error.
    return new Response('not found', { status: 404 })
  }
})

function handler(overrides: Partial<AppProtocolSources> = {}): (request: Request) => Promise<Response> {
  return createAppProtocolHandler({
    rendererDir,
    connection: {
      owns: pathname => pathname.startsWith('/api/') || pathname.startsWith('/rpc/'),
      fetch: async request => new Response(`host:${new URL(request.url).pathname}`),
    },
    modules: {
      graph: () => GRAPH,
      bundleFile: pathname => pathname === '/plugins/@deepseek-ai/dsh-client-connection/client.js'
        ? { path: bundlePath, contentType: 'text/javascript; charset=utf-8' }
        : undefined,
    },
    fetchFile,
    ...overrides,
  })
}

beforeEach(async () => {
  rendererDir = await mkdtemp(join(tmpdir(), 'dsh-electron-protocol-'))
  await mkdir(join(rendererDir, 'assets'))
  await writeFile(join(rendererDir, 'index.html'), '<html><head></head><body></body></html>')
  await writeFile(join(rendererDir, 'assets', 'app.js'), 'export const shell = 1\n')
  bundlePath = join(rendererDir, 'connection.client.js')
  await writeFile(bundlePath, 'export function apply() {}\n')
  fetchFile.mockClear()
})

describe('desktop application scheme', () => {
  it('serves the index document with the client boot graph injected', async () => {
    const response = await handler()(new Request(APP_INDEX_URL))

    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
    const html = await response.text()
    expect(html).toContain('window.__DSH_BOOT__')
    expect(html).toContain('/plugins/@deepseek-ai/dsh-client-connection/client.js?rev=b1')
  })

  it('hands Host paths to the connection provider with the request intact', async () => {
    const download = await handler()(new Request('dsh://app/api/session.export?sessionId=s1', { method: 'HEAD' }))
    const rpc = await handler()(new Request('dsh://app/rpc/goals/create', { method: 'POST', body: '{}' }))

    await expect(download.text()).resolves.toBe('host:/api/session.export')
    await expect(rpc.text()).resolves.toBe('host:/rpc/goals/create')
  })

  it('serves a client bundle under its declared content type', async () => {
    const response = await handler()(new Request('dsh://app/plugins/@deepseek-ai/dsh-client-connection/client.js?rev=b1'))

    expect(response.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    await expect(response.text()).resolves.toBe('export function apply() {}\n')
  })

  it('answers 404 for a registered bundle whose file is missing', async () => {
    bundlePath = join(rendererDir, 'never-built.js')

    const response = await handler()(new Request('dsh://app/plugins/@deepseek-ai/dsh-client-connection/client.js'))

    expect(response.status).toBe(404)
  })

  it('serves renderer assets and refuses an encoded escape from the renderer directory', async () => {
    const asset = await handler()(new Request('dsh://app/assets/app.js'))
    // Percent-encoded separators survive URL normalization, so the traversal
    // reaches the handler's own resolution rather than being collapsed first.
    const escape = await handler()(new Request('dsh://app/assets/%2e%2e%2f%2e%2e%2fsecret.txt'))
    const root = await handler()(new Request('dsh://app/'))

    await expect(asset.text()).resolves.toBe('export const shell = 1\n')
    expect(escape.status).toBe(404)
    expect(root.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(fetchFile).not.toHaveBeenCalledWith(expect.stringContaining('secret.txt'))
  })

  it('refuses another authority and a non-read method on a static path', async () => {
    const foreign = await handler()(new Request('dsh://elsewhere/index.html'))
    const written = await handler()(new Request('dsh://app/assets/app.js', { method: 'PUT', body: 'x' }))

    expect(foreign.status).toBe(404)
    expect(written.status).toBe(405)
  })
})
