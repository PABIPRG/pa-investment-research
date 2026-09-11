import { describe, expect, it } from 'vitest'
import { deploymentCapabilitiesFor } from '../src/index.ts'

describe('deploymentCapabilitiesFor', () => {
  it('keeps cloud Web browser transfer but rejects host and broker capabilities', () => {
    expect(deploymentCapabilitiesFor('cloud-web', 'darwin')).toEqual({
      surface: 'cloud-web', browserFileTransfer: true, hostDirectories: false,
      openHostPath: false, brokerSync: false, nativeHoldings: false,
      holdingsProviders: ['manual'],
    })
  })

  it('declares local Web and Electron from the Host platform', () => {
    expect(deploymentCapabilitiesFor('local-web', 'win32').holdingsProviders).toEqual(['manual', 'easytrader', 'qmt'])
    expect(deploymentCapabilitiesFor('electron', 'darwin')).toMatchObject({
      hostDirectories: true, openHostPath: true, brokerSync: true, nativeHoldings: true,
      holdingsProviders: ['manual', 'mac_ths'],
    })
  })
})
