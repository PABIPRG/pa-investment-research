export interface BrowserWebAuthBridge {
  csrfToken(): string | undefined
  unauthorized(): void
}

function bridge(): BrowserWebAuthBridge | undefined {
  return (globalThis as typeof globalThis & { __DSH_WEB_AUTH__?: BrowserWebAuthBridge }).__DSH_WEB_AUTH__
}

/** Add the session CSRF proof to state-changing Web requests. */
export function authenticatedInit(init?: RequestInit): RequestInit | undefined {
  const method = init?.method?.toUpperCase() ?? 'GET'
  if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return init
  const csrf = bridge()?.csrfToken()
  if (csrf === undefined) return init
  const headers = new Headers(init?.headers)
  headers.set('x-dsh-csrf', csrf)
  return { ...init, headers }
}

/** Notify the app gate when the server invalidates the browser session. */
export function observeAuthResponse(response: Response): Response {
  const authBridge = bridge()
  if (response.status === 401) authBridge?.unauthorized()
  else if (response.status === 403) {
    void response.clone().json().then((body: unknown) => {
      if ((body as { code?: unknown } | null)?.code === 'csrf-invalid') authBridge?.unauthorized()
    }).catch(() => {})
  }
  return response
}
