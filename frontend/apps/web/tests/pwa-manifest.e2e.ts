import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { inflateSync } from 'node:zlib'
import { expect, it } from 'vitest'

const DIST_ROOT = fileURLToPath(new URL('../dist', import.meta.url))

function decodeGeneratedPng(png: Buffer): { data: Buffer; height: number; width: number } {
  const idat: Buffer[] = []
  let width = 0
  let height = 0
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset)
    const type = png.toString('ascii', offset + 4, offset + 8)
    const data = png.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
    } else if (type === 'IDAT') idat.push(data)
    offset += 12 + length
  }
  const scanlines = inflateSync(Buffer.concat(idat))
  const stride = width * 4
  const pixels = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y += 1) {
    expect(scanlines[y * (stride + 1)]).toBe(0)
    scanlines.copy(pixels, y * stride, y * (stride + 1) + 1, (y + 1) * (stride + 1))
  }
  return { data: pixels, height, width }
}

function alphaAt(image: { data: Buffer; width: number }, x: number, y: number): number {
  return image.data.readUInt8((y * image.width + x) * 4 + 3)
}

function assertMaskableSafeZone(image: { data: Buffer; height: number; width: number }): void {
  const center = image.width / 2
  const radius = image.width * 0.4
  let whitePixels = 0
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const offset = (y * image.width + x) * 4
      if (image.data.readUInt8(offset + 3) >= 240
        && image.data.readUInt8(offset) >= 240
        && image.data.readUInt8(offset + 1) >= 240
        && image.data.readUInt8(offset + 2) >= 240) {
        whitePixels += 1
        expect(Math.hypot(x + 0.5 - center, y + 0.5 - center)).toBeLessThanOrEqual(radius)
      }
    }
  }
  expect(whitePixels).toBeGreaterThan(0)
}

function decodeIco(ico: Buffer): readonly { png: Buffer; size: number }[] {
  const count = ico.readUInt16LE(4)
  return Array.from({ length: count }, (_, index) => {
    const entry = 6 + index * 16
    const size = ico.readUInt8(entry) || 256
    const length = ico.readUInt32LE(entry + 8)
    const offset = ico.readUInt32LE(entry + 12)
    return { png: ico.subarray(offset, offset + length), size }
  })
}

it('ships install metadata with the built web application', async () => {
  const index = await readFile(join(DIST_ROOT, 'index.html'), 'utf8')
  expect(index).toContain('<link rel="manifest" href="/manifest.webmanifest" />')

  const manifest: unknown = JSON.parse(await readFile(join(DIST_ROOT, 'manifest.webmanifest'), 'utf8'))
  expect(manifest).toEqual({
    id: '/',
    name: '投研智能体',
    short_name: '投研智能体',
    start_url: '/',
    scope: '/',
    display: 'fullscreen',
    icons: [
      ...[192, 512].map(size => ({
        src: `/icons/app-icon-001/icon-${size}.png`,
        sizes: `${size}x${size}`,
        type: 'image/png',
        purpose: 'any',
      })),
      ...[192, 512].map(size => ({
        src: `/icons/app-icon-001/icon-maskable-${size}.png`,
        sizes: `${size}x${size}`,
        type: 'image/png',
        purpose: 'maskable',
      })),
    ],
  })
})

it('ships platform-adapted browser, Apple touch, and install resources', async () => {
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
    ['icon-maskable-192.png', 192],
    ['icon-maskable-512.png', 512],
  ] as const) {
    const png = await readFile(join(DIST_ROOT, 'icons/app-icon-001', name))
    const image = decodeGeneratedPng(png)
    expect([image.width, image.height]).toEqual([size, size])
    if (name === 'apple-touch-icon.png' || name.includes('maskable')) {
      expect(alphaAt(image, 0, 0)).toBe(255)
    } else {
      expect(alphaAt(image, 0, 0)).toBeLessThan(16)
      expect(alphaAt(image, size - 1, size - 1)).toBeLessThan(16)
    }
    if (name.includes('maskable')) assertMaskableSafeZone(image)
  }
  const iconRoot = join(DIST_ROOT, 'icons/app-icon-001')
  await expect(readFile(join(iconRoot, 'icon-192.png')))
    .resolves.not.toEqual(await readFile(join(iconRoot, 'icon-maskable-192.png')))
  const ico = await readFile(join(DIST_ROOT, 'icons/app-icon-001/favicon.ico'))
  const frames = decodeIco(ico)
  expect(frames.map(frame => frame.size)).toEqual([16, 32, 48])
  for (const frame of frames) expect(alphaAt(decodeGeneratedPng(frame.png), 0, 0)).toBeLessThan(16)
})
