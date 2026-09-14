/** Adapt the model editors to the restricted remote administrator namespace. */
import type { IApiClient } from '@deepseek-ai/dsh-api-remotes/client'

/** Preserve the editor contracts while sending model-admin RPCs remotely.
 * @param api - Connection-owned RPC client.
 * @returns The model editor API.
 */
export function modelAdminApi(api: IApiClient): Pick<IApiClient, 'settings' | 'credentials' | 'llm'> {
  return {
    settings: { ...api.settings, describe: api.modelAdmin.describe, mutate: api.modelAdmin.mutate },
    credentials: { describe: api.modelAdmin.describeCredentials, set: api.modelAdmin.setCredential, unset: api.modelAdmin.unsetCredential },
    llm: { ...api.llm, discoverModels: api.modelAdmin.discoverModels },
  }
}
