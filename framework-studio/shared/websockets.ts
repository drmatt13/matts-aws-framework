/**
 * The connection URLs the WebSockets page starts its two panels with when a launch
 * link names none: the same values Compose hands ws-tester. Both are endpoint URLs,
 * never credentials; an empty string leaves that panel blank.
 */
export interface WebSocketDefaults {
  /** local-ws-dev-server on its published host port, with an empty `?token=` to fill. */
  readonly local: string;
  /** The deployed API Gateway WebSocket stage, once an export has recorded one. */
  readonly apiGateway: string;
}
