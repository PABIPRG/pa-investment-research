/** Host-owned deployment policy. Browser inputs never select this surface. */
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

export type DeploymentSurface = 'cli' | 'local-web' | 'electron' | 'cloud-web'
export type HoldingsProvider = 'manual' | 'easytrader' | 'mac_ths' | 'qmt'

/** Immutable, JSON-safe deployment facts safe to expose to authenticated clients. */
export interface DeploymentCapabilitySnapshot {
  readonly surface: DeploymentSurface
  readonly browserFileTransfer: boolean
  readonly hostDirectories: boolean
  readonly openHostPath: boolean
  readonly brokerSync: boolean
  readonly nativeHoldings: boolean
  readonly holdingsProviders: readonly HoldingsProvider[]
}

export interface Config {
  /** Host-owned deployment classification fixed during process composition. */
  surface?: DeploymentSurface
}

function platformProviders(platform: NodeJS.Platform): readonly HoldingsProvider[] {
  if (platform === 'darwin') return ['manual', 'mac_ths']
  if (platform === 'win32') return ['manual', 'easytrader', 'qmt']
  return ['manual']
}

/** Convert an explicitly configured surface into the complete enforcement snapshot. */
export function deploymentCapabilitiesFor(
  surface: DeploymentSurface,
  platform: NodeJS.Platform = process.platform,
): DeploymentCapabilitySnapshot {
  const cloud = surface === 'cloud-web'
  const web = surface === 'local-web' || cloud || surface === 'electron'
  return Object.freeze({
    surface,
    browserFileTransfer: web,
    hostDirectories: !cloud,
    openHostPath: !cloud,
    brokerSync: !cloud,
    nativeHoldings: surface === 'electron',
    holdingsProviders: Object.freeze<HoldingsProvider[]>(cloud ? ['manual'] : [...platformProviders(platform)]),
  })
}

declare module '@deepseek-ai/cordis' {
  interface Context { deploymentCapabilities: DeploymentCapabilities }
}

/** Single process-lifetime source of deployment capability truth. */
export class DeploymentCapabilities extends Service {
  static Config: z<Config> = z.object({
    surface: z.union(['cli', 'local-web', 'electron', 'cloud-web']).default('cli'),
  })
  private readonly value: DeploymentCapabilitySnapshot

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'deploymentCapabilities')
    this.value = deploymentCapabilitiesFor(config.surface ?? 'cli')
  }

  /**
   * Return the process-lifetime, immutable, client-safe capability snapshot.
   * @returns The deployment capabilities fixed for the lifetime of this process.
   */
  snapshot(): DeploymentCapabilitySnapshot { return this.value }
}

export default DeploymentCapabilities
