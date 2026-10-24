import { useQuery } from "@tanstack/react-query";
import { api } from "../../api";
import { LAUNCH_URL_PARAMS, connectionUrlWithToken, consumeLaunchToken, launchConnectionUrl } from "../../websockets/launch";
import { WebSocketTester } from "./WebSocketTester";
import "./websockets.css";

/**
 * Two WebSocket panels side by side, as ws-tester shows them: local-ws-dev-server on
 * the left, the deployed API Gateway stage on the right.
 *
 * Both accept ws-tester's launch link. The token in its fragment is taken and cleared
 * from the address bar as soon as this page loads; the URLs it names are read then too,
 * before anything navigates. Opened directly, each panel starts from the URL Compose
 * gives ws-tester.
 */

const launchToken = consumeLaunchToken();
// Without a fallback these are the launch link's own URLs, or empty when it names none.
const launchLocal = launchConnectionUrl(LAUNCH_URL_PARAMS.local, undefined);
const launchApiGateway = launchConnectionUrl(LAUNCH_URL_PARAMS.apiGateway, undefined);

export function WebSockets() {
  const defaults = useQuery({ queryKey: ["websocket-defaults"], queryFn: api.webSocketDefaults, staleTime: Number.POSITIVE_INFINITY, retry: false });
  const heading = (
    <div className="workspace-toolbar websockets-head">
      <h1 className="workspace-page-title">WebSockets</h1>
      <p className="context-label">Each panel connects from this browser. A launch link from client-app adds your session token to both URLs.</p>
    </div>
  );
  if (defaults.isPending) return <div className="websockets-workspace">{heading}<p className="empty" role="status">Reading the local WebSocket settings…</p></div>;
  const fallback = defaults.data ?? { local: "", apiGateway: "" };
  const localWsUrl = connectionUrlWithToken(launchLocal || fallback.local.trim(), launchToken);
  const apiGatewayWsUrl = connectionUrlWithToken(launchApiGateway || fallback.apiGateway.trim(), launchToken);
  return (
    <div className="websockets-workspace">
      {heading}
      {defaults.error ? <div className="workspace-alert websockets-alert" role="alert"><span>The WebSocket defaults could not be read: {defaults.error.message}. Enter a URL to connect.</span></div> : null}
      <div className="websockets-panels">
        <WebSocketTester title="Local" description="local-ws-dev-server under Compose" initialConnectionURL={localWsUrl} />
        <div className="websockets-divider" aria-hidden />
        <WebSocketTester title="AWS" description="The deployed API Gateway WebSocket stage" initialConnectionURL={apiGatewayWsUrl} />
      </div>
    </div>
  );
}
