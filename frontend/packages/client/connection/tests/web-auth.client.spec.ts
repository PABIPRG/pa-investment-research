// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { authenticatedInit, observeAuthResponse } from '../src/client/web-auth.ts'

afterEach(() => {
  delete (globalThis as typeof globalThis & { __DSH_WEB_AUTH__?: unknown }).__DSH_WEB_AUTH__
})

describe('browser auth transport bridge', () => {
  it('adds the session CSRF token only to state-changing requests', () => {
    ;(globalThis as typeof globalThis & { __DSH_WEB_AUTH__?: unknown }).__DSH_WEB_AUTH__ = {
      csrfToken: () => 'csrf-proof', unauthorized: () => {},
    }
    expect(authenticatedInit({ method: 'GET' })?.headers).toBeUndefined()
    const headers = new Headers(authenticatedInit({ method: 'POST', headers: { accept: 'application/json' } })?.headers)
    expect(headers.get('x-dsh-csrf')).toBe('csrf-proof')
    expect(headers.get('accept')).toBe('application/json')
  })

  it('notifies the app gate on a 401 response', () => {
    const unauthorized = vi.fn()
    ;(globalThis as typeof globalThis & { __DSH_WEB_AUTH__?: unknown }).__DSH_WEB_AUTH__ = {
      csrfToken: () => undefined, unauthorized,
    }
    observeAuthResponse(new Response(null, { status: 401 }))
    expect(unauthorized).toHaveBeenCalledOnce()
  })
})
