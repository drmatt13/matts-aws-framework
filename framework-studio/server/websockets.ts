import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import type { WebSocketDefaults } from "../shared/websockets";

/**
 * The WebSockets page's starting URLs, exactly as docker-compose.yml gives them to
 * ws-tester:
 *
 *   VITE_LOCAL_WS_URL: 'ws://localhost:${LOCAL_WS_DEV_SERVER_HOST_PORT}?token='
 *   VITE_API_GATEWAY_WS_URL: ${VITE_API_GATEWAY_WS_URL:-}
 *
 * Compose interpolates both from the root .env that the export writes. Only those
 * two keys are read; nothing else in the file reaches the response.
 */
export function webSocketDefaults(repositoryRoot: string): WebSocketDefaults {
  const file = path.join(repositoryRoot, ".env");
  const values = existsSync(file) ? parseEnv(readFileSync(file, "utf8")) : {};
  const port = values.LOCAL_WS_DEV_SERVER_HOST_PORT?.trim();
  return {
    local: port && /^[1-9][0-9]*$/.test(port) ? `ws://localhost:${port}?token=` : "",
    apiGateway: values.VITE_API_GATEWAY_WS_URL?.trim() ?? "",
  };
}
