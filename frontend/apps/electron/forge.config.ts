import type { ForgeConfig } from '@electron-forge/shared-types'
import { appIdentity } from './src/app-identity.ts'

const config: ForgeConfig = {
  packagerConfig: {
    asar: false,
    appBundleId: appIdentity.appBundleId,
    executableName: appIdentity.executableName,
    icon: appIdentity.iconPath,
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
