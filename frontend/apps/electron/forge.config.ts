import type { ForgeConfig } from '@electron-forge/shared-types'
import { appIdentity, packagerIconPath } from './src/app-identity.ts'

const config: ForgeConfig = {
  packagerConfig: {
    asar: false,
    appBundleId: appIdentity.appBundleId,
    executableName: appIdentity.executableName,
    icon: packagerIconPath(process.platform),
    ignore: [
      /^\/(?:src|tests|out|lib\/types|\.cache|investment-python)(?:\/|$)/,
    ],
  },
  makers: [
    {
      name: '@electron-forge/maker-zip',
      config: {},
    },
  ],
}

export default config
