/** Electron Host connection provider: Fetch/RPC dispatch plus event-stream access for the main process. */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import {
  connectionRpcFetchHandler,
  type ConnectionRpcEndpointMatcher,
  type ConnectionRpcHandler,
  type ConnectionRpcHandlerOptions,
  type HostConnectionHandle,
  type HostConnectionRpc,
} from '@deepseek-ai/dsh-client-connection'
import {
  RpcId,
  toFetchHandler,
  type HostFrame,
  type MuxFrame,
  type RpcRequest,
} from '@deepseek-ai/dsh-host-apiproxy'

/** Stable Loader plugin name. */
export const name = 'electron-connection'

interface RegisteredChannel {
  readonly fetchHandler: { fetch(request: Request): Promise<Response> }
}

interface RegisteredInterceptor extends RegisteredChannel {
  readonly matches: ConnectionRpcEndpointMatcher
}

/** In-process Connection provider consumed by Electron's IPC main process. */
export class ElectronConnectionService extends Service implements HostConnectionHandle {
  static inject = ['apiProxy']

  private readonly channels = new Map<string, RegisteredChannel>()
  private interceptor: RegisteredInterceptor | undefined
  private readonly apiHandler: ReturnType<typeof toFetchHandler>

  /** @param ctx - plugin context carrying the transport-independent API gateway. */
  constructor(ctx: Context) {
    super(ctx, 'connection')
    this.apiHandler = toFetchHandler(ctx.apiProxy)
  }

  /** Registration API used by transport-independent Host adapters. */
  get rpc(): HostConnectionRpc {
    const owner = this.ctx
    return {
      handle: (channel, handler, options) => this.register(owner, channel, handler, options),
      intercept: (channel, matches, handler, options) =>
        this.registerInterceptor(owner, channel, matches, handler, options),
    }
  }

  /**
   * Whether this provider answers `pathname`.
   *
   * The application scheme serves the Host and the renderer's own assets from
   * one origin, so the carrier asks before falling through to a static file.
   * @param pathname - decoded request pathname.
   * @returns true for the API gateway and every registered RPC channel.
   */
  owns(pathname: string): boolean {
    if (endpointFromPath('/api', pathname) !== undefined) return true
    return [...this.channels.keys()].some(channel => endpointFromPath(channel, pathname) !== undefined)
  }

  /**
   * Dispatch one request from the trusted local renderer.
   * @param request - the renderer's request, delivered by the application scheme.
   * @returns transport or API response.
   */
  fetch(request: Request): Promise<Response> {
    const pathname = new URL(request.url).pathname
    const apiEndpoint = endpointFromPath('/api', pathname)
    if (apiEndpoint !== undefined) {
      const interceptor = this.interceptor
      if (interceptor !== undefined && interceptor.matches(apiEndpoint)) {
        return interceptor.fetchHandler.fetch(request)
      }
      return this.apiHandler.fetch(request)
    }
    for (const [channel, registered] of this.channels) {
      if (endpointFromPath(channel, pathname) !== undefined) {
        return registered.fetchHandler.fetch(request)
      }
    }
    return Promise.resolve(new Response('not found', { status: 404 }))
  }

  /**
   * Open one Host event stream for an Electron renderer.
   * @param kind - logical stream name.
   * @param signal - renderer subscription cancellation.
   * @returns typed Host frames until cancellation or provider failure.
   */
  openStream(
    kind: 'mux' | 'host',
    signal: AbortSignal,
  ): AsyncIterable<RpcRequest<MuxFrame | HostFrame>> {
    const request = { rpcId: RpcId(crypto.randomUUID()), payload: {} }
    return kind === 'mux'
      ? this.ctx.apiProxy.events.mux(request, signal)
      : this.ctx.apiProxy.events.host(request, signal)
  }

  private register(
    owner: Context,
    channel: string,
    handler: ConnectionRpcHandler,
    _options: ConnectionRpcHandlerOptions,
  ): () => Promise<void> {
    assertChannel(channel)
    const registered: RegisteredChannel = { fetchHandler: connectionRpcFetchHandler(channel, handler) }
    return owner.effect(() => {
      if (this.channels.has(channel)) {
        throw new Error(`electron-connection: RPC channel ${JSON.stringify(channel)} is already registered`)
      }
      this.channels.set(channel, registered)
      return () => { this.channels.delete(channel) }
    }, `electron-connection: ${channel} RPC channel`)
  }

  private registerInterceptor(
    owner: Context,
    channel: '/api',
    matches: ConnectionRpcEndpointMatcher,
    handler: ConnectionRpcHandler,
    _options: ConnectionRpcHandlerOptions,
  ): () => Promise<void> {
    const registered: RegisteredInterceptor = {
      matches,
      fetchHandler: connectionRpcFetchHandler(channel, handler),
    }
    return owner.effect(() => {
      if (this.interceptor !== undefined) {
        throw new Error('electron-connection: /api interceptor is already registered')
      }
      this.interceptor = registered
      return () => { this.interceptor = undefined }
    }, 'electron-connection: /api RPC interceptor')
  }
}

const CHANNEL_PATTERN = /^\/[A-Za-z0-9._~-]+$/
const ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/

function endpointFromPath(channel: string, pathname: string): string | undefined {
  if (!pathname.startsWith(`${channel}/`)) return undefined
  const endpoint = pathname.slice(channel.length + 1)
  const segments = endpoint.split('/')
  return segments.some(segment =>
    segment === '' || segment === '.' || segment === '..' || !ENDPOINT_SEGMENT_PATTERN.test(segment))
    ? undefined
    : endpoint
}

function assertChannel(channel: string): void {
  if (!CHANNEL_PATTERN.test(channel) || channel === '/api') {
    throw new Error(`electron-connection: invalid or reserved RPC channel ${JSON.stringify(channel)}`)
  }
}

export default ElectronConnectionService
