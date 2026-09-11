/** Compatibility export for the browser trust boundary now shared by auth routes. */
export {
  assertTrustedAuthority,
  assertTrustedProxyAddress,
  isLoopbackRequestPeer,
  isTrustedApiRequest,
  isTrustedForwardedHttps,
  requestClientAddress,
} from '@deepseek-ai/dsh-host-webserver'
