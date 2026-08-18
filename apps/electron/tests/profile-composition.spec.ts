/** Electron profile overlay composition without the Web transport rows. */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { composeEntries, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { describe, expect, it } from 'vitest'

const BASE_PATCH = fileURLToPath(new URL('../../../packages/bundle/base/cordis.patch.yml', import.meta.url))
const WEB_PATCH = fileURLToPath(new URL('../../../packages/bundle/web-app/cordis.patch.yml', import.meta.url))
const ELECTRON_PATCH = fileURLToPath(new URL('../electron.patch.yml', import.meta.url))
const ELECTRON_MANIFEST = fileURLToPath(new URL('../package.json', import.meta.url))

describe('Electron profile overlay', () => {
  it('pins the native directory-picker interaction without a Web server', () => {
    const rows = composeEntries([[
      ...loadOverlayPatches('dsh-electron-test', BASE_PATCH),
      ...loadOverlayPatches('dsh-electron-test', WEB_PATCH),
      ...loadOverlayPatches('dsh-electron-test', ELECTRON_PATCH),
    ]])
    const byId = new Map(rows.map(row => [row.id, row]))

    expect(byId.get('directory-picker')).toEqual(expect.objectContaining({ disabled: true }))
    expect(byId.get('directory-picker-native')).toEqual(expect.objectContaining({
      name: '@deepseek-ai/dsh-host-directory-picker-native',
    }))
    expect(byId.get('ui-directory-picker-native')).toEqual(expect.objectContaining({
      name: '@deepseek-ai/dsh-client-ui-directory-picker-native',
    }))
  })

  it('declares the pinned interaction packages at the Electron resolution anchor', async () => {
    const manifest = JSON.parse(await readFile(ELECTRON_MANIFEST, 'utf8')) as {
      dependencies?: Record<string, unknown>
    }

    expect(
      manifest.dependencies?.['@deepseek-ai/dsh-host-directory-picker-native'],
    ).toBe('workspace:^')
    expect(
      manifest.dependencies?.['@deepseek-ai/dsh-client-ui-directory-picker-native'],
    ).toBe('workspace:^')
  })
})
