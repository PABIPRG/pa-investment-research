import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { expect, it } from 'vitest'

const DIST_ROOT = fileURLToPath(new URL('../dist', import.meta.url))

it('ships install metadata with the built web application', async () => {
  const index = await readFile(join(DIST_ROOT, 'index.html'), 'utf8')
  expect(index).toContain('<link rel="manifest" href="/manifest.webmanifest" />')

  const manifest: unknown = JSON.parse(await readFile(join(DIST_ROOT, 'manifest.webmanifest'), 'utf8'))
  expect(manifest).toEqual({
    id: '/',
    name: 'DeepSeek Harness',
    short_name: 'DSH',
    start_url: '/',
    scope: '/',
    display: 'fullscreen',
    icons: [192, 512].map(size => ({
      src: `/icons/app-icon-001/icon-${size}.png`,
      sizes: `${size}x${size}`,
      type: 'image/png',
      purpose: 'any',
    })),
  })
})

it('ships icon resources with the required dimensions for browser tabs, touch shortcuts and installation', async () => {
  const index = await readFile(join(DIST_ROOT, 'index.html'), 'utf8')
  expect(index).not.toContain('href="/favicon.svg"')
  expect(index).toContain('href="/icons/app-icon-001/favicon.ico"')
  expect(index).toContain('rel="apple-touch-icon" sizes="180x180"')
  for (const [name, size] of [
    ['favicon-16x16.png', 16],
    ['favicon-32x32.png', 32],
    ['favicon-48x48.png', 48],
    ['apple-touch-icon.png', 180],
    ['icon-192.png', 192],
    ['icon-512.png', 512],
  ] as const) {
    const png = await readFile(join(DIST_ROOT, 'icons/app-icon-001', name))
    expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    expect(png.readUInt32BE(16)).toBe(size)
    expect(png.readUInt32BE(20)).toBe(size)
  }
  const ico = await readFile(join(DIST_ROOT, 'icons/app-icon-001/favicon.ico'))
  expect(ico.readUInt16LE(0)).toBe(0)
  expect(ico.readUInt16LE(2)).toBe(1)
  expect(ico.readUInt16LE(4)).toBeGreaterThan(0)
})
