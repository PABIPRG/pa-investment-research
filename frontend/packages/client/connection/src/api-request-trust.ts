/** Compatibility export for the browser trust boundary now shared by auth routes. */
export {
  authorizeProtectedWebRequest,
  assertTrustedAuthority,
  assertTrustedProxyAddress,
  isLoopbackRequestPeer,
  isTrustedApiRequest,
  isTrustedForwardedHttps,
  requestClientAddress,
  type WebRequestAuthorizer,
  type WebRequestAuthorizationDecision,
} from '@deepseek-ai/dsh-host-webserver'
