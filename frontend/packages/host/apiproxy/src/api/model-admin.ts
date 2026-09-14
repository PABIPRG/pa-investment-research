/** Model-only administrator operations; generic settings and credentials remain host-local. */
import type { SettingsApi } from './settings.ts'
import type { CredentialsApi } from './credentials.ts'
import type { LlmApi } from './llm.ts'

/** Restricted model configuration over the existing persistence owners. */
export interface ModelAdminApi {
  describe: SettingsApi['describe']
  mutate: SettingsApi['mutate']
  describeCredentials: CredentialsApi['describe']
  setCredential: CredentialsApi['set']
  unsetCredential: CredentialsApi['unset']
  discoverModels: LlmApi['discoverModels']
}
