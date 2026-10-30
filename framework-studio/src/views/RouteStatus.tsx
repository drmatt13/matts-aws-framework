import { FrameworkManagedStatus } from "./ResourceStatus";
import type { ModelRoute } from "../../shared/model";

/** Gateway routes are derived from their workload section, rather than authored resources. */
export function RouteStatus({ route }: { readonly route: ModelRoute }) {
  return <FrameworkManagedStatus title={`Routing generated from ${route.origin}`} />;
}
