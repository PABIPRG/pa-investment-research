import { describe, expect, it } from 'vitest'
import {
  assertTrustedOrigin,
  isTrustedPublicReadRequest,
} from '../src/request-trust.ts'

function request(
  method: string,
  headers: Record<string, string | undefined>,
  remoteAddress = '127.0.0.1',
) {
  return { method, headers, socket: { remoteAddress } }
}

const PUBLIC_ORIGIN = 'https://pair-observe.xiexin.dev'

describe('isTrustedPublicReadRequest', () => {
  it('allows only GET and HEAD from the exact configured browser origin', () => {
    for (const method of ['GET', 'HEAD']) {
      expect(isTrustedPublicReadRequest(
        request(method, {
          host: 'pair-api.xiexin.dev',
          origin: PUBLIC_ORIGIN,
          'sec-fetch-site': 'cross-site',
        }, '10.0.0.8'),
        ['pair-api.xiexin.dev'],
        [PUBLIC_ORIGIN],
      )).toBe(true)
    }
    expect(isTrustedPublicReadRequest(
      request('POST', { host: 'pair-api.xiexin.dev', origin: PUBLIC_ORIGIN }, '10.0.0.8'),
      ['pair-api.xiexin.dev'],
      [PUBLIC_ORIGIN],
    )).toBe(false)
  })

  it('rejects origin aliases and untrusted Host authorities', () => {
    for (const origin of [
      'https://www.pair-observe.xiexin.dev',
      'http://pair-observe.xiexin.dev',
      'https://pair-observe.xiexin.dev.evil.example',
      'null',
    ]) {
      expect(isTrustedPublicReadRequest(
        request('GET', { host: 'pair-api.xiexin.dev', origin }, '10.0.0.8'),
        ['pair-api.xiexin.dev'],
        [PUBLIC_ORIGIN],
      )).toBe(false)
    }
    expect(isTrustedPublicReadRequest(
      request('GET', { host: 'evil.example', origin: PUBLIC_ORIGIN }, '10.0.0.8'),
      ['pair-api.xiexin.dev'],
      [PUBLIC_ORIGIN],
    )).toBe(false)
  })

  it('accepts origin-less public reads but fails closed without an origin allowlist', () => {
    expect(isTrustedPublicReadRequest(
      request('GET', { host: 'pair-api.xiexin.dev' }, '10.0.0.8'),
      ['pair-api.xiexin.dev'],
      [PUBLIC_ORIGIN],
    )).toBe(true)
    expect(isTrustedPublicReadRequest(
      request('GET', { host: 'pair-api.xiexin.dev' }, '10.0.0.8'),
      ['pair-api.xiexin.dev'],
      [],
    )).toBe(false)
  })

  it('accepts only a GET or HEAD CORS preflight from the exact origin', () => {
    expect(isTrustedPublicReadRequest(
      request('OPTIONS', {
        host: 'pair-api.xiexin.dev',
        origin: PUBLIC_ORIGIN,
        'access-control-request-method': 'GET',
      }, '10.0.0.8'),
      ['pair-api.xiexin.dev'],
      [PUBLIC_ORIGIN],
    )).toBe(true)
    for (const preflightMethod of ['POST', 'DELETE', undefined]) {
      expect(isTrustedPublicReadRequest(
        request('OPTIONS', {
          host: 'pair-api.xiexin.dev',
          origin: PUBLIC_ORIGIN,
          'access-control-request-method': preflightMethod,
        }, '10.0.0.8'),
        ['pair-api.xiexin.dev'],
        [PUBLIC_ORIGIN],
      )).toBe(false)
    }
  })
})

describe('assertTrustedOrigin', () => {
  it('accepts canonical HTTPS origins and local development HTTP origins', () => {
    expect(() => { assertTrustedOrigin(PUBLIC_ORIGIN) }).not.toThrow()
    expect(() => { assertTrustedOrigin('http://localhost:3198') }).not.toThrow()
    expect(() => { assertTrustedOrigin('http://127.0.0.1:3198') }).not.toThrow()
  })

  it('rejects non-canonical, insecure public, and path-bearing origins', () => {
    for (const origin of [
      'http://pair-observe.xiexin.dev',
      'https://pair-observe.xiexin.dev/',
      'https://pair-observe.xiexin.dev/path',
      'https://PAIR-observe.xiexin.dev',
      'pair-observe.xiexin.dev',
      'null',
    ]) {
      expect(() => { assertTrustedOrigin(origin) }).toThrow(/canonical HTTPS origin/)
    }
  })
})
