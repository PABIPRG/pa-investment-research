/**
 * Structured-clone messages exposed by the Electron preload bridge.
 *
 * The bridge carries only the Host event downlinks. Everything addressable by
 * URL — unary RPC, uploads, and browser-managed downloads — travels over the
 * desktop application's own URL scheme, which the main process serves from the
 * same Fetch handler the Web carrier uses.
 */

/** Electron event stream selected by the renderer. */
export type ElectronStreamKind = 'mux' | 'host'

/** One lifecycle item from a main-process event-stream pump. */
export type ElectronStreamEvent =
  | { type: 'open' }
  | { type: 'message'; message: unknown }
  | { type: 'error'; message: string }
  | { type: 'end' }

/** Narrow API exposed by the sandboxed preload script. */
export interface ElectronRendererBridge {
  /** Request a fixed holdings action; foreground actions require a main-process dialog. */
  holdingsAction?(input: { action: 'read' | 'launch' | 'select_client' | 'download' | 'accessibility' | 'automation'; account_mode: 'real' | 'simulated' }): Promise<unknown>
  readonly version: 1
  /** Operating system reported by the sandboxed Electron preload. */
  readonly platform: 'darwin' | 'win32' | 'linux'
  /**
   * Start one downlink and deliver its lifecycle through `listener`.
   * @param kind - Host stream to subscribe to.
   * @param id - renderer-minted subscription identity.
   * @param listener - lifecycle recipient.
   */
  openStream(kind: ElectronStreamKind, id: string, listener: (event: ElectronStreamEvent) => void): void
  /** @param id - renderer-minted subscription identity. */
  closeStream(id: string): void
  /** Temporarily suspend application shortcuts while the Settings editor records a key. */
  setShortcutCapture(active: boolean): void
  /** Register one renderer listener for application shortcut actions. */
  watchShortcutActions(id: string, listener: (action: string) => void): void
  /** Remove one renderer shortcut-action listener. */
  unwatchShortcutActions(id: string): void
}

/** Main-world slot installed by the Electron preload. */
export interface ElectronBridgeWindow {
  __DSH_ELECTRON__?: unknown
}
