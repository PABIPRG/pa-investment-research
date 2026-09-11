/** Compatibility export for the browser trust boundary now shared by auth routes. */
export {
  authorizeProtectedWebRequest,
  assertTrustedAuthority,
  assertTrustedProxyAddress,
  isLoopbackRequestPeer,
  isTrustedApiRequest,
  isTrustedForwardedHttps,
  requestClientAddress,
  type ProtectedWebRequestAuthorizationDecision,
  type WebRequestAuthorizer,
  type WebRequestAuthorizationDecision,
  type WebRequestLifecycleResource,
} from '@deepseek-ai/dsh-host-webserver'
