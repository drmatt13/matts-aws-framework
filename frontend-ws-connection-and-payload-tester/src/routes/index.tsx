import WS_ConnectionAndPayloadTester from "../components/WS_ConnectionAndPayloadTester";

import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({ component: App });

function App() {
  const localWsUrl = import.meta.env.VITE_LOCAL_WS_URL as string;
  const apiGatewayWsUrl = import.meta.env.VITE_API_GATEWAY_WS_URL as string;

  return (
    <div className="flex justify-center">
      <div className="flex justify-center h-dvh w-full max-w-3xl overflow-hidden">
        <div className="py-6 w-1/2 min-w-0 overflow-hidden flex">
          <WS_ConnectionAndPayloadTester initialConnectionURL={localWsUrl} />
        </div>

        <div className="w-10 flex justify-center">
          <div className="h-full w-px shrink-0 flex items-center">
            <div className="h-[85%] w-full bg-linear-to-b from-black/0 via-white/15 to-black/0" />
          </div>
        </div>

        <div className="py-6 w-1/2 min-w-0 overflow-hidden flex">
          <WS_ConnectionAndPayloadTester
            initialConnectionURL={apiGatewayWsUrl}
          />
        </div>
      </div>
    </div>
  );
}
