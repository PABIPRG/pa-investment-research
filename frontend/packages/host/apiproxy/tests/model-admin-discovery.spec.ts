import { describe, expect, it } from 'vitest'
import { isPublicModelAddress, modelEndpoint, discoverPublicModels } from '../src/model-admin-discovery.ts'

describe('remote discovery destinations', () => {
  it.each(['127.0.0.1', '10.0.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.1', '100.64.0.1', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', '2002:7f00:1::', '2001:db8::1'])('refuses non-public address %s', address => {
    expect(isPublicModelAddress(address)).toBe(false)
  })
  it.each(['http://example.com', 'https://user:secret@example.com', 'https://example.com?key=secret', 'https://127.1', 'https://[::1]', 'https://localhost'])('refuses unsafe URL %s', value => {
    expect(() => modelEndpoint(value)).toThrow()
  })
  it('accepts public addresses and preserves a gateway prefix', () => {
    expect(isPublicModelAddress('8.8.8.8')).toBe(true)
    expect(isPublicModelAddress('2606:4700:4700::1111')).toBe(true)
    expect(modelEndpoint('https://example.com/openai/v1').pathname).toBe('/openai/v1')
  })
  it('rejects a private target before network I/O', async () => {
    await expect(discoverPublicModels('https://127.0.0.1', undefined)).rejects.toThrow()
  })
})
