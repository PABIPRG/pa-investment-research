import { clientBundle } from '../tsdown.client.ts'

export default clientBundle(
  '@deepseek-ai/dsh-client-ui-desktop-shortcuts',
  ['lib/types/index.js', 'lib/types/invariant.js'],
  { hostPhase: true },
)
