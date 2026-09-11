/** Electron profile overlay composition without the Web transport rows. */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import ClientModuleRegistry from '@deepseek-ai/dsh-client-modules'
import { assertEntriesActivated, composeEntries, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { describe, expect, it } from 'vitest'

const BASE_PATCH = fileURLToPath(new URL('../../../packages/bundle/base/cordis.patch.yml', import.meta.url))
const WEB_PATCH = fileURLToPath(new URL('../../../packages/bundle/web-app/cordis.patch.yml', import.meta.url))
const ELECTRON_PATCH = fileURLToPath(new URL('../electron.patch.yml', import.meta.url))
const ELECTRON_MANIFEST = fileURLToPath(new URL('../package.json', import.meta.url))

function composedRows() {
  return composeEntries([[
    ...loadOverlayPatches('dsh-electron-test', BASE_PATCH),
    ...loadOverlayPatches('dsh-electron-test', WEB_PATCH),
    ...loadOverlayPatches('dsh-electron-test', ELECTRON_PATCH),
  ]])
}

describe('Electron profile overlay', () => {
  it('pins the native directory-picker interaction without a Web server', () => {
    const rows = composedRows()
    const byId = new Map(rows.map(row => [row.id, row]))

    expect(byId.get('directory-picker')).toEqual(expect.objectContaining({ disabled: true }))
    expect(byId.get('deployment-capabilities')).toEqual(expect.objectContaining({
      inject: null,
      config: { surface: 'electron' },
    }))
    expect(byId.get('directory-picker-native')).toEqual(expect.objectContaining({
      name: '@deepseek-ai/dsh-host-directory-picker-native',
    }))
    expect(byId.get('ui-directory-picker-native')).toEqual(expect.objectContaining({
      name: '@deepseek-ai/dsh-client-ui-directory-picker-native',
    }))
  })

  it('removes every Web-only authentication dependency from the Electron module carrier', () => {
    const byId = new Map(composedRows().map(row => [row.id, row]))

    expect(byId.get('web-auth')).toEqual(expect.objectContaining({ disabled: true }))
    expect(byId.get('client-hmr')).toEqual(expect.objectContaining({ disabled: true }))
    expect(byId.get('modules')).toEqual(expect.objectContaining({
      inject: null,
      config: {
        additionalPackages: ['@deepseek-ai/dsh-client-connection'],
        requireWebAuth: false,
      },
    }))
    expect(byId.get('modules')?.config).not.toHaveProperty('trustedHosts')
    expect(byId.get('modules')?.config).not.toHaveProperty('trustedProxyAddresses')
  })

  it('activates the real clientModules service without Web services and passes the startup audit', async () => {
    const rows = composedRows().filter(row => [
      'web-startup', 'webserver', 'web-runtime', 'web-auth', 'client-hmr', 'modules',
    ].includes(row.id))
    const ctx = new Context()
    ctx.baseUrl = new URL('../', import.meta.url).href
    await ctx.plugin(Loader)
    ctx.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (specifier === '@deepseek-ai/dsh-client-modules') return ClientModuleRegistry
        throw new Error(`disabled Electron row was imported: ${specifier}`)
      },
    } as unknown as NonNullable<typeof ctx.loader.internal>
    const starts = rows.map(row => ctx.loader.create(row))
    try {
      await ctx.loader.await()
      await assertEntriesActivated(ctx, 'dsh-electron-test')
      expect(ctx.clientModules).toBeInstanceOf(ClientModuleRegistry)
    } finally {
      await ctx.fiber.dispose()
      await Promise.allSettled(starts)
    }
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
