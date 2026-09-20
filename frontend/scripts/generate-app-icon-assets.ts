/** Generate platform-adapted APP-ICON-001 assets from the canonical square master. */

import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  applyRoundedPlate,
  assertMaskableSafeZone,
  decodePng,
  encodeIco,
  encodePng,
  resizeSquare,
} from './app-icon-assets.ts'

const FRONTEND_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const MASTER_PATH = resolve(FRONTEND_ROOT, 'apps/electron/assets/app-icon.png')
const WEB_ICON_ROOT = resolve(FRONTEND_ROOT, 'apps/web/public/icons/app-icon-001')
const MASTER_SHA256 = 'c4e2af6eaa468f8b3f2cf31d1694356b62297bc49c3f918fb5afeb63e3c6e1bb'
const WINDOWS_SIZES = [16, 24, 32, 48, 64, 128, 256] as const
const FAVICON_SIZES = [16, 32, 48] as const
const PWA_SIZES = [192, 512] as const

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Build every non-Apple derivative while preserving the square Apple master. */
export async function buildAppIconAssets(): Promise<ReadonlyMap<string, Buffer>> {
  const masterBytes = await readFile(MASTER_PATH)
  if (sha256(masterBytes) !== MASTER_SHA256) {
    throw new TypeError('APP-ICON-001 master changed; review the source and update its recorded SHA-256')
  }
  const master = decodePng(masterBytes)
  if (master.width !== 1024 || master.height !== 1024) {
    throw new TypeError('APP-ICON-001 master must remain a 1024x1024 square')
  }

  const assets = new Map<string, Buffer>()
  const roundedPng = (size: number): Buffer => encodePng(applyRoundedPlate(resizeSquare(master, size)))
  const windowsFrames = WINDOWS_SIZES.map(size => ({ png: roundedPng(size), size }))
  assets.set(resolve(FRONTEND_ROOT, 'apps/electron/assets/app-icon.ico'), encodeIco(windowsFrames))

  const faviconFrames = FAVICON_SIZES.map(size => ({ png: roundedPng(size), size }))
  for (const frame of faviconFrames) {
    assets.set(resolve(WEB_ICON_ROOT, `favicon-${frame.size}x${frame.size}.png`), frame.png)
  }
  assets.set(resolve(WEB_ICON_ROOT, 'favicon.ico'), encodeIco(faviconFrames))

  const appleTouch = resizeSquare(master, 180)
  assets.set(resolve(WEB_ICON_ROOT, 'apple-touch-icon.png'), encodePng(appleTouch))
  for (const size of PWA_SIZES) {
    assets.set(resolve(WEB_ICON_ROOT, `icon-${size}.png`), roundedPng(size))
    const maskable = resizeSquare(master, size)
    assertMaskableSafeZone(maskable)
    assets.set(resolve(WEB_ICON_ROOT, `icon-maskable-${size}.png`), encodePng(maskable))
  }
  return assets
}

async function main(): Promise<void> {
  const check = process.argv.includes('--check')
  const assets = await buildAppIconAssets()
  const stale: string[] = []
  for (const [path, expected] of assets) {
    if (check) {
      const actual = await readFile(path).catch(() => undefined)
      if (actual === undefined || !actual.equals(expected)) stale.push(relative(FRONTEND_ROOT, path))
    } else {
      await writeFile(path, expected)
    }
  }
  if (stale.length > 0) {
    throw new TypeError(`Generated app icon assets are stale:\n${stale.join('\n')}`)
  }
  console.log(check ? `Verified ${assets.size} app icon assets.` : `Generated ${assets.size} app icon assets.`)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
