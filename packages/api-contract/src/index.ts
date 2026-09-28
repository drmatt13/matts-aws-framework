import {
  AUTHENTICATED_API_ROUTES,
  PUBLIC_API_ROUTES,
  WEBSOCKET_ROUTES,
} from "./generated/framework-routes";

/**
 * The browser's half of the framework contract.
 *
 * Everything here comes from a generated projection of `framework.config.ts`
 * rather than from the config itself: the routing table is public, while cloud
 * environment declarations, secret identifiers and build settings are not, and
 * none of them mean anything in a bundle. `npm run framework:check` fails when
 * the projection drifts from the config it was generated from.
 */

/**
 * Public path -> the URL to call, keyed by the route as `framework.config.ts`
 * declares it. A catch-all mount resolves to its public prefix, so
 * `API_ROUTE["/langgraph/*"]` is `"/langgraph"`. Looking a route up by its own
 * path keeps the typo checking while staying unambiguous when several routes
 * share one target.
 */
export {
  API_ROUTE,
  AUTHENTICATED_API_ROUTES,
  PUBLIC_API_ROUTES,
} from "./generated/framework-routes";

export const API_ROUTES = [
  ...PUBLIC_API_ROUTES,
  ...AUTHENTICATED_API_ROUTES,
] as const;

export type PublicApiRoute = (typeof PUBLIC_API_ROUTES)[number];
export type AuthenticatedApiRoute = (typeof AUTHENTICATED_API_ROUTES)[number];
export type ApiRoute = (typeof API_ROUTES)[number];

export type WebSocketRoute = (typeof WEBSOCKET_ROUTES)[number];
export type WebSocketAction = Exclude<
  WebSocketRoute,
  "$connect" | "$disconnect" | "$default"
>;

/**
 * Payload contracts, projected one generated module per target.
 *
 * `frameworkContracts` says which targets declare one. Each contract is also
 * bound as its own namespace — `lambdaSignIn.contract` — because the documented
 * standard export is named `contract` in every contract module, and a flat
 * surface can hold only one of them. The uniquely named schemas and types are
 * re-exported flat as well, so existing imports keep working.
 *
 * Nothing here reaches across the repository: the authored contract lives
 * beside its handler and is copied in whole, Zod schemas included, by
 * `npm run framework:generate`.
 */
export * from "./generated/framework-contracts";
