import { useQuery } from "@tanstack/react-query";
import { api } from "../../api";
import { LAUNCH_URL_PARAMS, connectionUrlWithToken, consumeLaunchToken, launchConnectionUrl } from "../../websockets/launch";
import { WebSocketTester } from "./WebSocketTester";
import { noticeClasses, workspaceToolbarClasses } from "../../ui/Surface";
import { cx } from "../../ui/classes";

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
    <div className={cx(workspaceToolbarClasses, "flex flex-wrap items-center gap-x-4 gap-y-1")}>
      <h1 className="m-0 font-sans text-step1 font-semibold leading-[1.3]">WebSockets</h1>
      <p className="m-0 text-caption font-normal text-graphite">Each panel connects from this browser. A launch link from client-app adds your session token to both URLs.</p>
    </div>
  );
  if (defaults.isPending) return <div className="flex h-full min-h-0 flex-col">{heading}<p className="px-6 py-20 text-center text-graphite" role="status">Reading the local WebSocket settings…</p></div>;
  const fallback = defaults.data ?? { local: "", apiGateway: "" };
  const localWsUrl = connectionUrlWithToken(launchLocal || fallback.local.trim(), launchToken);
  const apiGatewayWsUrl = connectionUrlWithToken(launchApiGateway || fallback.apiGateway.trim(), launchToken);
  return (
    <div className="flex h-full min-h-0 flex-col">
      {heading}
      {defaults.error ? <div className={noticeClasses({ className: "mx-4 mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 [&>span]:min-w-0 [&>span]:flex-[1_1_280px]" })} role="alert"><span>The WebSocket defaults could not be read: {defaults.error.message}. Enter a URL to connect.</span></div> : null}
      <div className="mx-auto flex min-h-0 w-full max-w-[1280px] flex-1 px-4 py-6 vp-760:flex-col vp-760:gap-6 vp-760:overflow-y-auto">
        <WebSocketTester title="Local" description="local-ws-dev-server under Compose" initialConnectionURL={localWsUrl} />
        <div className="flex flex-[0_0_41px] justify-center before:h-[85%] before:w-px before:self-center before:bg-[linear-gradient(to_bottom,transparent,var(--rule-strong),transparent)] before:content-[''] vp-760:hidden" aria-hidden />
        <WebSocketTester title="AWS" description="The deployed API Gateway WebSocket stage" initialConnectionURL={apiGatewayWsUrl} />
      </div>
    </div>
  );
}
