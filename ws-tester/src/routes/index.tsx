import WebSocketTester from "../components/WebSocketTester";
import { connectionUrlWithToken, consumeLaunchToken } from "../lib/tokenHandoff";

import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({ component: App });

// A URL fragment is never sent with the HTTP request. Remove it as soon as this
// page loads so the Cognito token does not remain in the address bar or history.
const launchToken = consumeLaunchToken();

function App() {
  const localWsUrl = connectionUrlWithToken(import.meta.env.VITE_LOCAL_WS_URL as string, launchToken);
  const apiGatewayWsUrl = connectionUrlWithToken(import.meta.env.VITE_API_GATEWAY_WS_URL as string, launchToken);

  return (
    <div className="flex justify-center">
      <div className="flex justify-center h-dvh w-full max-w-3xl overflow-hidden">
        <div className="py-6 w-1/2 min-w-0 overflow-hidden flex">
          <WebSocketTester initialConnectionURL={localWsUrl} />
        </div>

        <div className="w-10 flex justify-center">
          <div className="h-full w-px shrink-0 flex items-center">
            <div className="h-[85%] w-full bg-linear-to-b from-black/0 via-white/15 to-black/0" />
          </div>
        </div>

        <div className="py-6 w-1/2 min-w-0 overflow-hidden flex">
          <WebSocketTester
            initialConnectionURL={apiGatewayWsUrl}
          />
        </div>
      </div>
    </div>
  );
}
