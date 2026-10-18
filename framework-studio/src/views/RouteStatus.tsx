import { LockKeyhole } from "lucide-react";
import type { ModelRoute } from "../../shared/model";

const CONFIG_SECTIONS: Readonly<Record<ModelRoute["kind"], string>> = {
  http: "http",
  service: "services",
  webSocket: "websocket",
  agent: "agents",
};

/** Gateway routes are derived from their workload section, rather than authored resources. */
export function RouteStatus({ route }: { readonly route: ModelRoute }) {
  return <p className="resource-status managed"><LockKeyhole size={14} aria-hidden />Managed by framework-config/{CONFIG_SECTIONS[route.kind]}</p>;
}
