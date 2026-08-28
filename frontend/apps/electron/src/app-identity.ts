/** Read the desktop application's product identity from its package manifest. */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

interface ElectronPackageManifest {
  desktopIdentity?: {
    appBundleId?: string
    icon?: string
    runtimeIcon?: string
  }
  productName?: string
}

export const electronAppDir = dirname(dirname(fileURLToPath(import.meta.url)))
const manifest = JSON.parse(
  readFileSync(resolve(electronAppDir, 'package.json'), 'utf8'),
) as ElectronPackageManifest

function required(value: string | undefined, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`Electron package manifest is missing ${field}`)
  }
  return value
}

const productName = required(manifest.productName, 'productName')

export const appIdentity = Object.freeze({
  appBundleId: required(manifest.desktopIdentity?.appBundleId, 'desktopIdentity.appBundleId'),
  executableName: productName,
  iconPath: resolve(electronAppDir, required(manifest.desktopIdentity?.icon, 'desktopIdentity.icon')),
  name: productName,
  runtimeIconPath: resolve(
    electronAppDir,
    required(manifest.desktopIdentity?.runtimeIcon, 'desktopIdentity.runtimeIcon'),
  ),
})
