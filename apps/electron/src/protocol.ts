/**
 * The desktop application's own URL scheme: one origin serving the renderer
 * assets, the client plugin bundles, and the Host API.
 *
 * The renderer needs a real origin rather than `file://`, because the product
 * addresses part of the Host by URL instead of through the Connection client:
 * the session-log export hands `/api/session.export` to the browser's download
 * manager. A `file://` page resolves those paths against the filesystem root.
 * A privileged scheme also keeps every Host request same-origin, so the Web
 * carrier's own Fetch and RPC code runs unchanged on the desktop.
 * @module @deepseek-ai/dsh-electron/protocol
 */

import { readFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { injectBootManifest, type BundleFile } from '@deepseek-ai/dsh-client-modules'
import type { WebBootGraph } from '@deepseek-ai/dsh-client-modules'

/** Scheme owned by the desktop application; registered as standard and secure before app readiness. */
export const APP_SCHEME = 'dsh'

/** Single authority under {@link APP_SCHEME}; any other host is refused. */
const APP_HOST = 'app'

/** The renderer document's URL, and the only navigation target the window accepts. */
export const APP_INDEX_URL = `${APP_SCHEME}://${APP_HOST}/index.html`

/** The Host side of one request: which paths it owns, and how it answers them. */
interface ProtocolConnection {
  /**
   * Whether the Host answers `pathname` (the API gateway or a registered RPC channel).
   * @param pathname - decoded request pathname.
   * @returns true when the Host owns the path.
   */
  owns(pathname: string): boolean
  /**
   * Answer one Host request.
   * @param request - the renderer's request.
   * @returns the Host response.
   */
  fetch(request: Request): Promise<Response>
}

/** The client plugin table's two carrier-facing reads. */
interface ProtocolModules {
  /**
   * The boot entry graph injected into the served index document.
   * @returns the composed graph.
   */
  graph(): WebBootGraph
  /**
   * Resolve a bundle-route pathname to the file to serve.
   * @param pathname - decoded request pathname.
   * @returns the file, or undefined when the route addresses no bundle.
   */
  bundleFile(pathname: string): BundleFile | undefined
}

/** Everything the scheme serves, and the file reader it serves bytes through. */
export interface AppProtocolSources {
  /** Directory holding the built renderer document and its assets. */
  readonly rendererDir: string
  /** The Host connection provider. */
  readonly connection: ProtocolConnection
  /** The client plugin table. */
  readonly modules: ProtocolModules
  /**
   * Read one local file as a response. Electron's `net.fetch` is the production
   * reader: it streams the body and labels ordinary web assets by extension.
   * @param fileUrl - absolute `file:` URL inside {@link rendererDir}.
   * @returns the file response.
   */
  readonly fetchFile: (fileUrl: string) => Promise<Response>
}

/**
 * Build the handler for {@link APP_SCHEME}.
 *
 * Ownership is decided in one order, most specific first: the Host's own paths,
 * the injected index document, a client plugin bundle, then a renderer asset.
 * A path that escapes the renderer directory is refused rather than resolved,
 * because the scheme is reachable from page code.
 * @param sources - the Host, the plugin table, and the renderer directory.
 * @returns the `protocol.handle` callback.
 */
export function createAppProtocolHandler(
  sources: AppProtocolSources,
): (request: Request) => Promise<Response> {
  const indexPath = join(sources.rendererDir, 'index.html')
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    if (url.host !== APP_HOST) return notFound()
    const pathname = decodeURIComponent(url.pathname)
    if (sources.connection.owns(pathname)) return await sources.connection.fetch(request)
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('method not allowed', { status: 405 })
    }
    if (pathname === '/' || pathname === '/index.html') {
      const html = injectBootManifest(await readFile(indexPath, 'utf8'), sources.modules.graph())
      return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } })
    }
    const bundle = sources.modules.bundleFile(pathname)
    if (bundle !== undefined) {
      const response = await sources.fetchFile(pathToFileURL(bundle.path).href)
      if (!response.ok) return notFound()
      return new Response(response.body, {
        headers: { 'content-type': bundle.contentType, 'cache-control': 'no-cache' },
      })
    }
    const assetPath = resolve(sources.rendererDir, `.${pathname}`)
    const within = relative(sources.rendererDir, assetPath)
    if (within === '' || within.startsWith('..') || isAbsolute(within)) return notFound()
    return await sources.fetchFile(pathToFileURL(assetPath).href)
  }
}

function notFound(): Response {
  return new Response('not found', { status: 404 })
}
