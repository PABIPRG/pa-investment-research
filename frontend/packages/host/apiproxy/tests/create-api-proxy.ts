import type { Context } from '@deepseek-ai/cordis'
import { deploymentCapabilitiesFor, type DeploymentCapabilitySnapshot } from '@deepseek-ai/dsh-host-deployment-capabilities'
import type { ApiProxy } from '../src/api/index.ts'
import { createApiProxy as createStrictApiProxy, type ApiProxyDefaults } from '../src/api-proxy.ts'

type TestApiProxyDefaults = Omit<ApiProxyDefaults, 'deploymentCapabilities'> & {
  deploymentCapabilities?: DeploymentCapabilitySnapshot
}

/** Test harness with an explicit local deployment policy unless a case overrides it. */
export function createApiProxy(ctx: Context, defaults: TestApiProxyDefaults): ApiProxy {
  return createStrictApiProxy(ctx, {
    deploymentCapabilities: deploymentCapabilitiesFor('cli'),
    ...defaults,
  })
}
