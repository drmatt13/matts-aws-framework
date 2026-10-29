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
  return <p className={"flex w-fit items-center gap-[6px] rounded-[5px] border border-current px-[7px] py-1 text-meta leading-[1.4] text-dev bg-[#6699bb10]"} data-slot="resource-status" data-resource-status="managed"><LockKeyhole size={14} aria-hidden />Managed by framework-config/{CONFIG_SECTIONS[route.kind]}</p>;
}
