/**
 * Stable public auth API. Keep implementation details in focused modules so
 * routes and data clients only depend on this facade.
 */
export {
  confirmForgotPasswordUser,
  confirmSignUpUser,
  forgotPasswordUser,
  resendConfirmationCodeUser,
  signUpUser,
} from "./auth/cognito-account";
export {
  completeOAuthSignIn,
  discoverOrgSso,
  isSsoProviderEnabled,
  signInWithOrgSso,
  signInWithProvider,
} from "./auth/oauth";
export type { OrgSsoDiscovery, SsoProviderId } from "./auth/oauth";
export {
  API_ROUTE,
  API_ROUTES,
  AuthServiceUnavailableError,
  SessionExpiredError,
  checkSession,
  consumeAuthNotice,
  consumePostAuthReturnTo,
  frameworkHttpApiFetch,
  getAuthSnapshot,
  getCognitoIdToken,
  initializeAuthLifecycle,
  invalidateAuthCache,
  isAuthServiceUnavailableError,
  isSessionExpiredError,
  prepareForReauthentication,
  redirectIfAuthenticated,
  refreshSession,
  requireAuth,
  respondToMfaChallenge,
  retryAuthSession,
  signInUser,
  subscribeAuthState,
  subscribeIdentityChange,
} from "./auth/session";
export type {
  ApiRoute,
  AuthSnapshot,
  AuthStatus,
  RefreshOutcome,
  SignInChallenge,
} from "./auth/session";
