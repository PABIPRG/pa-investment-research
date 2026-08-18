import type { ForgeConfig } from '@electron-forge/shared-types'

const config: ForgeConfig = {
  packagerConfig: {
    asar: false,
    appBundleId: 'com.deepseek.harness',
    executableName: 'deepseek-harness',
    ignore: [
      /^\/(?:src|tests|out|lib\/types)(?:\/|$)/,
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
